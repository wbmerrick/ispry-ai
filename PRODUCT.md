# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS in `public/` on Vercel. Serverless API routes in `api/` (Spry AI intake, TTS, Auth config, Stripe checkout links, Stripe webhook → Akute tasks, handoff). Supabase Auth + `ispry_profiles`. Stripe for cash-pay membership/visit. Akute for chart/tasks. Resend for auth SMTP (onboarding@sprymd.ai).

## Users

Adults physically in Tennessee who need physician-led telehealth without an urgent-care drive. Secondary: West Tennessee employers asking about a small-employer plan. Physicians may browse `/physicians.html` for recruitment interest.

## Product Purpose

iSpry lets a Tennessean describe a problem to Spry (AI intake), then a Tennessee-licensed physician (William B. Merrick, DO, license 4267) reviews the case—same day if submitted by 6 pm Central. Cash-pay: $49 one-time visit or $100/month membership (up to 3 visits / month, up to 3 problems / visit).

## Positioning

Physician-founded rural/West Tennessee telehealth with AI that prepares the case and never diagnoses or prescribes. “Just ask.” is the product promise: talk or type, no waiting room.

## Constraints

- Adults 18+; physically in Tennessee during the visit
- Not for emergencies (911 / 988)
- No controlled substances; no Medicare enrollment/billing
- No GLP-1, NAD+, or sermorelin offers on this product
- Chat education is not the chart; identifiers go to Akute after handoff/pay
- Condition/problem never sent to Stripe
- HIPAA via Akute chart; site uses Vercel Web Analytics only (no Meta Pixel / GA)

## Evidence

- Live: https://ispry.ai
- License 4267 · NPI 1497231054 · (731) 415-0724
- Stripe membership Payment Link and customer portal already live via `/api/checkout`
- Supabase Auth + Resend SMTP confirmed for account email

## Open decisions

- `STRIPE_VISIT_URL` (one-time $49 Payment Link) is still unset in production (`visit_url: null` from `/api/checkout`); visit CTAs fall back to Ask Spry until wired
- Google Business Profile not created yet (manual)

## Notes (inferred)

Facts above are inferred from README, live site copy, and API checks during an autonomous Impeccable init. Visual direction stays in DESIGN.md / existing CSS (dark ink + acid lime + peak photography)—not decided here.
