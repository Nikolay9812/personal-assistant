// Points the Telegram bot's webhook at the Hono gateway, or pauses it.
//
//   npm run webhook:set -- https://<gateway host>/telegram/webhook
//   npm run webhook:set -- --pause
//
// --pause removes the webhook but keeps pending updates: Telegram holds new messages (for up to
// 24 hours) and delivers them once a webhook is set again, so a cut-over doesn't lose any.
import { callTelegram } from '../telegram.js'

const arg = process.argv[2]
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN must be set')
  process.exit(1)
}

if (arg === '--pause') {
  await callTelegram(token, 'deleteWebhook', { drop_pending_updates: false })
  console.log('Webhook removed; Telegram is holding new updates until a webhook is set again.')
  console.log(await callTelegram(token, 'getWebhookInfo', {}))
  process.exit(0)
}

if (!arg?.startsWith('https://')) {
  console.error('Pass the gateway URL, e.g. npm run webhook:set -- https://…/telegram/webhook (or --pause)')
  process.exit(1)
}
if (!secret) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be set (the same value as on the gateway)')
  process.exit(1)
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 1-256 chars of A-Z, a-z, 0-9, _ or -')
  process.exit(1)
}

// Telegram sends the secret in the X-Telegram-Bot-Api-Secret-Token header with every update, and
// the gateway rejects requests without it. Pending updates are kept and delivered to the new URL.
await callTelegram(token, 'setWebhook', {
  url: arg,
  secret_token: secret,
  allowed_updates: ['message'],
  drop_pending_updates: false,
})
console.log(`Webhook set to ${arg}`)
console.log(await callTelegram(token, 'getWebhookInfo', {}))
