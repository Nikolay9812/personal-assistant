// Loaded automatically by Trigger.dev before tasks run (init.ts at the root of the trigger dir).
import * as Sentry from "@sentry/node";
import { tasks } from "@trigger.dev/sdk";

Sentry.init({
  // Its own variable, not SENTRY_DSN: `trigger dev` loads the same .env as the API server, which
  // reports to a different Sentry project.
  dsn: process.env.SENTRY_TRIGGER_DSN,
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  // Trigger.dev runs its own OpenTelemetry setup for run tracing; Sentry's default integrations
  // would register a second one, so only what's listed here is enabled.
  defaultIntegrations: false,
  integrations: [
    // gen_ai spans (model calls, tool calls, tokens, cost) from the AI SDK's telemetry channel.
    // Metadata only: messages, tool inputs/outputs and the system prompt stay out of Sentry. Both
    // flags are explicit because the integration records content by default.
    Sentry.vercelAIIntegration({ recordInputs: false, recordOutputs: false }),
  ],
  // The SDK collects all of these by default. Task code handles users' messages, files and API
  // keys, so each is opted out (genAI matches the integration's flags above).
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    stackFrameVariables: false,
  },
  // Agent turns are the only traced work here, and a dropped root span would drop the whole turn's
  // token and cost data, so keep all of them.
  tracesSampleRate: 1.0,
});

tasks.onStartAttempt(({ ctx }) => {
  // A worker process serves one deployed version in one environment, so these hold for every
  // event, span and log the process sends.
  const options = Sentry.getClient()?.getOptions();
  if (options) {
    options.environment = ctx.environment.type.toLowerCase();
    options.release ??= ctx.run.version;
  }
  // Attached to every log and event from this attempt, so a log line leads back to its run.
  const run = {
    "trigger.task": ctx.task.id,
    "trigger.run_id": ctx.run.id,
    "trigger.attempt": ctx.attempt.number,
  };
  const scope = Sentry.getGlobalScope();
  scope.setAttributes(run);
  scope.setTags(run);
  scope.setContext("trigger", {
    runId: ctx.run.id,
    taskId: ctx.task.id,
    environment: ctx.environment.slug,
    version: ctx.run.version,
  });
  // A warm worker reuses the process for the next run; don't carry the last run's user over.
  Sentry.setUser(null);
});

// Fires once a run has failed for good (after retries), not on every failed attempt.
// Payloads hold users' messages, so they aren't attached.
tasks.onFailure(async ({ error }) => {
  Sentry.captureException(error);
  // Flushed here too: the hook order relative to onComplete isn't guaranteed.
  await Sentry.flush(2000);
});

// Logs and spans are buffered. A run can be torn down when it ends, and checkpointed while it
// waits (the chat agent idles between turns, the link task waits for sign-in), so send what's
// buffered before either happens.
const flush = async () => {
  await Sentry.flush(2000);
};
tasks.onWait(flush);
tasks.onComplete(flush);
