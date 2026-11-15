import { createGoogle } from "@ai-sdk/google";
import { logger, webhooks } from "@trigger.dev/sdk";
import { chat, defaultStorage } from "@trigger.dev/sdk/ai";
import { stepCountIs, type UIMessage } from "ai";
import { buildSystemPrompt } from "../assistant-prompt.js";
import {
  computerContext,
  computerTools,
  readSandboxFile,
  releaseAllSandboxes,
  releaseUserSandbox,
  type SentFile,
} from "../computer-tools.js";
import {
  callTelegram,
  downloadTelegramFile,
  sendTelegramDocument,
  GATEWAY_SIGNATURE_HEADER,
  telegramAttachments,
  TELEGRAM_MAX_CAPTION,
  type LinkedTelegramUpdate,
  type TelegramAttachment,
  type TelegramMessage,
} from "../telegram.js";
import { webTools } from "../web-tools.js";

// Cheapest current Gemini text model.
const MODEL_ID = "gemini-3.5-flash-lite";

// Model steps per turn: each tool round-trip is one step, the final answer is another.
// File work (open the file, inspect it, write a script, run it, fix it, check it, send it) needs room.
const MAX_STEPS = 20;

// Telegram's hard cap on a message's text length.
const TELEGRAM_MAX_TEXT = 4096;

// Files the model reads directly (Gemini accepts these inline). Anything else, and anything larger,
// is still listed in the message and can be opened on the computer with openAttachment.
const MODEL_READABLE = /^(image\/(png|jpeg|webp|heic|heif)|application\/pdf|audio\/(ogg|mpeg|mp3|wav|x-wav|aac|flac)|text\/(plain|csv|markdown|html))$/;
const MODEL_MAX_FILE_BYTES = 15 * 1024 * 1024;

// File parts need an https URL that the channel's download() resolves. This host never resolves
// (.invalid is reserved), so the bot token stays out of the transcript and the URL is only ever
// read through download().
const FILE_URL_HOST = "telegram-file.invalid";

/** Custom UI part that records a message's attachments (dropped when converted for the model). */
type AttachmentsPart = { type: "data-telegram-attachments"; data: TelegramAttachment[] };

function requireEnv(name: "TELEGRAM_BOT_TOKEN" | "GEMINI_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the Trigger.dev environment`);
  return value;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `, ${bytes} B`;
  if (bytes < 1024 * 1024) return `, ${(bytes / 1024).toFixed(1)} KB`;
  return `, ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Turns an incoming Telegram message (text and/or files) into the turn's user message. */
function toUserMessage(message: TelegramMessage): UIMessage | string {
  const attachments = telegramAttachments(message);
  const text = (message.text ?? message.caption ?? "").trim();
  if (attachments.length === 0) {
    // Stickers, locations, contacts, polls... still get an answer instead of silence.
    return text || "[The user sent a kind of message you can't read (such as a sticker, location or contact).]";
  }

  const listing = attachments
    .map((a) => `[Attached file: ${a.filename} (${a.mediaType}${formatBytes(a.size)})]`)
    .join("\n");
  const parts: UIMessage["parts"] = [{ type: "text", text: text ? `${text}\n\n${listing}` : listing }];
  for (const a of attachments) {
    if (!MODEL_READABLE.test(a.mediaType) || (a.size ?? 0) > MODEL_MAX_FILE_BYTES) continue;
    const url = new URL(`https://${FILE_URL_HOST}/${encodeURIComponent(a.fileId)}`);
    url.searchParams.set("type", a.mediaType);
    parts.push({ type: "file", mediaType: a.mediaType, filename: a.filename, url: url.href });
  }
  parts.push({ type: "data-telegram-attachments", data: attachments } satisfies AttachmentsPart);
  return { id: `tg-${message.chat.id}-${message.message_id}`, role: "user", parts };
}

/** Every attachment the user has sent in the conversation, by file name (latest wins). */
function collectAttachments(messages: UIMessage[]): Record<string, TelegramAttachment> {
  const byName: Record<string, TelegramAttachment> = {};
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-telegram-attachments") continue;
      for (const a of (part as AttachmentsPart).data) byName[a.filename] = a;
    }
  }
  return byName;
}

