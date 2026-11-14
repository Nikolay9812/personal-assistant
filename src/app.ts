import { Hono } from 'hono'
import { runs, tasks } from '@trigger.dev/sdk'
import type { generateTextTask } from './trigger/generate-text.js'

// Telegram updates no longer come through this app: Telegram's webhook points at the hosted
// Trigger.dev endpoint declared in src/trigger/telegram-agent.ts.
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

export default app
