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

## Membership enrollment

Join, Become a member, and qualified fast-track pathways go to Hint:

`https://ispry.hint.com/signup`

Pathways add `utm_campaign` (`ed`, `hairloss`, `weightloss`, `nad`, `sermorelin`, `uti`, `sinusitis`, `sorethroat`, `cellulitis`, `acne`, `depression`, `anxiety`, `lowt`, `nolibido`, `yeast`, `toenail`, `earache`). Spry does intake. Akute books the visit. Hint is the only enrollment link on this site.

`GET /api/hint` returns that URL. `HINT_SIGNUP_URL` may replace it with another `https://*.hint.com` signup page. Any other host is ignored and the default Hint link is used.

Hint success can return to `https://ispry.ai/?welcome=1`, or Hint Admin → Online Signup → Redirect URL can be the Akute self-scheduling link.

## Hint and Akute

Hint is the membership record. Akute is the chart. They sync through Hint's Akute integration (demographics, plan name, active/inactive, balance):

1. In Hint, publish the $100/month plan on the `ispry` signup page.
2. Marketplace → Integrations → Akute Health EHR → Integrate with Akute Health EHR, then log into Akute.

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

Until `AKUTE_API_KEY` and `AKUTE_USER_ID` are set, the form stays up and tells the patient Akute is not connected yet (no redirect).

When Akute is configured, a successful handoff auto-opens the Akute self-scheduling link in the same tab (`location.replace`, with a Continue in Akute link if redirect is blocked). If the booking URL is missing, the patient stays on a confirmation card and the office helps schedule. Visit-cap is advisory and does not block booking. Membership enrollment is Hint.

## API guards

`api/spry.js`, `api/speak.js`, `api/handoff.js`, and `api/hint.js` share `api/_lib/guard.js`:
- Same-origin / allowlisted `Origin` only
- Per-IP rate limits (warm-isolate best-effort; also enable Vercel Firewall rate limits on `/api/*`)
- Server-side Visit basics gate on Spry (age 18+, Tennessee, 1–3 problems)