/** Files the agent chose to send this turn: the successful sendFile calls in the reply. */
function sentFiles(message: UIMessage): SentFile[] {
  const files: SentFile[] = [];
  const seen = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== "tool-sendFile" || !("state" in part) || part.state !== "output-available") continue;
    const output = (part as { output?: { ok?: boolean } & Partial<SentFile> }).output;
    if (!output?.ok || !output.sandboxId || !output.path || seen.has(output.path)) continue;
    seen.add(output.path);
    files.push({
      sandboxId: output.sandboxId,
      path: output.path,
      filename: output.filename ?? "file",
      bytes: output.bytes ?? 0,
      caption: output.caption,
    });
  }
  return files;
}

/**
 * Hosted Trigger.dev endpoint the Hono gateway (src/app.ts) forwards Telegram messages to.
 *
 * Telegram's webhook points at the gateway, not here. The gateway only forwards messages from
 * private chats whose sender has linked their account, with that sender's Clerk user id attached,
 * and signs the body with an HMAC-SHA256 (hex) in the `x-gateway-signature` header. The signing
 * secret is shared by the gateway (TELEGRAM_GATEWAY_SIGNING_SECRET) and this endpoint, so a request
 * that didn't come from the gateway can't claim to be a Clerk user.
 * Telegram redelivers an update with the same `update_id`, which dedupes retries.
 */
export const telegramEndpoint = webhooks.endpoint.define({
  id: "telegram-gateway",
  description: "Telegram messages from linked users, forwarded by the Hono gateway",
  source: webhooks.custom<LinkedTelegramUpdate>({
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: GATEWAY_SIGNATURE_HEADER,
    signingString: "raw",
    secret: { encoding: "utf8" },
    idempotencyField: { from: "body", name: "update_id" },
  }),
});

type ChannelMessageWithFiles = { text: string; files: SentFile[] };

/**
 * Telegram as a chat frontend: each incoming message (text, or files with an optional caption)
 * becomes a turn on the session for its sender's Clerk user, and the agent's reply is posted back
 * with sendMessage, followed by any files it sent with sendDocument.
 */
const telegramChannel = chat.channels.custom({
  id: "telegram",
  endpoint: telegramEndpoint,
  // The gateway only forwards private chats; checked again here so a group can never share a session.
  filter: "event.message.chat.type == 'private'",
  // One durable session per Clerk user: the key becomes the session's chatId, which scopes the
  // transcript and the user's computer (see onBoot).
  key: "{event.clerkUserId}",
  inbound: (update) => {
    const message = update.message;
    if (!message) return ""; // empty message: no turn runs
    return {
      message: toUserMessage(message),
      externalUserId: message.from ? String(message.from.id) : undefined,
      externalMessageId: String(message.message_id),
    };
  },
  // Fetches the files in the conversation for the model, once per run. The run's streamText calls
  // this for every https file URL in the prompt; URLs that aren't ours are left to other connectors.
  download: async (url) => {
    if (url.hostname !== FILE_URL_HOST) return null;
    const fileId = decodeURIComponent(url.pathname.slice(1));
    const data = await downloadTelegramFile(requireEnv("TELEGRAM_BOT_TOKEN"), fileId);
    return { data, mediaType: url.searchParams.get("type") ?? undefined };
  },
  // Lets turns that no Telegram delivery started still answer into the right chat.
  bind: (update) => (update.message ? { chatId: update.message.chat.id } : null),
  // Show "typing…" while the model works. Telegram clears it after ~5s or on the next message.
  lifecycle: async (state, ctx) => {
    const chatId = ctx.handle?.chatId ?? ctx.event?.message?.chat.id;
    if (state !== "working" || chatId === undefined) return;
    await callTelegram(requireEnv("TELEGRAM_BOT_TOKEN"), "sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  },
  // Post once when the turn ends (Telegram has no streaming edits worth the API churn).
  delivery: "final",
  outbound: (reply) => {
    const text = reply.text.trim();
    const files = reply.error ? [] : sentFiles(reply.message);
    // Telegram rejects empty messages; a files-only reply is fine.
    if (!text && files.length === 0) return null;
    return { text: text.slice(0, TELEGRAM_MAX_TEXT), files } satisfies ChannelMessageWithFiles;
  },
  send: async (message, ctx) => {
    const chatId = ctx.handle?.chatId ?? ctx.event?.message?.chat.id;
    if (chatId === undefined) return {};
    const token = requireEnv("TELEGRAM_BOT_TOKEN");
    const replyTo = ctx.event?.message?.message_id;
    const replyParameters =
      replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    const files = (message.files as SentFile[] | undefined) ?? [];
    let text = message.text;
    let ref: string | undefined;

    // A short answer with exactly one file goes out as that file's caption: one message, not two.
    // (The answer replaces the file's own caption, which usually just repeats it.)
    const single = files.length === 1 && text.length <= TELEGRAM_MAX_CAPTION;
    if (text && !single) {
      const sent = await callTelegram<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text,
        ...replyParameters,
      });
      ref = String(sent.message_id);
      text = "";
    }

    const failed: string[] = [];
    for (const file of files) {
      try {
        const data = await readSandboxFile(file.sandboxId, file.path);
        const sent = await sendTelegramDocument(token, {
          chatId,
          data,
          filename: file.filename,
          caption: single ? text || file.caption : file.caption,
          replyTo,
        });
        ref ??= String(sent.message_id);
      } catch (error) {
        logger.error("Sending a file to Telegram failed", { file, error });
        failed.push(file.filename);
      }
    }
    if (failed.length > 0) {
      // Keep the answer if it was meant to be the file's caption.
      const note = `Sorry, I couldn't attach ${failed.join(", ")}. Please ask me to send it again.`;
      const sent = await callTelegram<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text: single && text ? `${text}\n\n${note}` : note,
        ...replyParameters,
      });
      ref ??= String(sent.message_id);
    }
    return { ref };
  },
  errorMessage: "Sorry, something went wrong answering that. Please try again.",
});

