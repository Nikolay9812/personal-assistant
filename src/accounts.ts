// Linking messaging-platform identities (a Telegram user id) to Clerk users.
// Shared by the Hono gateway (lookups) and the Trigger.dev link task (inserts).
import { and, eq } from 'drizzle-orm'
import { channelIdentifiers, db, type ChannelPlatform } from './db/index.js'

/** The Clerk user an external identity is linked to, if any. */
export async function findLinkedUser(
  platform: ChannelPlatform,
  externalId: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ clerkUserId: channelIdentifiers.clerkUserId })
    .from(channelIdentifiers)
    .where(and(eq(channelIdentifiers.platform, platform), eq(channelIdentifiers.externalId, externalId)))
    .limit(1)
  return row?.clerkUserId
}

/**
 * Links an external identity to a Clerk user. An identity that is already linked keeps its
 * existing link; returns the Clerk user the identity ends up linked to.
 */
export async function linkIdentity(
  platform: ChannelPlatform,
  externalId: string,
  clerkUserId: string
): Promise<string> {
  const [inserted] = await db
    .insert(channelIdentifiers)
    .values({ platform, externalId, clerkUserId })
    .onConflictDoNothing({ target: [channelIdentifiers.platform, channelIdentifiers.externalId] })
    .returning({ clerkUserId: channelIdentifiers.clerkUserId })
  if (inserted) return inserted.clerkUserId
  const existing = await findLinkedUser(platform, externalId)
  if (!existing) throw new Error(`Linking ${platform} identity ${externalId} failed`)
  return existing
}

/** The Trigger.dev task that runs the account-linking flow for a Telegram user. */
export const LINK_TELEGRAM_TASK_ID = 'link-telegram-account'

export type LinkTelegramAccountPayload = {
  telegramUserId: string
  /** The private chat to answer in (the same number as the user id in private chats). */
  chatId: number
}

/**
 * Idempotency key (global scope) for a Telegram user's link run: messages sent while a link is
 * pending don't start a second flow. The task resets it when the flow ends.
 */
export function telegramLinkKey(telegramUserId: string): string {
  return `telegram-link-${telegramUserId}`
}
