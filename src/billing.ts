// Clerk Billing checks for the Hono gateway. The gateway has a Clerk user id but no Clerk session,
// so the plan is read from the Backend API instead of has({ plan }).
// Docs: https://clerk.com/docs/reference/backend-api/tag/users/get/users/%7Buser_id%7D/billing/subscription

/** The paid user plan that unlocks the agent (Clerk Dashboard → Billing → Plans → User Plans). */
export const PRO_PLAN_SLUG = 'pro'

type BillingEnv = 'CLERK_SECRET_KEY' | 'CLERK_FRONTEND_API_URL'

function requireEnv(name: BillingEnv): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

type SubscriptionItem = { status: string; plan?: { slug: string } | null }
type Subscription = { subscription_items: SubscriptionItem[] }

/**
 * Whether the user's plan slug is Pro. An item stays `active` until its period ends, even after
 * the user cancels, so a cancelled subscription keeps working for the time already paid for.
 */
export async function hasProPlan(clerkUserId: string): Promise<boolean> {
  const res = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}/billing/subscription`,
    { headers: { authorization: `Bearer ${requireEnv('CLERK_SECRET_KEY')}` } }
  )
  // Users who never had a subscription (e.g. created before Billing was enabled) get a 404.
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`Clerk subscription request failed (${res.status}): ${await res.text()}`)
  }
  const subscription = (await res.json()) as Subscription
  return subscription.subscription_items.some(
    (item) => item.status === 'active' && item.plan?.slug === PRO_PLAN_SLUG
  )
}

/**
 * The Billing tab of the hosted Account Portal's /user page. The portal lives next to the Frontend
 * API: `foo.clerk.accounts.dev` → `foo.accounts.dev` in development, `clerk.example.com` →
 * `accounts.example.com` in production.
 */
export function accountBillingUrl(): string {
  const frontendApi = new URL(requireEnv('CLERK_FRONTEND_API_URL'))
  const host = frontendApi.hostname.endsWith('.clerk.accounts.dev')
    ? frontendApi.hostname.replace(/\.clerk\.accounts\.dev$/, '.accounts.dev')
    : frontendApi.hostname.replace(/^clerk\./, 'accounts.')
  return `https://${host}/user/billing`
}
