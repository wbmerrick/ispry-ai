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
- Licensed in Tennessee

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Checkout

- Membership CTA still uses a Stripe Payment Link in `public/index.html` (`CHECKOUT_URL`) — currently **test mode**.
- Fast-track pathway buttons (ED, balding, GLP-1, NAD+, Sermorelin) send qualified users to **live** SpryMD Stripe Checkout:
  `https://www.sprymd.ai/checkout?plan=protocol_start&condition=<id>`
  (same Stripe account as sprymd.ai / `create-checkout-session`).
