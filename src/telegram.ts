// Minimal Telegram Bot API client — only what the echo bot needs.
// Docs: https://core.telegram.org/bots/api

export type TelegramMessage = {
  message_id: number
  chat: { id: number; type: string }
  from?: { id: number; is_bot: boolean; first_name: string; username?: string }
  text?: string
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type ApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string }

export async function callTelegram<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json()) as ApiResponse<T>
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed (${data.error_code}): ${data.description}`)
  }
  return data.result
}