const tools = { ...webTools, ...computerTools };

export const telegramAgent = chat.agent({
  id: "telegram-agent",
  channels: [telegramChannel],
  // Declared here (not only on streamText) so tool results survive history re-conversion on later turns.
  tools,
  // Run-scoped state for the computer tools; onBoot fires on every fresh worker, continuations included.
  // The channel keys sessions by Clerk user, so the chatId is the Clerk user id and each user gets
  // their own computer.
  onBoot: async ({ chatId }) => {
    computerContext.init({ userId: chatId, attachments: {} });
  },
  onTurnStart: async ({ uiMessages }) => {
    // Set per turn so the prompt carries today's date ("tonight", "this weekend", "latest").
    chat.prompt.set(buildSystemPrompt());
    // Files from any message in the conversation, so "now sign the one I sent yesterday" works.
    computerContext.attachments = collectAttachments(uiMessages);
  },
  // Stop the user's computer while the run sleeps (no compute billed); its files stay on disk.
  onChatSuspend: async ({ chatId }) => {
    await releaseUserSandbox(chatId);
  },
  onComplete: async () => {
    await releaseAllSandboxes();
  },
  // Transcript-based memory with no database: after every turn the runtime saves the
  // conversation (as UIMessages) as a snapshot in Trigger.dev's object storage, keyed by the
  // session's chatId (one per Clerk user). When the run ends and a later message boots a
  // new run, the transcript is loaded back, so the model sees the whole conversation.
  // This is also the default; it is set explicitly so swapping in a DB-backed
  // TranscriptStorage later is a one-line change.
  storage: defaultStorage,
  // Stay warm briefly for quick follow-ups, then suspend (no compute) until the next message.
  idleTimeoutInSeconds: 30,
  run: async ({ messages, tools, signal, streamText }) => {
    const google = createGoogle({ apiKey: requireEnv("GEMINI_API_KEY") });
    // `streamText` comes from the run argument (not from "ai") so the system prompt,
    // compaction, telemetry and the channel's file downloads are applied.
    return streamText({
      model: google(MODEL_ID),
      messages,
      tools,
      // Room for lookups and file work, plus the final answer.
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      // Scripts the model writes for its computer count as output tokens.
      maxOutputTokens: 8192,
    });
  },
});
