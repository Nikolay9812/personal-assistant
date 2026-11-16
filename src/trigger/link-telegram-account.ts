import * as Sentry from "@sentry/node";
import { idempotencyKeys, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  findLinkedUser,
  LINK_TELEGRAM_TASK_ID,
  linkIdentity,
  telegramLinkKey,
  type LinkTelegramAccountPayload,
} from "../accounts.js";
import {
  DeviceAuthError,
  fetchClerkUserId,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorization,
} from "../clerk-device-auth.js";
import { callTelegram } from "../telegram.js";
import { log } from "./log.js";

function connectMessage(auth: DeviceAuthorization): string {
  const minutes = Math.round(auth.expires_in / 60);
  return [
    "👋 Hi! Before we can chat, connect your account.",
    "",
    `1. Open ${auth.verification_uri} (or tap the button below)`,
    `2. Check that the code is ${auth.user_code}`,
    "3. Sign in with Google and approve",
    "",
    `The code expires in ${minutes} minutes.`,
  ].join("\n");
}

/**
 * Links a Telegram user to their Clerk account with Clerk's device authorization flow.
 *
 * Triggered by the Hono gateway when a message arrives from a Telegram user with no
 * channel_identifiers row. Sends a "Connect your account" message with a Clerk link and a short
 * code, waits durably while the user signs in and approves, then saves the link. After that, the
 * gateway forwards the user's messages to the agent.
 */
export const linkTelegramAccount = schemaTask({
  id: LINK_TELEGRAM_TASK_ID,
  schema: z.object({
    telegramUserId: z.string().regex(/^\d+$/),
    chatId: z.number().int(),
  }) satisfies z.ZodType<LinkTelegramAccountPayload>,
  // A retry would start over and send the user a second code; failures are reported in the chat.
  retry: { maxAttempts: 1 },
  run: async ({ telegramUserId, chatId }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in the Trigger.dev environment");
    const say = (text: string, extra: Record<string, unknown> = {}) =>
      callTelegram(token, "sendMessage", { chat_id: chatId, text, ...extra });

    try {
      const existing = await findLinkedUser("telegram", telegramUserId);
      if (existing) {
        Sentry.setUser({ id: existing });
        log.info("Account linking skipped: already linked");
        await say("Your account is already connected. Send me a message to get started.");
        return { status: "already-linked" as const };
      }

      const auth = await startDeviceAuthorization();
      // The Telegram user id isn't logged: the run's tags and payload carry it for support lookups,
      // and the Clerk id identifies the user once they're linked.
      log.info("Account linking started", { "auth.expires_in_s": auth.expires_in });
      const startedAt = Date.now();
      let polls = 0;
      await say(connectMessage(auth), {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [{ text: "Connect your account", url: auth.verification_uri_complete ?? auth.verification_uri }],
          ],
        },
      });

      const deadline = Date.now() + auth.expires_in * 1000;
      let interval = auth.interval;
      while (Date.now() < deadline) {
        // Durable wait: the run isn't billed while the user signs in.
        await wait.for({ seconds: interval });

        let poll;
        polls++;
        try {
          poll = await pollDeviceToken(auth.device_code);
        } catch (error) {
          if (error instanceof DeviceAuthError) throw error;
          log.warn("Polling Clerk failed; trying again", {
            "error.type": error instanceof Error ? error.name : typeof error,
            "auth.polls": polls,
          });
          continue;
        }

        if (poll.status === "pending") continue;
        if (poll.status === "slow_down") {
          interval += 5;
          log.warn("Clerk asked to slow down polling", { "auth.interval_s": interval });
          continue;
        }
        if (poll.status === "denied") {
          log.info("Account linking denied", { "auth.polls": polls, "auth.wait_ms": Date.now() - startedAt });
          await say("Okay, nothing was connected. Send me a message whenever you want a new link.");
          return { status: "denied" as const };
        }
        if (poll.status === "expired") break;

        const clerkUserId = await fetchClerkUserId(poll.accessToken);
        const linkedTo = await linkIdentity("telegram", telegramUserId, clerkUserId);
        Sentry.setUser({ id: clerkUserId });
        if (linkedTo !== clerkUserId) {
          // Another flow linked this Telegram account first; the existing link stands.
          log.warn("Account linking conflict: already linked to another user");
          await say("This Telegram account is already connected to another account.");
          return { status: "already-linked" as const };
        }
        // Time to link shows how long users take to sign in; polls shows the Clerk load per link.
        log.info("Account linked", { "auth.polls": polls, "auth.wait_ms": Date.now() - startedAt });
        await say("You're connected ✅ Send me a message to get started.");
        return { status: "linked" as const, clerkUserId };
      }

      // Many expiries mean users get the link but don't finish signing in.
      log.info("Account linking expired", { "auth.polls": polls });
      await say("That code expired. Send me any message to get a new one.");
      return { status: "expired" as const };
    } catch (error) {
      // The error itself reaches Sentry through the global onFailure hook (init.ts).
      log.error("Account linking failed", { "error.type": error instanceof Error ? error.name : typeof error });
      await say("Sorry, I couldn't set up the connection. Send me any message to try again.").catch(() => {});
      throw error;
    } finally {
      // Let the user's next message start a fresh flow (the key also expires on its own).
      await idempotencyKeys
        .reset(LINK_TELEGRAM_TASK_ID, telegramLinkKey(telegramUserId), { scope: "global" })
        .catch((error) =>
          // Not fatal (the key expires after 15 minutes), but until then the user can't relink.
          log.warn("Could not reset the link idempotency key", {
            "error.type": error instanceof Error ? error.name : typeof error,
          })
        );
    }
  },
});
