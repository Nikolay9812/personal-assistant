import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { timingSafeEqual } from 'hono/utils/buffer'
import { callTelegram, type TelegramUpdate } from './telegram.js'

type TelegramEnv = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
}

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

app.post('/telegram/webhook', async (c) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } = env<TelegramEnv>(c)
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set')
    return c.text('Server misconfigured', 500)
  }

  // Telegram sends the secret_token given to setWebhook in this header.
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? ''
  if (!(await timingSafeEqual(secret, TELEGRAM_WEBHOOK_SECRET))) {
    return c.text('Unauthorized', 401)
  }

  const update = await c.req.json<TelegramUpdate>().catch(() => null)
  const message = update?.message

  // Ignore anything that isn't a new message (edits, callbacks, etc.).
  if (message) {
    try {
      // copyMessage echoes any content type: text, photos, stickers, voice...
      await callTelegram(TELEGRAM_BOT_TOKEN, 'copyMessage', {
        chat_id: message.chat.id,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      })
    } catch (err) {
      // Still answer 200, otherwise Telegram keeps redelivering the update.
      console.error(err)
    }
  }

  return c.text('ok')
})

export default app
