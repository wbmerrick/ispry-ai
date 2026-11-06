# Akute intake setup (iSpry)

Patient path after Spry `[READY]` handoff:

1. Identifiers → Akute patient + physician task (`/api/handoff`)
2. **Forms** (demographics + pharmacy) when `AKUTE_FORMS_URL` is set
3. **Self-scheduling** at the booking link

Live clinic subdomain: [ispry.akutehealth.com](https://ispry.akutehealth.com/appointments)

## Already in code / prod

| Piece | Status |
| --- | --- |
| `AKUTE_API_KEY` + `AKUTE_USER_ID` | Required; `/api/handoff?check=1` reports `akute_configured` |
| Booking | Defaults to `https://ispry.akutehealth.com/appointments` (override with `AKUTE_BOOKING_URL`) |
| Forms bundle | Set `AKUTE_FORMS_URL` to the published form-bundle link from Akute |

Probe: `GET https://ispry.ai/api/handoff?check=1` → `forms_configured`, `booking_configured`, and the public URLs.

## Create the intake form bundle (Akute dashboard)

Clinician login: [app.akutehealth.com/login](https://app.akutehealth.com/login)

1. **Settings → Forms**
2. Create a form (scratch or template) that includes at least:
   - **Address** (demographics)
   - **Pharmacy** (required for e-prescribing)
   - Optional: Allergies, Medications, Emergency Contacts
3. **Publish Bundle** — name it e.g. `iSpry intake`
4. Copy the **form bundle link** from the published card
5. Vercel project `ispry-ai` → Environment Variables → set  
   `AKUTE_FORMS_URL` = that link (Production + Preview)
6. Optional: set `AKUTE_BOOKING_URL` = `https://ispry.akutehealth.com/appointments` if you want an explicit override of the default
7. Redeploy / wait for env to apply, then re-check `?check=1` until `forms_configured: true`

## Attach forms to self-scheduling (optional, recommended)

In Akute: **Settings → Appointment Types** → edit the iSpry visit type → Custom Patient Email → paste the same form bundle link → Save.

## Verify

1. On ispry.ai, finish a Spry intake until the handoff form
2. Submit identifiers (TN + telehealth consent)
3. Browser should open **forms** first when configured, else booking
4. Akute chart shows a new **iSpry intake review** task for the physician
