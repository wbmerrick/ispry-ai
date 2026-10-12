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

## Membership (shown on site)

- $100 / month
- Up to 3 visits / month
- Up to 3 problems / visit
- Licensed in Tennessee · NPI 1497231054

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Checkout

- Membership Join / Become a member stay on SpryMD until Hint is connected:
  `https://www.sprymd.ai/checkout?source=ispry&plan=ispry_membership`
  ($100/month subscription; success returns to `https://ispry.ai/?welcome=1`).
- When `HINT_SIGNUP_URL` is set to an `https://*.hint.com` signup page, `GET /api/hint` returns it and those Join buttons use Hint instead. SpryMD remains the fallback if Hint is unset, the URL is not on `hint.com`, or the request fails.
- Fast-track pathway buttons (ED, balding, GLP-1, NAD+, Sermorelin) stay on SpryMD visit checkout:
  `https://www.sprymd.ai/checkout?plan=protocol_start&condition=<id>`
  (same Stripe account as sprymd.ai / `create-checkout-session`).

## Hint membership

Hint Health is the membership record. Akute is the chart. They sync through Hint's Akute integration (demographics, plan name, active/inactive, balance).

`https://ispry.hint.com` is not an iSpry practice yet — Hint serves that hostname for any subdomain, and the signup page is "Page Not Found". Connecting it is done in Hint, not in this repo:

1. In Hint, set the practice subdomain to `ispry` and publish the $100/month plan on Online Signup. Copy that signup link.
2. Set `HINT_SIGNUP_URL` on the Vercel project to that `https://….hint.com/…` link.
3. In Hint: Marketplace → Integrations → Akute Health EHR → Integrate with Akute Health EHR, then log into Akute.
4. Optional: Hint Admin → Online Signup → Redirect URL = the Akute self-scheduling link (`AKUTE_BOOKING_URL`), so a new member goes to book after they pay. Akute documents this as the Hint-then-schedule flow.

`api/hint.js` only advertises the public signup URL. It does not create patients or charges.

## Akute handoff (`api/handoff.js`)

When Spry finishes intake (`[READY]`), the patient sees a short form (name, DOB, sex, email, mobile, Tennessee confirmation, telehealth consent, optional SMS opt-in). Identifiers go only to Akute, never to the AI model.

The function then:
1. Finds or creates the patient in Akute.
2. Counts this month's appointments (flags the 3-visit cap; advisory, never blocks).
3. Creates a task for the physician with the Spry summary (tagged SAME DAY / OVER 3-VISIT CAP when relevant). A task, not a signed note, so nothing enters the chart under the physician's name until reviewed.
4. Returns the Akute self-scheduling link.

Adults 18+ only; must be located in Tennessee.

Environment variables (Vercel project settings, never committed):
- `AKUTE_API_KEY` (Akute Settings > Developer)
- `AKUTE_USER_ID` (the physician's Akute user id)
- `AKUTE_BOOKING_URL` (Akute forms & self-scheduling link)
- optional `AKUTE_BASE_URL` (default `https://api.akutehealth.com/v1`), `VISIT_CAP` (default 3)

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form stays up and tells the patient Akute is not connected yet.

When Akute is configured, a successful handoff auto-opens the Akute self-scheduling link. Visit-cap is advisory and does not block booking. Membership enrollment is separate (Hint, or SpryMD until Hint is set).

## API guards

`api/spry.js`, `api/speak.js`, `api/handoff.js`, and `api/hint.js` share `api/_lib/guard.js`:
- Same-origin / allowlisted `Origin` only
- Per-IP rate limits (warm-isolate best-effort; also enable Vercel Firewall rate limits on `/api/*`)
- Server-side Visit basics gate on Spry (age 18+, Tennessee, 1–3 problems)
