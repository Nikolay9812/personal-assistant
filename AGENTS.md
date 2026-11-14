## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

## Render environment variables

When syncing environment variables from the local `.env` to Render (via the Render skill/MCP, e.g. `update_environment_variables`), **always exclude `TRIGGER_SECRET_KEY`**. The local value is a Trigger.dev development key (`tr_dev_...`) and must never overwrite Render's production key. Leave Render's existing `TRIGGER_SECRET_KEY` as it is, even when asked to "sync all" variables. Also don't use a full-replace mode that would delete it from Render; only add or update the other keys.