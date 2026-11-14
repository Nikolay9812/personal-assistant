import { createGoogle } from "@ai-sdk/google";
import { AbortTaskRunError, logger, task } from "@trigger.dev/sdk";
import { generateText } from "ai";

// TEMPORARY: backs the public GET /test/generate route. Remove together with it.
export const generateTextTask = task({
  id: "generate-text",
  maxDuration: 60,
  run: async (payload: { prompt: string }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Retrying won't help until the env var is set in the Trigger.dev dashboard.
      throw new AbortTaskRunError("GEMINI_API_KEY is not set");
    }

    const google = createGoogle({ apiKey });
    const { text, usage } = await generateText({
      model: google("gemini-3.5-flash-lite"),
      prompt: payload.prompt,
      maxOutputTokens: 512,
    });

    logger.log("Generated text", { usage });
    return { text };
  },
});
