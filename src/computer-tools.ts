// "Computer" tools for the chat agent: a private Linux machine per user, backed by a Daytona sandbox.
// Docs: https://www.daytona.io/docs
//
// The agent uses it to work on files (fill in or sign a PDF, convert, edit images, crunch a spreadsheet,
// make a chart) and to send the result back. As with the web tools, names and descriptions are
// vendor-neutral: users should never see "Daytona" or "sandbox" in replies.
//
// Lifecycle: one sandbox per Clerk user, found again by name on later runs, so files survive between
// messages. It is created on the first tool call (most turns never need it), stopped when the chat
// run suspends, auto-stopped by Daytona after 15 idle minutes as a backstop, archived an hour after
// stopping, and deleted after a week stopped.
import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { tool } from "ai";
import { z } from "zod";
import {
  downloadTelegramFile,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  TELEGRAM_MAX_UPLOAD_BYTES,
  type TelegramAttachment,
} from "./telegram.js";
import { log } from "./trigger/log.js";

export const WORKDIR = "/home/daytona/workspace";
const INBOX = `${WORKDIR}/inbox`;

const MAX_OUTPUT_CHARS = 8_000;
const MAX_READ_CHARS = 12_000;

/**
 * Run-scoped state the tools need: which user they work for, and the files the user has sent in
 * this chat (by file name), so the model can ask for "rental-agreement.pdf" instead of copying ids.
 * Initialized in the agent's onBoot, refreshed in onTurnStart.
 */
export const computerContext = chat.local<{
  /** The Clerk user id: one computer per user. */
  userId: string;
  attachments: Record<string, TelegramAttachment>;
}>({ id: "computer" });

let client: Daytona | undefined;

function daytona(): Daytona {
  if (!client) {
    if (!process.env.DAYTONA_API_KEY) {
      throw new Error("DAYTONA_API_KEY is not set in the Trigger.dev environment");
    }
    client = new Daytona(); // reads DAYTONA_API_KEY (and optional DAYTONA_API_URL / DAYTONA_TARGET)
  }
  return client;
}

