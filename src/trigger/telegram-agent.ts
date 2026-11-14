import { createGoogle } from "@ai-sdk/google";
import { webhooks } from "@trigger.dev/sdk";
import { chat, defaultStorage } from "@trigger.dev/sdk/ai";
import { callTelegram, type TelegramUpdate } from "../telegram.js";

// Cheapest current Gemini text model.
const MODEL_ID = "gemini-3.5-flash-lite";

// Telegram's hard cap on a message's text length.
const TELEGRAM_MAX_TEXT = 4096;

function requireEnv(name: "TELEGRAM_BOT_TOKEN" | "GEMINI_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the Trigger.dev environment`);
  return value;
}

/**
 * Hosted Trigger.dev endpoint that Telegram's setWebhook points at.
 *
 * Telegram sends the `secret_token` passed to setWebhook in the
 * `X-Telegram-Bot-Api-Secret-Token` header, so it is verified as a shared secret in that header.
 * The endpoint's secret is generated on Trigger.dev (kept locally as TRIGGER_TELEGRAM_WEBHOOK_SECRET)
 * and passed to setWebhook as `secret_token` by src/scripts/set-webhook.ts.
 * Telegram redelivers an update with the same `update_id`, which dedupes retries.
 */
export const telegramEndpoint = webhooks.endpoint.define({
  id: "telegram",
  description: "Telegram Bot API updates",
  source: webhooks.custom<TelegramUpdate>({
    scheme: "shared-secret",
    placement: "header",
    fieldName: "x-telegram-bot-api-secret-token",
    idempotencyField: { from: "body", name: "update_id" },
  }),
});

/**
 * Telegram as a chat frontend: each incoming message becomes a turn on the session for its
 * Telegram chat, and the agent's reply is posted back with sendMessage.
 */
const telegramChannel = chat.channels.custom({
  id: "telegram",
  endpoint: telegramEndpoint,
  // Only new messages carry a conversation; edits, callbacks etc. are recorded as FILTERED.
  filter: "event.message != null",
  // One durable session (and transcript) per Telegram chat.
  key: "{event.message.chat.id}",
  inbound: (update) => {
    const message = update.message;
    if (!message) return ""; // empty message: no turn runs
    return {
      // Non-text messages (photos, stickers, ...) still get an answer instead of silence.
      message: message.text ?? "[The user sent a non-text message, which you can't read yet.]",
      externalUserId: message.from ? String(message.from.id) : undefined,
      externalMessageId: String(message.message_id),
    };
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
  // Post one message when the turn ends (Telegram has no streaming edits worth the API churn).
  delivery: "final",
  outbound: (reply) => {
    const text = reply.text.trim();
    // Telegram rejects empty messages and caps text at 4096 chars.
    return text ? { text: text.slice(0, TELEGRAM_MAX_TEXT) } : null;
  },
  send: async (message, ctx) => {
    const chatId = ctx.handle?.chatId ?? ctx.event?.message?.chat.id;
    if (chatId === undefined) return {};
    const replyTo = ctx.event?.message?.message_id;
    const sent = await callTelegram<{ message_id: number }>(
      requireEnv("TELEGRAM_BOT_TOKEN"),
      "sendMessage",
      {
        chat_id: chatId,
        text: message.text,
        ...(replyTo !== undefined && {
          reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
        }),
      }
    );
    return { ref: String(sent.message_id) };
  },
  errorMessage: "Sorry, something went wrong answering that. Please try again.",
});

export const telegramAgent = chat.agent({
  id: "telegram-agent",
  channels: [telegramChannel],
  system:
    "You are a helpful personal assistant chatting on Telegram. Reply concisely in plain text. " +
    "You remember the earlier messages of this conversation.",
  // Transcript-based memory with no database: after every turn the runtime saves the
  // conversation (as UIMessages) as a snapshot in Trigger.dev's object storage, keyed by the
  // session's chatId (one per Telegram chat). When the run ends and a later message boots a
  // new run, the transcript is loaded back, so the model sees the whole conversation.
  // This is also the default; it is set explicitly so swapping in a DB-backed
  // TranscriptStorage later is a one-line change.
  storage: defaultStorage,
  // Stay warm briefly for quick follow-ups, then suspend (no compute) until the next message.
  idleTimeoutInSeconds: 30,
  run: async ({ messages, signal, streamText }) => {
    const google = createGoogle({ apiKey: requireEnv("GEMINI_API_KEY") });
    // `streamText` comes from the run argument (not from "ai") so the system prompt,
    // compaction and telemetry are applied.
    return streamText({
      model: google(MODEL_ID),
      messages,
      abortSignal: signal,
      maxOutputTokens: 1024,
    });
  },
});
