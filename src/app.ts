import { Hono } from 'hono'

// Telegram updates no longer come through this app: Telegram's webhook points at the hosted
// Trigger.dev endpoint declared in src/trigger/telegram-agent.ts.
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

export default app
