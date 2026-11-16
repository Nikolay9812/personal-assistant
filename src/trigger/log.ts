import * as Sentry from "@sentry/node";
import { logger } from "@trigger.dev/sdk";
import { defined, type LogAttributes } from "../log.js";

// Structured logs for task code: sent to Sentry Logs, where init.ts attaches the run's task, run id
// and attempt to every entry, and to the Trigger.dev run log. Same attribute rules as ../log.ts:
// ids, statuses, counts and durations only, never message text, secrets or file contents.
export const log = {
  info: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.info(message, defined(attributes));
    logger.info(message, defined(attributes));
  },
  warn: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.warn(message, defined(attributes));
    logger.warn(message, defined(attributes));
  },
  error: (message: string, attributes?: LogAttributes) => {
    Sentry.logger.error(message, defined(attributes));
    logger.error(message, defined(attributes));
  },
};