function sandboxName(userId: string): string {
  return `pa-user-${userId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 63);
}

// One open (or opening) sandbox per user within this worker process.
const open = new Map<string, Promise<Sandbox>>();

async function openSandbox(userId: string): Promise<Sandbox> {
  const name = sandboxName(userId);
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await daytona().get(name);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
  }

  if (sandbox && sandbox.state !== "started") {
    // Restoring an archived sandbox takes much longer than waking a stopped one: the previous state
    // and duration explain a slow first tool call in a turn.
    const previousState = sandbox.state ?? "unknown";
    const startedAt = Date.now();
    try {
      if (sandbox.state === "starting") await sandbox.waitUntilStarted(120);
      else {
        if (sandbox.state === "stopping") await sandbox.waitUntilStopped(60);
        await sandbox.start(180);
      }
      log.info("Sandbox started", {
        "sandbox.previous_state": previousState,
        "sandbox.start_ms": Date.now() - startedAt,
      });
    } catch (error) {
      // An unrecoverable machine (error state, failed restore): replace it with a fresh one.
      // The user's files on it are lost, so this is worth noticing.
      log.warn("Replacing a sandbox that would not start", {
        "sandbox.previous_state": previousState,
        "error.type": error instanceof Error ? error.name : typeof error,
      });
      await sandbox.delete().catch(() => {});
      sandbox = undefined;
    }
  }

  if (!sandbox) {
    const startedAt = Date.now();
    sandbox = await daytona().create(
      {
        name,
        language: "python",
        labels: { app: "personal-assistant", user: userId.slice(0, 63) },
        autoStopInterval: 15,
        autoArchiveInterval: 60,
        autoDeleteInterval: 7 * 24 * 60,
      },
      { timeout: 120 }
    );
    await sandbox.process.executeCommand(`mkdir -p ${INBOX}`);
    // A new sandbox per user is the main Daytona cost driver; it also marks a user's first use or a
    // return after the week-long auto-delete.
    log.info("Sandbox created", { "sandbox.create_ms": Date.now() - startedAt });
  }
  return sandbox;
}

/** The user's sandbox, created or woken on first use in this run. */
export function userSandbox(userId: string): Promise<Sandbox> {
  let pending = open.get(userId);
  if (!pending) {
    pending = openSandbox(userId);
    open.set(userId, pending);
    pending.catch(() => open.delete(userId));
  }
  return pending;
}

/** Stops the user's sandbox if this run opened it. Call when the run is about to suspend or end. */
export async function releaseUserSandbox(userId: string): Promise<void> {
  const pending = open.get(userId);
  if (!pending) return;
  open.delete(userId);
  try {
    await (await pending).stop();
    log.info("Sandbox stopped");
  } catch (error) {
    // Not fatal: Daytona auto-stops idle sandboxes anyway (but bills until it does).
    log.warn("Could not stop the user sandbox", {
      "error.type": error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Stops every sandbox this process opened (the run is ending). */
export async function releaseAllSandboxes(): Promise<void> {
  await Promise.all([...open.keys()].map(releaseUserSandbox));
}

/** Reads a file another part of the run (the Telegram channel) needs to send. */
export async function readSandboxFile(sandboxId: string, path: string): Promise<Uint8Array> {
  const sandbox = await daytona().get(sandboxId);
  return new Uint8Array(await sandbox.fs.downloadFile(path));
}

function resolvePath(path: string): string {
  return path.startsWith("/") ? path : `${WORKDIR}/${path.replace(/^\.\//, "")}`;
}

function safeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "file";
}

/** Long output keeps its head and its tail, where errors and results usually are. */
function clipOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} chars truncated] …\n${text.slice(-half)}`;
}

/**
 * Tool failures go back to the model as data so it can try another way. Logged with the tool's
 * name and the error class only: messages can carry the user's paths and file contents.
 */
function failure(toolName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.warn("Computer tool failed", {
    "gen_ai.tool.name": toolName,
    "error.type": error instanceof Error ? error.name : typeof error,
  });
  return { ok: false as const, error: message.slice(0, 500) };
}

function requireUser(): string {
  const userId = computerContext.userId;
  if (!userId) throw new Error("No user is active");
  return userId;
}

export const computerTools = {
  runCommand: tool({
    description:
      `Run a bash command on your private Linux computer (Ubuntu, Python 3 with pypdf, Pillow, pandas and ` +
      `matplotlib; Node.js; pip and npm work, so install anything else you need). The working directory is ` +
      `${WORKDIR}, and files there persist between messages. Use it to inspect, convert, edit ` +
      `or create files, and to run scripts you wrote with writeFile. Returns the exit code and the combined output.`,
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command, e.g. 'python3 sign.py' or 'pip install reportlab'."),
      timeoutSeconds: z.number().int().min(5).max(600).default(120),
    }),
    execute: async ({ command, timeoutSeconds }) => {
      try {
        const sandbox = await userSandbox(requireUser());
        const startedAt = Date.now();
        const res = await sandbox.process.executeCommand(command, WORKDIR, undefined, timeoutSeconds);
        // The command itself isn't logged: it can carry the user's data.
        log.info("Sandbox command finished", {
          "process.exit_code": res.exitCode,
          "sandbox.command_ms": Date.now() - startedAt,
          "sandbox.timeout_s": timeoutSeconds,
        });
        return { ok: res.exitCode === 0, exitCode: res.exitCode, output: clipOutput(res.result ?? "", MAX_OUTPUT_CHARS) };
      } catch (error) {
        return failure("runCommand", error);
      }
    },
  }),

  writeFile: tool({
    description:
      `Create or overwrite a text file on your computer, such as a Python script, HTML, CSV or Markdown. ` +
      `Relative paths are under ${WORKDIR}. Prefer this over shell heredocs for anything multi-line.`,
    inputSchema: z.object({
      path: z.string().min(1).describe("File path, e.g. 'sign.py' or 'out/report.md'."),
      content: z.string().describe("The full file content."),
    }),
    execute: async ({ path, content }) => {
      try {
        const sandbox = await userSandbox(requireUser());
        const target = resolvePath(path);
        const dir = target.slice(0, target.lastIndexOf("/"));
        if (dir) await sandbox.process.executeCommand(`mkdir -p '${dir.replace(/'/g, "'\\''")}'`);
        await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), target);
        return { ok: true as const, path: target, bytes: Buffer.byteLength(content, "utf8") };
      } catch (error) {
        return failure("writeFile", error);
      }
    },
  }),

  readFile: tool({
    description:
      "Read a text file from your computer (logs, CSV, code, extracted text). For binary files such as PDFs " +
      "or images, extract what you need with a command instead (e.g. a pypdf script).",
    inputSchema: z.object({
      path: z.string().min(1),
    }),
    execute: async ({ path }) => {
      try {
        const sandbox = await userSandbox(requireUser());
        const target = resolvePath(path);
        const bytes = await sandbox.fs.downloadFile(target);
        if (bytes.subarray(0, 8000).includes(0)) {
          return { ok: false as const, error: `${target} is a binary file (${bytes.length} bytes). Use runCommand to inspect it.` };
        }
        return { ok: true as const, path: target, content: clipOutput(bytes.toString("utf8"), MAX_READ_CHARS) };
      } catch (error) {
        return failure("readFile", error);
      }
    },
  }),

  openAttachment: tool({
    description:
      "Copy a file the user sent in this chat onto your computer so you can work on it. Pass its file " +
      "name exactly as shown in the user's message ('[Attached file: <name> ...]'). Returns its path.",
    inputSchema: z.object({
      filename: z.string().min(1).describe("The attached file's name, e.g. 'rental-agreement.pdf'."),
    }),
    execute: async ({ filename }) => {
      try {
        const attachments = computerContext.attachments ?? {};
        const attachment = attachments[filename];
        if (!attachment) {
          return {
            ok: false as const,
            error: `No attachment named "${filename}". Files the user sent: ${Object.keys(attachments).join(", ") || "none"}.`,
          };
        }
        if ((attachment.size ?? 0) > TELEGRAM_MAX_DOWNLOAD_BYTES) {
          return { ok: false as const, error: "That file is over 20 MB, too large to open. Ask the user for a smaller one." };
        }
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in the Trigger.dev environment");

        const [sandbox, data] = await Promise.all([
          userSandbox(requireUser()),
          downloadTelegramFile(token, attachment.fileId),
        ]);
        const path = `${INBOX}/${safeFilename(attachment.filename)}`;
        await sandbox.process.executeCommand(`mkdir -p ${INBOX}`);
        await sandbox.fs.uploadFile(Buffer.from(data), path);
        return { ok: true as const, path, mediaType: attachment.mediaType, bytes: data.byteLength };
      } catch (error) {
        return failure("openAttachment", error);
      }
    },
  }),

  sendFile: tool({
    description:
      "Send a file from your computer to the user in this chat (it is attached to your reply). Use it " +
      "whenever the user asked for a file back, after you've checked the file is right. Give the output a " +
      "clear name first (e.g. 'rental-agreement-signed.pdf'). Up to 50 MB; call once per file.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Path of the file on your computer."),
      caption: z.string().max(1000).optional().describe("Optional short caption shown under the file."),
    }),
    execute: async ({ path, caption }) => {
      try {
        const sandbox = await userSandbox(requireUser());
        const target = resolvePath(path);
        const info = await sandbox.fs.getFileDetails(target);
        if (info.isDir) return { ok: false as const, error: `${target} is a folder. Zip it first, then send the zip.` };
        if (!info.size) return { ok: false as const, error: `${target} is empty.` };
        if (info.size > TELEGRAM_MAX_UPLOAD_BYTES) {
          return { ok: false as const, error: `${target} is ${info.size} bytes, over the 50 MB limit. Compress or split it.` };
        }
        // The Telegram channel picks these outputs out of the reply and uploads the files.
        return {
          ok: true as const,
          sandboxId: sandbox.id,
          path: target,
          filename: target.slice(target.lastIndexOf("/") + 1),
          bytes: info.size,
          caption,
          note: "The file will be attached to your reply. Don't paste its contents or a link.",
        };
      } catch (error) {
        return failure("sendFile", error);
      }
    },
  }),
};

/** What a successful sendFile call returns; the Telegram channel reads it from the reply. */
export type SentFile = {
  sandboxId: string;
  path: string;
  filename: string;
  bytes: number;
  caption?: string;
};
