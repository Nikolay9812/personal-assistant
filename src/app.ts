import { createHmac, timingSafeEqual } from 'node:crypto'
import * as Sentry from '@sentry/node'
import { idempotencyKeys, tasks } from '@trigger.dev/sdk'
import { Hono } from 'hono'
import {
  findLinkedUser,
  LINK_TELEGRAM_TASK_ID,
  telegramLinkKey,
  type LinkTelegramAccountPayload,
} from './accounts.js'
import { accountBillingUrl, hasProPlan } from './billing.js'
import { log } from './log.js'
import {
  callTelegram,
  GATEWAY_SIGNATURE_HEADER,
  type LinkedTelegramUpdate,
  type TelegramUpdate,
} from './telegram.js'

type GatewayEnv =
  | 'TELEGRAM_WEBHOOK_SECRET'
  | 'TRIGGER_TELEGRAM_ENDPOINT_URL'
  | 'TELEGRAM_GATEWAY_SIGNING_SECRET'
  | 'TELEGRAM_BOT_TOKEN'

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
    // The URL and response body stay out: the endpoint URL is credential-like and the body can echo
    // the message back. The status says whether it's auth (401/403), routing (404) or an outage.
    log.error('Forwarding to the agent failed', {
      'telegram.update_id': update.update_id,
      'http.response.status_code': res.status,
    })
    throw new Error(`Trigger.dev endpoint rejected the update (${res.status})`)
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
  const handle = await tasks.trigger(LINK_TELEGRAM_TASK_ID, payload, {
    idempotencyKey,
    // Backstop for a run that dies without resetting the key; Clerk's codes last 10 minutes.
    idempotencyKeyTTL: '15m',
    tags: ['telegram-link'],
  })
  // The same run id for repeat messages while a link is pending (the idempotency key dedupes them).
  log.info('Account linking triggered', { 'trigger.run_id': handle.id })
}

/** Tells a linked user without Pro where to upgrade, instead of running the agent. */
async function sendUpgradePrompt(chatId: number, replyTo: number): Promise<void> {
  const url = accountBillingUrl()
  await callTelegram(requireEnv('TELEGRAM_BOT_TOKEN'), 'sendMessage', {
    chat_id: chatId,
    text: `The assistant is part of the Pro plan. Upgrade in your account's Billing tab, then message me again:\n${url}`,
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[{ text: 'Upgrade to Pro', url }]] },
  })
}

const app = new Hono()

// Registered first: traces each request and reports unhandled 5xx errors. The automatic Hono
// integration does the same when instrument.ts is preloaded; requests are deduplicated.
app.use(Sentry.honoMiddleware(app))

app.get('/', (c) => c.text('ok'))

/**
 * Telegram's webhook. Only private chats are served: unlinked users get the account-linking flow;
 * linked users on the Pro plan go to the agent with their Clerk user id attached; other linked
 * users get a link to upgrade instead.
 *
 * Telegram retries an update until it gets a 2xx, so failures return 500 (the agent's endpoint
 * dedupes on update_id), while updates we deliberately ignore return 200.
 */
app.post('/telegram/webhook', async (c) => {
  const secret = c.req.header('x-telegram-bot-api-secret-token') ?? ''
  if (!safeEqual(secret, requireEnv('TELEGRAM_WEBHOOK_SECRET'))) {
    // Either a misconfigured secret (every message stops reaching the agent) or someone probing.
    log.warn('Webhook rejected: secret mismatch')
    return c.text('Unauthorized', 401)
  }

  const update = await c.req.json<TelegramUpdate>()
  const message = update.message
  if (!message?.from || message.from.is_bot || message.chat.type !== 'private') {
    log.info('Update ignored', {
      'telegram.update_id': update.update_id,
      'telegram.ignore_reason': !message ? 'not_a_message' : !message.from || message.from.is_bot ? 'bot_or_anonymous' : 'not_private',
    })
    return c.body(null, 200)
  }

  const telegramUserId = String(message.from.id)
  const clerkUserId = await findLinkedUser('telegram', telegramUserId)
  if (clerkUserId) {
    // Opaque Clerk id only: attributes this request's logs, errors and spans to the user.
    Sentry.setUser({ id: clerkUserId })
  }
  const status = !clerkUserId ? 'linking' : (await hasProPlan(clerkUserId)) ? 'allowed' : 'upgrade'
  log.info('Telegram message gated', {
    'telegram.update_id': update.update_id,
    'channel.gate_status': status,
  })

  if (status === 'linking') {
    await startLinking({ telegramUserId, chatId: message.chat.id })
  } else if (status === 'allowed') {
    await forwardToAgent({ update_id: update.update_id, message, clerkUserId: clerkUserId! })
  } else {
    await sendUpgradePrompt(message.chat.id, message.message_id)
  }
  return c.body(null, 200)
})

app.onError((error, c) => {
  Sentry.captureException(error)
  log.error('Request failed', { 'http.route': c.req.routePath, 'error.type': error.name })
  // The full stack stays in Render's logs; Sentry has it on the captured issue.
  console.error(error)
  return c.text('Internal Server Error', 500)
})

export default app
