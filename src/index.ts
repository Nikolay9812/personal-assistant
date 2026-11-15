import { serve } from '@hono/node-server'
import app from './app.js'

serve({
  fetch: app.fetch,
  // Railway (and most hosts) set PORT.
  port: Number(process.env.PORT ?? 3000)
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
