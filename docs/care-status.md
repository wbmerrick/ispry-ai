# Stale-review alerts and patient status email

Two server jobs, both PHI-free. Resend has no BAA, so an email is a fixed sentence plus a link to sign in at `https://ispry.ai/member.html`. It never includes a symptom, a medication name, a diagnosis, a pharmacy drug name, or the text of an Akute task.

There is no Twilio client in this repo, so the physician alert is email only. The optional SMS checkbox on the intake form is consent for texts. That answer is stored only inside the Akute task. It is not an email preference, and these messages do not read it. There is no stored email opt-out. Status mail is sent to the account email.

## What the patient receives

| When | Email |
| --- | --- |
| A member visit is filed, a member request is filed, or Stripe records a visit or linked membership payment | We received your request |
| The physician marks the iSpry task completed in Akute | Your physician has reviewed your request |
| Akute reports a prescription status of sent, verified, or filled | A prescription was sent to your pharmacy |

A visit or membership that still has to be paid is recorded, but the review clock and the "received" email start at payment. A membership checkout that did not come from an intake (no Akute patient id on the Checkout session, and no waiting intake for that email) does not open a review row.

The payment receipt email is unchanged and still goes out on its own.

## What the physician receives

`GET /api/stale-queue` runs from the Vercel cron in `vercel.json` every 15 minutes. It finds queue rows that are `queued` and older than `STALE_QUEUE_MINUTES` (default 60). One email to `NOTIFY_TO` says how many requests are waiting and the threshold in minutes. It does not name the patient.

The same row is not included again until `STALE_ALERT_WINDOW_MINUTES` has passed (default: the same value as the threshold). A failed send clears the claim so the next run can try again. A second cron overlapping the first cannot claim a row the first run already claimed.

Marking the task completed, cancelling it, or sending a prescription removes the row from the sweep.

## Env vars

Set these in the Vercel project (Production). Do not commit the values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | Yes, for the cron | Random string, at least 32 characters. Vercel sends it as `Authorization: Bearer …` on the cron request. Until it is set, `/api/stale-queue` returns 503. |
| `STALE_QUEUE_MINUTES` | No | Minutes before an unreviewed paid or submitted request is alerted. Default 60. Whole minutes from 1 to 10080. Anything else uses 60. |
| `STALE_ALERT_WINDOW_MINUTES` | No | How long before the same request can raise the alert again. Default: `STALE_QUEUE_MINUTES`. |
| `AKUTE_WEBHOOK_SECRET` | Yes, for status mail after review | Signing secret for the Akute webhook endpoint. Tasks and medications should use this same secret. |
| `AKUTE_MEDICATION_WEBHOOK_SECRET` | No | Only if Akute issued a different secret for the medications webhook. |
| `RESEND_API_KEY` | Yes, to send | Already used for other mail. Patient status mail uses this and `NOTIFY_FROM`. |
| `NOTIFY_TO` | Yes, for the physician alert | Already used. Comma-separated. The stale alert goes here. |
| `NOTIFY_FROM` | Recommended | Already used. Example: `iSpry <notify@ispry.ai>` after the domain is verified in Resend. |
| `SUPABASE_URL` | Yes, to remember state | Already used. Defaults to the iSpry project URL when unset. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes, to remember state | Already used. Server only. Without it, nothing is queued and no status mail is sent, so a retry cannot be deduped. |

`GET /api/health` reports `cron_secret` and `akute_webhook_secret` as booleans. It does not return the values.

A 15-minute cron needs a Vercel plan that allows that schedule. Hobby projects only allow a daily cron; if the deploy rejects `*/15 * * * *`, the plan is Hobby and the schedule in `vercel.json` has to be widened before the alert can run inside an hour.

The Vercel firewall rate limit of 60 requests per minute per IP on `/api/*` does not need a change for this volume. Do not add these paths to the uptime probe. The cron and the webhook are authenticated, and the probe would get 401 or 503.

## Migration

Run `supabase/migrations/20261128190000_ispry_review_queue.sql` once in the Supabase SQL editor for project `jodcpflzbmhnnivtwghw`.

1. Open the [SQL editor](https://supabase.com/dashboard/project/jodcpflzbmhnnivtwghw/sql/new).
2. Paste the migration file and run it.
3. Confirm `public.ispry_review_queue` and `public.ispry_status_notices` exist, RLS is enabled, and `anon` / `authenticated` have no privileges and no policies.

The statements are safe to run again. The tables hold an email and opaque ids (queue id, Akute patient id, Akute task id, Stripe event id). They do not hold task text or a drug name. `ispry_status_notices` is the claim that a given "received", "reviewed", or "prescription sent" email was sent. The claim is removed if Resend does not accept the message, so a retry can send it. A second delivery of the same key does not send again.

Service role bypasses RLS. Do not add a browser policy on these tables.

## Akute webhook setup

Akute documents task webhooks (`create` and `update`) and medication webhooks (`update`: sending → sent → verified → filled). Signature header: `x-akute-signature: t=<unix>,v1=<hex>`. The hex is HMAC-SHA256 of `timestamp + "." + raw request body`, using the webhook secret. The route also accepts a compact JSON re-serialization, which is what Akute's own sample computes after parsing the body. Timestamps more than 5 minutes off are rejected.

Do this in the Akute account that already has `AKUTE_API_KEY` (a developer plan is required for webhooks; the API key means that plan is likely already on):

1. Sign in at [app.akutehealth.com/login](https://app.akutehealth.com/login).
2. Open **Settings → Developer**.
3. Under **Notifications**, add a webhook.
4. Resource: **Tasks**. Event: **update**. URL: `https://ispry.ai/api/akute-webhook`.
5. Add a second webhook. Resource: **Medications**. Event: **update**. Same URL.
6. Reveal each webhook secret. Put the tasks secret in Vercel as `AKUTE_WEBHOOK_SECRET` (Production, and Preview if you want to test there). If the medications secret is different, also set `AKUTE_MEDICATION_WEBHOOK_SECRET`. Prefer one shared secret when Akute lets you choose it.
7. Redeploy so the function sees the new env vars. `GET /api/akute-webhook` should show `webhook_secret_configured: true` and nothing else sensitive. `GET /api/health` should show `akute_webhook_secret: true`.
8. Do not subscribe this URL to medication history, prior auth, or pharmacy-adherence webhooks. Those payloads contain drug names. This route ignores them, and it is better if Akute never sends them.

When the plan is ready, mark the **iSpry intake** task or the **iSpry member request** task **completed** in Akute. That is the "reviewed" signal, and only that stored task id counts. Completing or cancelling a different task does not change the request. Cancelling the stored task stops the stale alert and does not send the "plan ready" email. A prescription status of **sent**, **verified**, or **filled** sends the pharmacy email (no drug name) and, if the request was still open, also sends the reviewed email once.

The route answers 400 when the signature is wrong. It answers 500 when the status email could not be sent or Supabase could not be reached, so Akute retries. A missing table does not retry forever. It answers 200 when the event is ignored or already handled.

## Manual check

After the migration and the env vars are in place:

1. File a member request or pay a visit, then confirm one "we received your request" email. A second Stripe delivery of the same event does not send it again.
2. Leave the Akute task open past the threshold. The next cron sends one physician email with a count. The following cron, inside the escalation window, does not send another.
3. Complete the task. The patient gets the reviewed email, and the request drops out of the sweep.
4. Send a non-controlled prescription to the pharmacy from Akute. The patient gets the pharmacy email. The message does not name the drug.
