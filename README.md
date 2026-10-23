# iSpry.ai

Physician-led telehealth landing site + Spry AI intake for Tennessee.

## Live

- Production: https://ispry.ai (Vercel project `ispry-ai`, production branch `cursor/ispry-ai-site`)

## Stack

- Static site in `public/`
- `api/spry.js` — streaming intake via Vercel AI Gateway (stateless; no chat storage)
- Client-side emergency keyword screen (911 / 988) before the model runs
- Typed Ask Spry chat with composer docked under the conversation thread
- Optional tap-to-talk (tap once to listen, tap again to send). Spry replies via Gateway TTS (`api/speak.js`; Google/OpenAI primary, optional Grok). Listening is never auto-restarted, and unexpected mic ends do not auto-send.
- iSpry account gate (`public/account.js` + `api/auth-config.js`) via Supabase email+password (`ispry_profiles`), with magic-link fallback. A visitor can send two Spry messages before an account, including after a fast-track safety screen. The third message requires the account. Education chat stays in the browser for the visit; profile can resume on return.

## Pricing (shown on site)

- One-time visit: $49 for a single problem. It does not renew. Patients can upgrade to membership later.
- Membership: $100 / month, up to 3 visits / month, up to 3 problems / visit
- Licensed in Tennessee · license 4267 · NPI 1497231054 · (731) 415-0724
- Same-day physician review when the case is submitted by 6 pm Central
- Does not enroll Medicare beneficiaries and does not bill Medicare
- Does not offer GLP-1, NAD+, or sermorelin

The $49 visit Payment Link is optional env `STRIPE_VISIT_URL` (must be `https://buy.stripe.com/...` or another Stripe-hosted checkout). Until it is set, visit buttons start Ask Spry instead of charging the membership price, and a filed visit intake tells the office to collect the $49 fee. Create the link as a one-time price (not a subscription), with success URL `https://ispry.ai/?welcome=1`. A one-time Checkout (`mode=payment`) becomes an Akute task "one-time visit PAID — not a membership". Do not point `STRIPE_VISIT_URL` at the $100 membership link.

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Fast-track pathways

1. Patient taps a PROBLEM button and completes the 3-question contraindication screen.
2. iSpry account (name, email, password, age, sex, in Tennessee) — email+password when Supabase is available (magic-link fallback); browser-local fallback otherwise.
3. Attention returns to Ask Spry. Spry takes a focused history for the chosen problem (`[PATHWAY_INTAKE]`), gives a `[SYNOPSIS]` naming the most likely problem (which may differ from the one clicked), then educates and ends with `[MEMBER]`.
4. **Become a member** files problem + education + identifiers to Akute (`api/handoff.js` with `after: "pay"`).
5. Patient continues to Stripe Checkout for membership payment. The checkout URL carries `client_reference_id` = the Akute patient id and `prefilled_email`; the condition is never sent to Stripe.
6. Physician reviews and sends Rx when appropriate.

Join / pricing CTAs open the Stripe Payment Link directly:

`https://buy.stripe.com/4gM7sNehu4CUcef1PL7Zu01`

`GET /api/checkout` returns that URL plus the customer-portal login link. `STRIPE_CHECKOUT_URL` / `STRIPE_PORTAL_URL` may override them but must stay on `buy.stripe.com`, `checkout.stripe.com` or `billing.stripe.com`; anything else is ignored.

After payment Stripe returns the patient to `https://ispry.ai/?welcome=1`. That banner is shown only when this browser tab started the Stripe checkout (a `sessionStorage` flag set on the way out). A shared or typed `?welcome=1` link does not show membership or visit confirmation, and the query is removed from the address bar. The header Sign out chip stays hidden until an account session exists; a leftover local profile is cleared when Supabase reports no session.

## iSpry account (Supabase)

- Table: `public.ispry_profiles` (RLS: user can read/write own row). Schema lives in `supabase/migrations/20261023120000_ispry_profiles.sql`.
- Auth: email + password (`signUp` / `signInWithPassword`). Header **Sign in** opens the password form; create is available from the modal toggle. Optional magic-link fallback (`signInWithOtp`) for returning patients. Passwords are never written to `localStorage`.
- When Supabase requires email confirmation, signup stashes profile fields, shows a confirm step, and **Resend** uses `auth.resend({ type: "signup" })` (not a magic link). After confirm, the patient signs in with the same password (or opens the confirmation link on this site).
- `GET /api/auth-config` returns `supabase_url` + anon key (override with `SUPABASE_URL` / `SUPABASE_ANON_KEY`).
- In the Supabase dashboard (Authentication → URL configuration): set **Site URL** to `https://ispry.ai` and add redirect allowlist entries for `https://ispry.ai/**` and local preview origins. If Site URL stays on `http://localhost:3000`, confirmation and magic links open a dead local page. Failed redirects surface `#error` / `error_description` in the account modal instead of failing silently.
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
3. Creates a task for the physician with the Spry summary (includes pathway id + education when present; tagged SAME DAY / OVER 3-VISIT CAP when relevant). A task, not a signed note, so nothing enters the chart under the physician's name until reviewed.
4. For pathway membership: returns the Stripe checkout URL (`checkout_url`, with `client_reference_id` + `prefilled_email`). For normal `[READY]` intake: returns Akute follow-through links — forms (demographics + pharmacy) and self-scheduling.

