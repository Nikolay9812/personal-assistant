// Loaded before the app (via `--import`) so Sentry can instrument modules as they're imported.
import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
  // Render sets RENDER_GIT_COMMIT on each deploy, which ties issues to the commit that shipped them.
  release: process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT,
  // The SDK collects all of these by default. Webhook requests carry the Telegram secret header and
  // users' messages in their bodies, and local variables hold API keys and signing secrets, so each
  // is opted out. Users are identified by their opaque Clerk id (set in app.ts) instead of their IP.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    stackFrameVariables: false,
  },
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
})
