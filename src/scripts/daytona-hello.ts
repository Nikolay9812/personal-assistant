import { Daytona, DaytonaError } from "@daytona/sdk";

// Smoke test: create a sandbox, run "Hello World" inside it, print the output, delete it.
// Reads DAYTONA_API_KEY from the environment (.env via --env-file-if-exists).
async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_KEY is not set. Create one at https://app.daytona.io/dashboard/keys and add it to .env",
    );
  }

  const daytona = new Daytona();
  console.log("Creating sandbox...");
  const sandbox = await daytona.create({ language: "typescript" });
  console.log(`Sandbox created: ${sandbox.id}`);

  try {
    const response = await sandbox.process.codeRun('console.log("Hello World from Daytona!")');
    console.log(`Exit code: ${response.exitCode}`);
    console.log(`Output: ${response.result.trim()}`);
    if (response.exitCode !== 0) process.exitCode = 1;
  } finally {
    console.log("Deleting sandbox...");
    await sandbox.delete();
    console.log("Sandbox deleted.");
  }
}

main().catch((err) => {
  console.error(err instanceof DaytonaError ? `Daytona error: ${err.message}` : err);
  process.exit(1);
});
