// Registers the webhook with Telegram.
// Usage: npm run webhook:set -- https://your-public-host.example
import { callTelegram } from '../telegram.js'

const baseUrl = process.argv[2]
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET

if (!baseUrl?.startsWith('https://')) {
  console.error('Pass the public HTTPS base URL, e.g. npm run webhook:set -- https://example.com')
  process.exit(1)
}
if (!token || !secret) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set')
  process.exit(1)
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 1-256 chars of A-Z, a-z, 0-9, _ or -')
  process.exit(1)
}

const url = new URL('/telegram/webhook', baseUrl).toString()
await callTelegram(token, 'setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message'],
  drop_pending_updates: true,
})
console.log(`Webhook set to ${url}`)
console.log(await callTelegram(token, 'getWebhookInfo', {}))
