import { SentryCli } from "@sentry/cli";
import { additionalPackages } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_udvljzzlcnrdywclqdvx",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  build: {
    extensions: [
      // The Daytona SDK is bundled, but it loads some of its own dependencies (busboy for file
      // downloads, tar, form-data, tinyglobby, ...) with dynamic requires the bundler can't follow.
      // Installing the package in the deploy image puts those dependencies in /app/node_modules,
      // where the bundled code finds them. (`build.external` doesn't work for it: the SDK's nested
      // cjs/package.json has no name or version, so the CLI falls back to bundling.)
      // Keep the version in sync with package.json.
      additionalPackages({ packages: ["@daytona/sdk@0.231.1"] }),
      // Uploads source maps to the personal-assistant-trigger Sentry project on deploy, so
      // production stack traces show the original TypeScript.
      //
      // Not @sentry/esbuild-plugin: the trigger.dev CLI runs esbuild with `write: false` and writes
      // the bundle itself afterwards, so the plugin finds no files to upload. This runs once the
      // bundle is on disk and before the deploy image is built: it injects debug IDs into those
      // exact files (so deployed code and uploaded maps match), then uploads them.
      // Needs SENTRY_AUTH_TOKEN in the deploying shell; without it the upload is skipped.
      {
        name: "sentry-sourcemaps",
        onBuildComplete: async (context, manifest) => {
          if (context.target !== "deploy") return;
          const authToken = process.env.SENTRY_AUTH_TOKEN;
          if (!authToken) {
            context.logger.warn("SENTRY_AUTH_TOKEN is not set; skipping the Sentry source map upload");
            return;
          }
          const cli = new SentryCli(null, {
            authToken,
            org: "codewithantonio-hg",
            project: "personal-assistant-trigger",
            url: "https://de.sentry.io",
          });
          // The trigger.dev CLI's own entry points and dependencies are bundled in too; they aren't
          // our code, so they're left out.
          const ignore = ["--ignore", "**/node_modules/**", "--ignore", "**/npm-cache/**"];
          await cli.execute(["sourcemaps", "inject", manifest.outputPath, ...ignore], false);
          await cli.execute(["sourcemaps", "upload", manifest.outputPath, ...ignore], false);
          context.logger.log("Uploaded source maps to Sentry");
        },
      },
    ],
  },
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
