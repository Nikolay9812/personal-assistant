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
