import * as Sentry from '@sentry/node'

// Structured logs for the Hono gateway: sent to Sentry Logs (each attribute is searchable, and the
// log links to the request's trace) and echoed to stdout for Render's log view.
// Attributes are queried in Sentry, so keep them to ids, statuses, counts and durations: never
// message text, secrets, tokens or file contents.
export type LogAttributes = Record<string, string | number | boolean | undefined>

export const defined = (attributes: LogAttributes = {}) =>
  Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | number | boolean
  >

export const log = {
  info: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.info(message, defined(attributes))
    console.log(message, defined(attributes))
  },
  warn: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.warn(message, defined(attributes))
    console.warn(message, defined(attributes))
  },
  error: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.error(message, defined(attributes))
    console.error(message, defined(attributes))
  },
}
