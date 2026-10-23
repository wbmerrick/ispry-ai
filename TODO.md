# iSpry follow-ups

From a pass on the live site. Most urgent first. Done items are already in the product; the rest are still open.

## Fix now

- [x] Logged-in messages were visible without a real session. The membership banner only appears after this browser returns from Stripe checkout, and Sign out stays hidden until an account session exists.
- [x] Medicare. The site does not enroll Medicare beneficiaries and does not bill Medicare. Accepting Medicare members later still needs a healthcare attorney, because opting out would touch hospitalist and SNF/ACO REACH work.
- [x] NAD+, sermorelin, and GLP-1 are off the iSpry fast track and out of Spry's offers. There is no SpryMD site in this repo to link, so they were removed here instead of sent to a different practice.

## Conversion

- [x] One-time visit at $49 that can upgrade to membership. Checkout goes live when `STRIPE_VISIT_URL` is a one-time Stripe Payment Link (not the $100 subscription).
- [x] Same-day physician review if the case is submitted by 6 pm Central. After that, the next morning.
- [x] Two messages to Spry before an account, including after the fast-track safety questions. The third message asks for the account. Emergencies still skip the account. A stopped fast-track screen can open Ask Spry without the account form.
- [x] Plain words on fast track, including "Fear of flying," and no question mark on those buttons.

## Trust

- [x] Tennessee license 4267 (the number on NPI 1497231054) links to the Tennessee Department of Health verification page, and (731) 415-0724 is in the header.
- [x] "What we can't treat" is on the homepage.
- [x] No review block. Real reviews can be added when they exist. None were invented.

## Growth

- [x] Pages for online UTI treatment in Tennessee, sore throat treatment in Tennessee, and telehealth in Jackson, TN, plus a West Tennessee care page and `sitemap.xml`.
- [ ] Google Business Profile still has to be created in the Google account for the practice. Use the practice name, (731) 415-0724, https://ispry.ai/, and a West Tennessee service area. Do not publish a home street address.
- [x] Rural line: no 45-minute drive to urgent care.
- [x] HSA/FSA note, and a small-employer plan for West TN businesses reached at (731) 415-0724.
- [x] No Meta Pixel or Google Analytics. Vercel Web Analytics stays, and events no longer include the condition.

## Account / auth

Shipped in code and live on production after #55 (header Sign in, signup `auth.resend`, confirm OTP/password, PKCE + error surfacing, profile recovery, `[hidden]` CSS). `/api/auth-config` returns configured. Still open in the Supabase dashboard:

- [x] [URL configuration](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/url-configuration): **Site URL** = `https://ispry.ai` (not localhost). Redirect allowlist: `https://ispry.ai/**` (add preview origins only if you test confirm links there).
- [x] [Email templates](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/templates): Confirm signup body uses `{{ .ConfirmationURL }}` (or OTP via `{{ .Token }}`).
- [ ] [SMTP settings](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/smtp): Custom SMTP via Resend is **not live yet** — confirm mail still sends from `noreply@mail.app.supabase.io`. Enable custom SMTP, save: host `smtp.resend.com`, port `465`, user `resend`, password = Resend API key, sender `iSpry <onboarding@sprymd.ai>`. Then a new signup From must be `@sprymd.ai`.
- [x] Production UI smoke-test: header **Sign in** → email + password only; create fields stay hidden; auth-config OK.
- [x] Confirm link redirect: signup email uses `redirect_to=https://ispry.ai` (Site URL / allowlist OK).
- [ ] End-to-end after SMTP: create account → open confirmation link → Sign in with password.
- [x] `ispry_profiles` SQL/RLS in repo (`supabase/migrations/20261023120000_ispry_profiles.sql`); live trigger `search_path` fixed.
