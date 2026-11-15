// Clerk's OAuth 2.0 Device Authorization Grant (RFC 8628) for a confidential OAuth application.
// Docs: https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant
//
// The bot asks Clerk for a device code, shows the user a link and a short code, and polls the
// token endpoint until the user signs in and approves (or denies, or the code expires). The tokens
// are only used once, to learn the user's Clerk id from the userinfo endpoint; nothing is stored.

type Metadata = {
  device_authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
}

export type DeviceAuthorization = {
  /** Private: only ever sent back to the token endpoint, never shown to the user. */
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export type DevicePoll =
  | { status: 'approved'; accessToken: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }

/** A response from Clerk that polling again won't fix (bad client config, invalid grant...). */
export class DeviceAuthError extends Error {
  override name = 'DeviceAuthError'
}

// The user id is all we need; `openid` keeps the approval screen to the minimum.
const SCOPE = 'openid'

function requireEnv(
  name: 'CLERK_FRONTEND_API_URL' | 'CLERK_OAUTH_CLIENT_ID' | 'CLERK_OAUTH_CLIENT_SECRET'
): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

let metadata: Promise<Metadata> | undefined

/** Clerk's advertised endpoints (the docs say to use these rather than building the URLs). */
function discover(): Promise<Metadata> {
  metadata ??= (async () => {
    const base = requireEnv('CLERK_FRONTEND_API_URL').replace(/\/$/, '')
    const res = await fetch(`${base}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`Clerk metadata request failed (${res.status})`)
    const doc = (await res.json()) as Partial<Metadata>
    if (!doc.device_authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
      throw new DeviceAuthError('Clerk does not advertise the device authorization grant on this instance')
    }
    return doc as Metadata
  })()
  metadata.catch(() => (metadata = undefined))
  return metadata
}

/** A form POST authenticated as the confidential client (HTTP Basic, as Clerk recommends). */
async function postForm(url: string, params: Record<string, string>) {
  const clientId = requireEnv('CLERK_OAUTH_CLIENT_ID')
  const clientSecret = requireEnv('CLERK_OAUTH_CLIENT_SECRET')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

/** Starts a device authorization request: returns the code to show and the one to poll with. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  const { device_authorization_endpoint } = await discover()
  const { ok, status, body } = await postForm(device_authorization_endpoint, { scope: SCOPE })
  if (!ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new DeviceAuthError(`Clerk device authorization failed (${status}): ${String(body.error ?? 'no device code')}`)
  }
  return body as unknown as DeviceAuthorization
}

/** One poll of the token endpoint. Throws DeviceAuthError for errors that end the flow. */
export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  const { token_endpoint } = await discover()
  const { ok, status, body } = await postForm(token_endpoint, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  })
  if (ok && typeof body.access_token === 'string') {
    return { status: 'approved', accessToken: body.access_token }
  }
  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'access_denied':
      return { status: 'denied' }
    case 'expired_token':
      return { status: 'expired' }
  }
  // Server-side hiccups are worth another poll; OAuth errors such as invalid_grant are not.
  if (status >= 500) throw new Error(`Clerk token endpoint failed (${status})`)
  throw new DeviceAuthError(`Clerk token endpoint returned ${String(body.error ?? status)}`)
}

/** The Clerk user id (`sub`) behind an access token from this flow. */
export async function fetchClerkUserId(accessToken: string): Promise<string> {
  const { userinfo_endpoint } = await discover()
  const res = await fetch(userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new DeviceAuthError(`Clerk userinfo request failed (${res.status})`)
  const { sub } = (await res.json()) as { sub?: unknown }
  if (typeof sub !== 'string' || !sub.startsWith('user_')) {
    throw new DeviceAuthError('Clerk userinfo returned no user id')
  }
  return sub
}
