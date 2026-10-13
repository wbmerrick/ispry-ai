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
- iSpry account gate (`public/account.js` + `api/auth-config.js`) via Supabase email OTP (`ispry_profiles`). Education chat stays in the browser for the visit; profile can resume on return.

## Membership (shown on site)

- $100 / month
- Up to 3 visits / month
- Up to 3 problems / visit
- Licensed in Tennessee · NPI 1497231054

## Required for AI

Top up AI Gateway credits in the Vercel team (will's projects). Free tier blocks the Claude models Spry uses.

## Fast-track pathways

1. Patient taps a PROBLEM button and completes the 3-question contraindication screen.
2. iSpry account (name, age, sex, in Tennessee) — email OTP when Supabase is available; browser-local fallback otherwise.
3. Attention returns to Ask Spry. Spry runs pathway education (`[PATHWAY_EDU]` → ends with `[MEMBER]`).
4. **Become a member** files problem + education + identifiers to Akute (`api/handoff.js` with `after: "hint"`).
5. Patient continues to Hint for membership payment (`utm_campaign` = pathway id).
6. Physician reviews and sends Rx when appropriate.

Join / pricing CTAs still open Hint directly:

`https://ispry.hint.com/signup`

`GET /api/hint` returns that URL. `HINT_SIGNUP_URL` may replace it with another `https://*.hint.com` signup page. Any other host is ignored and the default Hint link is used.

Hint success can return to `https://ispry.ai/?welcome=1`.

## iSpry account (Supabase)

- Table: `public.ispry_profiles` (RLS: user can read/write own row).
- Auth: email one-time code (`signInWithOtp` / `verifyOtp`).
- `GET /api/auth-config` returns `supabase_url` + anon key (override with `SUPABASE_URL` / `SUPABASE_ANON_KEY`).
- Education transcripts are **not** stored server-side; pending pathway id is held in `sessionStorage` so education can resume after login in the same browser visit.

## Hint and Akute

Hint is the membership record. Akute is the chart. They sync through Hint's Akute integration (demographics, plan name, active/inactive, balance):

1. In Hint, publish the $100/month plan on the `ispry` signup page.
2. Marketplace → Integrations → Akute Health EHR → Integrate with Akute Health EHR, then log into Akute.

`api/hint.js` only advertises the public signup URL. It does not create patients or charges.

## Akute handoff (`api/handoff.js`)

When Spry finishes a normal intake (`[READY]`), or when a pathway ends with **Become a member** (`[MEMBER]`), the patient sees a short form (name, DOB, sex, email, mobile, Tennessee confirmation, telehealth consent, optional SMS opt-in). Identifiers go only to Akute, never to the AI model.

The function then:
1. Finds or creates the patient in Akute.
2. Counts this month's appointments (flags the 3-visit cap; advisory, never blocks).
3. Creates a task for the physician with the Spry summary (includes pathway id + education when present). A task, not a signed note, so nothing enters the chart under the physician's name until reviewed.
4. For pathway membership: returns a Hint signup URL for payment. For normal `[READY]` intake: returns the Akute self-scheduling link.

Adults 18+ only; must be located in Tennessee.

Environment variables (Vercel project settings, never committed):
- `AKUTE_API_KEY` (Akute Settings > Developer)
- `AKUTE_USER_ID` (the physician's Akute user id)
- `AKUTE_BOOKING_URL` (Akute forms & self-scheduling link)
- optional `AKUTE_BASE_URL` (default `https://api.akutehealth.com/v1`), `VISIT_CAP` (default 3)
- optional `SUPABASE_URL`, `SUPABASE_ANON_KEY` for the account gate
- optional `HINT_SIGNUP_URL`

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form stays up and tells the patient Akute is not connected yet (no redirect).

## API guards

`api/spry.js`, `api/speak.js`, `api/handoff.js`, `api/hint.js`, and `api/auth-config.js` share `api/_lib/guard.js`:
- Same-origin / allowlisted `Origin` only
- Per-IP rate limits (warm-isolate best-effort; also enable Vercel Firewall rate limits on `/api/*`)
- Server-side Visit basics gate on Spry (age 18+, Tennessee, 1–3 problems)
