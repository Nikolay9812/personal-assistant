// Points the Telegram bot's webhook at the hosted Trigger.dev endpoint.
// Usage: npm run webhook:set -- <Trigger.dev webhook URL for the "telegram" endpoint>
// Copy the URL from the Trigger.dev dashboard: Webhooks page → "telegram" → Webhook URL
// (each environment, dev and prod, has its own URL).
import { callTelegram } from '../telegram.js'

const url = process.argv[2]
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TRIGGER_TELEGRAM_WEBHOOK_SECRET

if (!url?.startsWith('https://')) {
  console.error('Pass the Trigger.dev endpoint URL, e.g. npm run webhook:set -- https://…')
  process.exit(1)
}
if (!token || !secret) {
  console.error('TELEGRAM_BOT_TOKEN and TRIGGER_TELEGRAM_WEBHOOK_SECRET must be set')
  process.exit(1)
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('TRIGGER_TELEGRAM_WEBHOOK_SECRET must be 1-256 chars of A-Z, a-z, 0-9, _ or -')
  process.exit(1)
}

// The same secret must be stored on the Trigger.dev endpoint, which checks it against the
// X-Telegram-Bot-Api-Secret-Token header Telegram sends with every update.
await callTelegram(token, 'setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message'],
  drop_pending_updates: true,
})
console.log(`Webhook set to ${url}`)
console.log(await callTelegram(token, 'getWebhookInfo', {}))
