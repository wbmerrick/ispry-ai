# iSpry.ai

Physician-led telehealth landing site + Spry AI intake for Tennessee.

## Live

- Production: https://ispry-ai.vercel.app
- Custom domain: ispry.ai (add DNS if not already pointed)

## Stack

- Static site in `public/`
- `api/spry.js` — streaming intake via Vercel AI Gateway (stateless; no chat storage)
- Client-side emergency keyword screen (911 / 988) before the model runs

## Membership (shown on site)

- $100 / month
- Up to 3 visits / month
- Up to 3 problems / visit
- Licensed in Tennessee · NPI 1497231054

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Checkout

Stripe Payment Link is currently **test mode** in `public/index.html` (`CHECKOUT_URL`). Swap to a live $100/month subscription link before taking real payments.
