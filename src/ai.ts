import { createGoogle } from '@ai-sdk/google'
import { generateText } from 'ai'

// Cheapest current Gemini text model.
const MODEL_ID = 'gemini-3.5-flash-lite'

export async function generateReply(apiKey: string, userText: string): Promise<string> {
  const google = createGoogle({ apiKey })
  const { text } = await generateText({
    model: google(MODEL_ID),
    instructions:
      'You are a helpful personal assistant chatting on Telegram. Reply concisely in plain text.',
    prompt: userText,
    maxOutputTokens: 1024,
  })
  return text
}