Adults 18+ only; must be located in Tennessee.

Patient follow-through in Akute (after handoff):
1. Complete demographics in the Akute form bundle.
2. Enter preferred pharmacy (required for e-prescribing).
3. Book the visit via self-scheduling.

In Akute: Settings → Forms — publish a form bundle that includes Address/demographics and Pharmacy answer types, then set that bundle URL as `AKUTE_FORMS_URL`. Set the self-scheduling site (`https://….akutehealth.com/appointments`) as `AKUTE_BOOKING_URL`.

Environment variables (Vercel project settings, never committed):
- `AKUTE_API_KEY` (Akute Settings > Developer)
- `AKUTE_USER_ID` (the physician's Akute user id)
- `AKUTE_FORMS_URL` (Akute form bundle: demographics + pharmacy; preferred primary redirect)
- `AKUTE_BOOKING_URL` (Akute self-scheduling link)
- optional `AKUTE_BASE_URL` (default `https://api.akutehealth.com/v1`), `VISIT_CAP` (default 3)
- optional `SUPABASE_URL`, `SUPABASE_ANON_KEY` for the account gate
- `STRIPE_WEBHOOK_SECRET` (Stripe → Developers → Webhooks → the ispry.ai endpoint → Reveal signing secret) — required for `/api/stripe-webhook`
- `STRIPE_SECRET_KEY` (a restricted key with Subscriptions: write and Customers: write) — lets the webhook store the Akute patient id on the subscription; without it, later events fall back to email matching
- optional `STRIPE_CHECKOUT_URL`, `STRIPE_PORTAL_URL`, `STRIPE_VISIT_URL` (one-time $49 visit Payment Link)
- optional `RESEND_API_KEY` + `NOTIFY_TO` (+ `NOTIFY_FROM` once the ispry.ai domain is verified in Resend) — emails the physician a no-identifier heads-up when an intake task or membership event lands in Akute

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form stays up and tells the patient Akute is not connected yet (no redirect).

When Akute is configured, a successful `[READY]` handoff auto-opens the forms link first when set (demographics + pharmacy), otherwise the booking link (`location.replace`, with on-page CTAs if redirect is blocked). If both URLs are missing, the patient stays on a confirmation card and the office helps finish follow-through. Visit-cap is advisory and does not block booking. Pathway membership handoffs go to Stripe checkout instead.

## API guards

`api/spry.js`, `api/speak.js`, `api/handoff.js`, `api/checkout.js`, and `api/auth-config.js` share `api/_lib/guard.js` (`api/stripe-webhook.js` is gated by Stripe's signature instead):
- Same-origin / allowlisted `Origin` only
- Per-IP rate limits (warm-isolate best-effort; also enable Vercel Firewall rate limits on `/api/*`)
- Server-side Visit basics gate on Spry (age 18+, Tennessee, 1–3 problems)

Vercel Firewall also rate-limits `/api/*` (except the Stripe webhook) at 60 requests per minute per IP — configured in the Vercel dashboard, not in this repo.

## Uptime check

`.github/workflows/uptime.yml` probes the live site every 10 minutes from GitHub Actions: the homepage plus the config endpoints `GET /api/spry?check=1`, `GET /api/handoff?check=1`, `GET /api/checkout`, `GET /api/stripe-webhook`, and `GET /api/auth-config`. Probes spend no model tokens and never touch Akute or Stripe. A failed run emails the repo owner (GitHub notifications for failed workflows, on by default). Run it on demand from the Actions tab via "Run workflow".

## Accessibility

The chat is a `role="log"` with `aria-live="off"`; a visually hidden announcer (`#srLive`) reads each finished reply, error, and next-step card once, so streamed replies are not read chunk by chunk. Every bubble carries a hidden "You said" / "Spry said" label. The handoff form and the emergency card take keyboard focus when they appear (the composer is hidden at that point). Chat cards use `<h2>` so heading order stays valid under the hero `<h1>`. A "Skip to Spry" link is the first Tab stop.
