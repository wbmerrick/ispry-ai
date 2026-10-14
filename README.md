# iSpry.ai

Physician-led telehealth landing site + Spry AI intake for Tennessee.

## Live

- Production: https://ispry-ai.vercel.app
- Custom domain: ispry.ai (add DNS if not already pointed)

## Stack

- Static site in `public/`
- `api/spry.js` — streaming intake via Vercel AI Gateway (stateless; no chat storage)
- Client-side emergency keyword screen (911 / 988) before the model runs
- Typed Ask Spry chat with composer docked under the conversation thread
- Optional tap-to-talk (tap once to listen, tap again to send). Spry replies via Gateway TTS (`api/speak.js`; Google/OpenAI primary, optional Grok). Listening is never auto-restarted, and unexpected mic ends do not auto-send.
- iSpry account gate (`public/account.js` + `api/auth-config.js`) via Supabase magic-link email (`ispry_profiles`). Education chat stays in the browser for the visit; profile can resume on return.

## Membership (shown on site)

- $100 / month
- Up to 3 visits / month
- Up to 3 problems / visit
- Licensed in Tennessee · NPI 1497231054

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Fast-track pathways

1. Patient taps a PROBLEM button and completes the 3-question contraindication screen.
2. iSpry account (name, age, sex, in Tennessee) — email magic link when Supabase is available; browser-local fallback otherwise.
3. Attention returns to Ask Spry. Spry takes a focused history for the chosen problem (`[PATHWAY_INTAKE]`), gives a `[SYNOPSIS]` naming the most likely problem (which may differ from the one clicked), then educates and ends with `[MEMBER]`.
4. **Become a member** files problem + education + identifiers to Akute (`api/handoff.js` with `after: "pay"`).
5. Patient continues to Stripe Checkout for membership payment. The checkout URL carries `client_reference_id` = the Akute patient id and `prefilled_email`; the condition is never sent to Stripe.
6. Physician reviews and sends Rx when appropriate.

Join / pricing CTAs open the Stripe Payment Link directly:

`https://buy.stripe.com/4gM7sNehu4CUcef1PL7Zu01`

`GET /api/checkout` returns that URL plus the customer-portal login link. `STRIPE_CHECKOUT_URL` / `STRIPE_PORTAL_URL` may override them but must stay on `buy.stripe.com`, `checkout.stripe.com` or `billing.stripe.com`; anything else is ignored.

After payment Stripe returns the patient to `https://ispry.ai/?welcome=1`.

## iSpry account (Supabase)

- Table: `public.ispry_profiles` (RLS: user can read/write own row).
- Auth: email magic link (`signInWithOtp` + `emailRedirectTo` current origin). The UI waits for the Sign in link — Supabase’s default template does not include a numeric code.
- `GET /api/auth-config` returns `supabase_url` + anon key (override with `SUPABASE_URL` / `SUPABASE_ANON_KEY`).
- In the Supabase dashboard (Authentication → URL configuration): set **Site URL** to `https://ispry.ai` and add redirect allowlist entries for `https://ispry.ai/**` and local preview origins. If Site URL stays on `http://localhost:3000`, magic links open a dead local page.
- Education transcripts are **not** stored server-side; pending pathway id is held in `sessionStorage` so education can resume after login in the same browser visit.

## Stripe and Akute

Stripe is the membership record (who is paid up). Akute is the chart. They are linked by `api/stripe-webhook.js`:

- Stripe objects: product `iSpry Membership` (`prod_VRBCyeljETgFAS`), price $100/month (`price_1UQIqYPVEdwiKcT6jkiyd9jb`), Payment Link `plink_1UQIqwPVEdwiKcT6MhstbCr2`, customer portal `bpc_1UQIs8PVEdwiKcT6Bt7S8cOc` (card update, receipts, cancel at period end), webhook endpoint `we_1UQIsYPVEdwiKcT63BEY9lgm` → `https://ispry.ai/api/stripe-webhook`.
- On `checkout.session.completed` the webhook copies the Akute patient id onto the Subscription and Customer metadata, then creates an Akute **task** on that patient: "iSpry membership ACTIVE — paid via Stripe".
- On `customer.subscription.updated` (status change or cancel scheduled), `customer.subscription.deleted`, and `invoice.payment_failed` it creates the matching task (inactive / cancel-scheduled / payment-failed, p1 when care should be held).
- Tasks, never chart edits: nothing enters the chart until the physician acts. A member who paid without a handoff (generic Join button) is matched by exact email; if no single match, the task is created unlinked and tagged `needs-linking`.
- A non-2xx response makes Stripe retry, so a transient Akute outage still ends in a task.

`api/checkout.js` only advertises the public checkout and portal URLs. It does not create patients or charges.

## Akute handoff (`api/handoff.js`)

When Spry finishes a normal intake (`[READY]`), or when a pathway ends with **Become a member** (`[MEMBER]`), the patient sees a short form (name, DOB, sex, email, mobile, Tennessee confirmation, telehealth consent, optional SMS opt-in). Identifiers go only to Akute, never to the AI model.

The function then:
1. Finds or creates the patient in Akute.
2. Counts this month's appointments (flags the 3-visit cap; advisory, never blocks).
3. Creates a task for the physician with the Spry summary (includes pathway id + education when present). A task, not a signed note, so nothing enters the chart under the physician's name until reviewed.
4. For pathway membership: returns the Stripe checkout URL (`checkout_url`, with `client_reference_id` + `prefilled_email`). For normal `[READY]` intake: returns the Akute self-scheduling link.

Adults 18+ only; must be located in Tennessee.

Environment variables (Vercel project settings, never committed):
- `AKUTE_API_KEY` (Akute Settings > Developer)
- `AKUTE_USER_ID` (the physician's Akute user id)
- `AKUTE_BOOKING_URL` (Akute forms & self-scheduling link)
- optional `AKUTE_BASE_URL` (default `https://api.akutehealth.com/v1`), `VISIT_CAP` (default 3)
- optional `SUPABASE_URL`, `SUPABASE_ANON_KEY` for the account gate
- `STRIPE_WEBHOOK_SECRET` (Stripe → Developers → Webhooks → the ispry.ai endpoint → Reveal signing secret) — required for `/api/stripe-webhook`
- `STRIPE_SECRET_KEY` (a restricted key with Subscriptions: write and Customers: write) — lets the webhook store the Akute patient id on the subscription; without it, later events fall back to email matching
- optional `STRIPE_CHECKOUT_URL`, `STRIPE_PORTAL_URL`

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form stays up and tells the patient Akute is not connected yet (no redirect).

## API guards

`api/spry.js`, `api/speak.js`, `api/handoff.js`, `api/checkout.js`, and `api/auth-config.js` share `api/_lib/guard.js` (`api/stripe-webhook.js` is gated by Stripe's signature instead):
- Same-origin / allowlisted `Origin` only
- Per-IP rate limits (warm-isolate best-effort; also enable Vercel Firewall rate limits on `/api/*`)
- Server-side Visit basics gate on Spry (age 18+, Tennessee, 1–3 problems)
