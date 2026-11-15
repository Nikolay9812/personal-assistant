import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Messaging platforms a Clerk user can link. Only Telegram for now. */
export const channelPlatforms = ["telegram"] as const;
export type ChannelPlatform = (typeof channelPlatforms)[number];

/**
 * Links an identity on a messaging platform (e.g. a Telegram user id) to a Clerk user.
 * Inbound messages from an external id with no row here are not authorized to talk to the agent.
 */
export const channelIdentifiers = pgTable(
  "channel_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").$type<ChannelPlatform>().notNull(),
    // Telegram user ids exceed 32 bits, so store them as text rather than integer.
    externalId: text("external_id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One platform identity maps to exactly one Clerk user; also serves the inbound lookup.
    uniqueIndex("channel_identifiers_platform_external_id_idx").on(t.platform, t.externalId),
    check("channel_identifiers_platform_check", sql`${t.platform} in ('telegram')`),
  ],
);

export type ChannelIdentifier = typeof channelIdentifiers.$inferSelect;
export type NewChannelIdentifier = typeof channelIdentifiers.$inferInsert;
