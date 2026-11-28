# iSpry follow-ups

From a pass on the live site. Most urgent first. Done items are already in the product; the rest are still open.

## Legal wording still for the attorney

These were not edited. The patient-facing pages outside these documents were aligned with the code.

- Terms, Privacy, and the Notice of Privacy Practices still say effective October 12, 2026. Telehealth consent is version 2026-11-13.
- Privacy says chat text is sent to an AI service and does not name the AI or hosting vendors.
- Terms and the telehealth consent say a covering clinician may review a case. Patient pages say your iSpry physician reviews each case. No backup clinician is published.
- Terms do not yet state what happens to the fee if the physician cannot treat the visit after payment. The pricing page says to call the practice and does not promise a refund.
- Spry's chart lines still begin with "Most likely:" and "Problem:" because the visit-type forms read those prefixes. The on-screen label now says the synopsis is a summary for the physician, not a diagnosis.
- Checked Terms, Privacy, the Notice of Privacy Practices, and telehealth consent: none state a review cutoff. If hours are added later, say requests are reviewed 24/7. The recorded intro still states the old cutoff; its captions match the audio and were not rewritten.

## Fix now

- [x] Logged-in messages were visible without a real session. The membership banner only appears after this browser returns from Stripe checkout, and Sign out stays hidden until an account session exists.
- [x] Medicare. The site does not enroll Medicare beneficiaries and does not bill Medicare. Accepting Medicare members later still needs a healthcare attorney, because opting out would touch other clinical work.
- [x] Nov 2026: GLP-1 reversed. Weight loss is now offered on iSpry (homepage chip, `/weight-loss-tennessee.html`, Spry intake rules). Open: decide the pharmacy/medication source and pricing, and confirm the follow-up schedule.
- [x] Removed NAD+/sermorelin "not offered" copy from patient-facing pages and Spry guidance.

## Conversion

- [x] One-time visit at $49 that can upgrade to membership. Live Stripe Payment Link via `STRIPE_VISIT_URL` (`/api/checkout` returns `visit_url`).
- [x] Your iSpry physician reviews requests 24/7, including nights, weekends, and holidays.
- [x] Account creation is required before Ask Spry (no guest preview turns). Emergencies still skip the account gate. Spry synopsis / differential is filed to Akute for the physician at handoff.
- [x] Pay fork after every successful intake: $49 visit or $100/mo membership, then chart + Stripe.
- [x] Patient-facing copy uses chart/physician language (not Akute EHR jargon).
- [x] Plain words on starter chips; no question marks on those buttons.

## Trust

- [x] The public site does not publish a physician name, license number, or NPI. (731) 415-0724 stays in the header. Identity and license are available from the practice on request.
- [x] "What we can't treat" is on the homepage.
- [x] No review block. Real reviews can be added when they exist. None were invented.
- [x] Patient intro video above Ask Spry (account → Spry → physician).

## Growth

- [x] Pages for online UTI treatment in Tennessee, sore throat treatment in Tennessee, and telehealth in Jackson, TN, plus a West Tennessee care page and `sitemap.xml`.
- [x] Pages for sinus infection, erectile dysfunction, hair loss, and medication refills, plus a small-employer page.
- [x] Telehealth informed consent page (`/telehealth-consent.html`); acceptance time and version go in the Akute task. **Have a healthcare attorney review the wording.**
- [ ] **Google Business Profile** — still manual in the practice Google account. Step-by-step: [`docs/google-business-profile.md`](docs/google-business-profile.md). Use practice name **the iSpry medical practice**, phone `(731) 415-0724`, website `https://ispry.ai/`, service area West Tennessee (Jackson / Madison County). Do **not** publish a home street address.
- [x] Wire `$49` visit checkout: Stripe one-time Payment Link live; `/api/checkout` returns `visit_url`.
- [x] Akute intake forms: handoff defaults to the published iSpry Address + Preferred Pharmacy bundle (`https://ispry.akutehealth.com/forms/6afb373681e9b56ea6ffacd2`) and booking (`https://ispry.akutehealth.com/appointments`). Override with Vercel env if republished. See `docs/akute-intake-setup.md`.
- [x] Per-visit-type Akute bundles: weight loss, ED and refill intakes open their own bundle (address + pharmacy plus one extra form). See `docs/akute-intake-setup.md`.
- [ ] **Attorney review** of the iSpry GLP-1 medication consent and the ED medication acknowledgment wording in Akute. Then open each bundle link once as a test patient.
- [x] Rural line: no 45-minute drive to urgent care.
- [x] HSA/FSA note, and a small-employer plan for West TN businesses reached at (731) 415-0724.
- [x] No Meta Pixel or Google Analytics. Vercel Web Analytics stays, and events no longer include the condition.

## Account / auth

Shipped in code and live on production after #55 (header Sign in, signup `auth.resend`, confirm OTP/password, PKCE + error surfacing, profile recovery, `[hidden]` CSS). `/api/auth-config` returns configured.

- [x] [URL configuration](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/url-configuration): **Site URL** = `https://ispry.ai` (not localhost). Redirect allowlist: `https://ispry.ai/**`.
- [x] [Email templates](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/templates): Confirm signup body uses `{{ .ConfirmationURL }}` (or OTP via `{{ .Token }}`).
- [x] [SMTP settings](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/auth/smtp): Custom SMTP via Resend live — host `smtp.resend.com`, port `465`, user `resend`, sender `iSpry <onboarding@sprymd.ai>`.
- [x] Production UI smoke-test: header **Sign in** → email + password only; create fields stay hidden; auth-config OK.
- [x] Confirm link redirect: signup email uses `redirect_to=https://ispry.ai`.
- [x] End-to-end after SMTP: create account → open confirmation link → signed-in (Sign out in header).
- [x] `ispry_profiles` SQL/RLS in repo (`supabase/migrations/20261023120000_ispry_profiles.sql`); live trigger `search_path` fixed.

## Member home

- [x] Signed-in **My care** page (`/member.html`): membership status, visits left this month, next steps, refill / follow-up / question to the physician (Akute task), billing.
- [x] `NOTIFY_TO` set in Vercel production; new intakes and member requests email the physician.
- [ ] After deploy: sign in as a real member and confirm the membership card reads Active (verifies the Stripe key can read customers and subscriptions).
