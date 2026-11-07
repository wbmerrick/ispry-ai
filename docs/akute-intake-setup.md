# Akute intake setup (iSpry)

Patient path after Spry `[READY]` handoff:

1. Identifiers → Akute patient + physician task (`/api/handoff`)
2. **Forms** — Address + Preferred Pharmacy form bundle
3. **Self-scheduling** at the booking link

## Live clinic links

| Step | URL |
| --- | --- |
| Forms (demographics + pharmacy) | https://ispry.akutehealth.com/forms/6ad624f0329a6097a0d5d8f6 |
| Booking | https://ispry.akutehealth.com/appointments |

These are the code defaults in `api/handoff.js` (`DEFAULT_FORMS_URL`, `DEFAULT_BOOKING_URL`). Override with Vercel env `AKUTE_FORMS_URL` / `AKUTE_BOOKING_URL` if a bundle is republished.

Probe: `GET https://ispry.ai/api/handoff?check=1` → `forms_configured`, `booking_configured`, and the public URLs.

## Already configured

| Piece | Status |
| --- | --- |
| `AKUTE_API_KEY` + `AKUTE_USER_ID` | Required; check reports `akute_configured` |
| Forms bundle | Default points at the published iSpry bundle above (Home Address & Preferred Pharmacy) |
| Booking | Default points at iSpry self-scheduling |

## Republish / change the form bundle

Clinician login: [app.akutehealth.com/login](https://app.akutehealth.com/login)

1. **Settings → Forms**
2. Edit the Address + Pharmacy form (or publish a new bundle)
3. Copy the **form bundle link** from the published card (path looks like `/forms/<id>` on `ispry.akutehealth.com`)
4. Either set Vercel `AKUTE_FORMS_URL` to that link (Production + Preview), or update `DEFAULT_FORMS_URL` in `api/handoff.js`
5. Re-check `?check=1` until `forms_url` matches

Prefer the **ispry** subdomain over `glptennessee.akutehealth.com` for patient-facing iSpry links.

## Attach forms to self-scheduling (optional)

In Akute: **Settings → Appointment Types** → edit the visit type → Custom Patient Email → paste the form bundle link → Save.

## Verify

1. On ispry.ai, finish a Spry intake until the handoff form
2. Submit identifiers (TN + telehealth consent)
3. Browser should open **forms** first, with booking as a secondary CTA
4. Akute chart shows a new **iSpry intake review** task for the physician
