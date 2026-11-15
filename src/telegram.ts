// Minimal Telegram Bot API client — only what the bot needs.
// Docs: https://core.telegram.org/bots/api

type TelegramFileBase = {
  file_id: string
  file_unique_id: string
  file_size?: number
}

export type TelegramDocument = TelegramFileBase & { file_name?: string; mime_type?: string }
export type TelegramPhotoSize = TelegramFileBase & { width: number; height: number }
export type TelegramMedia = TelegramFileBase & { file_name?: string; mime_type?: string; duration?: number }

export type TelegramMessage = {
  message_id: number
  chat: { id: number; type: string }
  from?: { id: number; is_bot: boolean; first_name: string; username?: string }
  text?: string
  /** Text sent together with a file (documents, photos, audio, video, voice). */
  caption?: string
  document?: TelegramDocument
  /** The same photo in several sizes, smallest first. */
  photo?: TelegramPhotoSize[]
  audio?: TelegramMedia
  voice?: TelegramMedia
  video?: TelegramMedia
  video_note?: TelegramMedia
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

/**
 * What the Hono gateway (src/app.ts) forwards to the agent's Trigger.dev endpoint: a message from
 * a private chat whose sender has linked their account, plus that sender's Clerk user id.
 */
export type LinkedTelegramUpdate = {
  update_id: number
  message: TelegramMessage
  clerkUserId: string
}

/** Header carrying the gateway's hex HMAC-SHA256 of the forwarded body. */
export const GATEWAY_SIGNATURE_HEADER = 'x-gateway-signature'

type ApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string }

const API = 'https://api.telegram.org'

/** Bots can download files up to 20 MB with getFile. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
/** Bots can upload files up to 50 MB with sendDocument. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Captions on files are capped at 1024 chars. */
export const TELEGRAM_MAX_CAPTION = 1024

async function parse<T>(res: Response, method: string): Promise<T> {
  const data = (await res.json()) as ApiResponse<T>
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed (${data.error_code}): ${data.description}`)
  }
  return data.result
}

export async function callTelegram<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  return parse<T>(res, method)
}

/** Downloads a file the user sent, by its file_id. */
export async function downloadTelegramFile(token: string, fileId: string): Promise<Uint8Array> {
  const file = await callTelegram<{ file_path?: string; file_size?: number }>(token, 'getFile', {
    file_id: fileId,
  })
  if (!file.file_path) throw new Error('Telegram returned no file_path (the file may be over 20 MB)')
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`)
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Sends a file to a chat as a document (keeps the file name and the original bytes). */
export async function sendTelegramDocument(
  token: string,
  params: {
    chatId: number
    data: Uint8Array
    filename: string
    caption?: string
    replyTo?: number
  }
): Promise<{ message_id: number }> {
  const form = new FormData()
  form.set('chat_id', String(params.chatId))
  form.set('document', new Blob([new Uint8Array(params.data)]), params.filename)
  if (params.caption) form.set('caption', params.caption.slice(0, TELEGRAM_MAX_CAPTION))
  if (params.replyTo !== undefined) {
    form.set(
      'reply_parameters',
      JSON.stringify({ message_id: params.replyTo, allow_sending_without_reply: true })
    )
  }
  const res = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form })
  return parse(res, 'sendDocument')
}

/** A file attached to an incoming message, normalized across Telegram's message kinds. */
export type TelegramAttachment = {
  fileId: string
  filename: string
  mediaType: string
  size?: number
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}

function named(kind: string, messageId: number, mediaType: string, filename?: string): string {
  return filename || `${kind}-${messageId}.${EXTENSIONS[mediaType] ?? 'bin'}`
}

/** Every file on a message: documents, the largest photo size, audio, voice notes and videos. */
export function telegramAttachments(message: TelegramMessage): TelegramAttachment[] {
  const id = message.message_id
  const out: TelegramAttachment[] = []
  const { document, photo, audio, voice, video, video_note } = message

  if (document) {
    const mediaType = document.mime_type ?? 'application/octet-stream'
    out.push({
      fileId: document.file_id,
      filename: named('file', id, mediaType, document.file_name),
      mediaType,
      size: document.file_size,
    })
  }
  const largestPhoto = photo?.at(-1)
  if (largestPhoto) {
    out.push({
      fileId: largestPhoto.file_id,
      filename: named('photo', id, 'image/jpeg'),
      mediaType: 'image/jpeg',
      size: largestPhoto.file_size,
    })
  }
  for (const [kind, media, fallbackType] of [
    ['audio', audio, 'audio/mpeg'],
    ['voice', voice, 'audio/ogg'],
    ['video', video, 'video/mp4'],
    ['video', video_note, 'video/mp4'],
  ] as const) {
    if (!media) continue
    const mediaType = media.mime_type ?? fallbackType
    out.push({
      fileId: media.file_id,
      filename: named(kind, id, mediaType, media.file_name),
      mediaType,
      size: media.file_size,
    })
  }
  return out
}
