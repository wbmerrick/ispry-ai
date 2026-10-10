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
- Optional tap-to-talk (tap once to listen, tap again to send). Spry replies with Grok TTS when available (`api/speak.js`). Listening is never auto-restarted — that was the glitchy path.

## Membership (shown on site)

- $100 / month
- Up to 3 visits / month
- Up to 3 problems / visit
- Licensed in Tennessee · NPI 1497231054

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Checkout

- Membership Join CTAs go to SpryMD iSpry membership checkout:
  `https://www.sprymd.ai/checkout?source=ispry&plan=ispry_membership`
  ($100/month subscription; success returns to `https://ispry.ai/?welcome=1`).
- Fast-track pathway buttons (ED, balding, GLP-1, NAD+, Sermorelin) send qualified users to SpryMD visit checkout:
  `https://www.sprymd.ai/checkout?plan=protocol_start&condition=<id>`
  (same Stripe account as sprymd.ai / `create-checkout-session`).

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

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form falls back to the original "Become a member" card, so the live site behaves exactly as before.
