import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { timingSafeEqual } from 'hono/utils/buffer'
import { runs, tasks } from '@trigger.dev/sdk'
import { generateReply } from './ai.js'
import type { generateTextTask } from './trigger/generate-text.js'
import { callTelegram, type TelegramUpdate } from './telegram.js'

type TelegramEnv = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  GEMINI_API_KEY: string
}

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

// TEMPORARY test route — public, no auth. Remove along with src/trigger/generate-text.ts.
// Usage: GET /test/generate?prompt=Tell%20me%20a%20joke
app.get('/test/generate', async (c) => {
  const prompt = c.req.query('prompt')?.trim() || 'Say hello in one short sentence.'
  if (prompt.length > 1000) {
    return c.json({ error: 'prompt must be at most 1000 characters' }, 400)
  }

  const handle = await tasks.trigger<typeof generateTextTask>('generate-text', { prompt })
  const run = await runs.poll(handle, { pollIntervalMs: 1000 })

  if (!run.isSuccess || !run.output) {
    return c.json({ runId: run.id, status: run.status, error: run.error ?? null }, 502)
  }
  return c.json({ runId: run.id, prompt, text: run.output.text })
})

app.post('/telegram/webhook', async (c) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, GEMINI_API_KEY } = env<TelegramEnv>(c)
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !GEMINI_API_KEY) {
    console.error('TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and GEMINI_API_KEY must be set')
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
    const chat_id = message.chat.id
    try {
      let reply: string
      if (message.text) {
        await callTelegram(TELEGRAM_BOT_TOKEN, 'sendChatAction', { chat_id, action: 'typing' })
        reply = (await generateReply(GEMINI_API_KEY, message.text)).trim()
      } else {
        reply = 'Sorry, I can only read text messages for now.'
      }
      await callTelegram(TELEGRAM_BOT_TOKEN, 'sendMessage', {
        chat_id,
        // Telegram rejects empty messages and caps text at 4096 chars.
        text: (reply || '…').slice(0, 4096),
        reply_parameters: { message_id: message.message_id },
      })
    } catch (err) {
      // Still answer 200, otherwise Telegram keeps redelivering the update.
      console.error(err)
    }
  }

  return c.text('ok')
})

export default app
