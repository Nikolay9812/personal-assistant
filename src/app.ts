import { createHmac, timingSafeEqual } from 'node:crypto'
import { idempotencyKeys, tasks } from '@trigger.dev/sdk'
import { Hono } from 'hono'
import {
  findLinkedUser,
  LINK_TELEGRAM_TASK_ID,
  telegramLinkKey,
  type LinkTelegramAccountPayload,
} from './accounts.js'
import {
  GATEWAY_SIGNATURE_HEADER,
  type LinkedTelegramUpdate,
  type TelegramUpdate,
} from './telegram.js'

type GatewayEnv =
  | 'TELEGRAM_WEBHOOK_SECRET'
  | 'TRIGGER_TELEGRAM_ENDPOINT_URL'
  | 'TELEGRAM_GATEWAY_SIGNING_SECRET'

function requireEnv(name: GatewayEnv): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Hands a linked user's message to the agent's Trigger.dev endpoint, signed so only we can send it. */
async function forwardToAgent(update: LinkedTelegramUpdate): Promise<void> {
  const body = JSON.stringify(update)
  const signature = createHmac('sha256', requireEnv('TELEGRAM_GATEWAY_SIGNING_SECRET'))
    .update(body)
    .digest('hex')
  const res = await fetch(requireEnv('TRIGGER_TELEGRAM_ENDPOINT_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GATEWAY_SIGNATURE_HEADER]: signature },
    body,
  })
  if (!res.ok) {
    throw new Error(`Trigger.dev endpoint rejected the update (${res.status}): ${await res.text()}`)
  }
}

/**
 * Starts the "Connect your account" flow for a Telegram user with no linked account. While one is
 * pending, more messages from the same user don't start another (same idempotency key).
 */
async function startLinking(payload: LinkTelegramAccountPayload): Promise<void> {
  const idempotencyKey = await idempotencyKeys.create(telegramLinkKey(payload.telegramUserId), {
    scope: 'global',
  })
  // Triggered by id so this server doesn't bundle the task code (see src/trigger/link-telegram-account.ts).
  await tasks.trigger(LINK_TELEGRAM_TASK_ID, payload, {
    idempotencyKey,
    // Backstop for a run that dies without resetting the key; Clerk's codes last 10 minutes.
    idempotencyKeyTTL: '15m',
    tags: ['telegram-link'],
  })
}

const app = new Hono()

app.get('/', (c) => c.text('ok'))

/**
 * Telegram's webhook. Only private chats are served: a message from a linked user goes to the
 * agent with their Clerk user id attached; anyone else gets the account-linking flow instead.
 *
 * Telegram retries an update until it gets a 2xx, so failures return 500 (the agent's endpoint
 * dedupes on update_id), while updates we deliberately ignore return 200.
 */
app.post('/telegram/webhook', async (c) => {
  const secret = c.req.header('x-telegram-bot-api-secret-token') ?? ''
  if (!safeEqual(secret, requireEnv('TELEGRAM_WEBHOOK_SECRET'))) {
    return c.text('Unauthorized', 401)
  }

  const update = await c.req.json<TelegramUpdate>()
  const message = update.message
  if (!message?.from || message.from.is_bot || message.chat.type !== 'private') {
    return c.body(null, 200)
  }

  const telegramUserId = String(message.from.id)
  const clerkUserId = await findLinkedUser('telegram', telegramUserId)
  if (clerkUserId) {
    await forwardToAgent({ update_id: update.update_id, message, clerkUserId })
  } else {
    await startLinking({ telegramUserId, chatId: message.chat.id })
  }
  return c.body(null, 200)
})

app.onError((error, c) => {
  console.error(error)
  return c.text('Internal Server Error', 500)
})

export default app
