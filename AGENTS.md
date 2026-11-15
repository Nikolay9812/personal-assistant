## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

## Render environment variables

When syncing environment variables from the local `.env` to Render (via the Render skill/MCP, e.g. `update_environment_variables`), **always exclude `TRIGGER_SECRET_KEY`**. The local value is a Trigger.dev development key (`tr_dev_...`) and must never overwrite Render's production key. Leave Render's existing `TRIGGER_SECRET_KEY` as it is, even when asked to "sync all" variables. Also don't use a full-replace mode that would delete it from Render; only add or update the other keys.
## Database schema changes (Drizzle + Neon)

Don't use migrations. Don't run `drizzle-kit generate` or `drizzle-kit migrate`, and don't add a `drizzle/` migrations folder. To change the schema, edit `src/db/schema.ts` and apply it with `npm run db:push` (`drizzle-kit push`), which syncs the schema straight to the database over `DATABASE_URL_UNPOOLED`. Look over the statements push prints before you confirm, especially any that drop or change columns.
