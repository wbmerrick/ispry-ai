# Ineligible visit refunds

When a physician marks a recorded visit ineligible, the server acts immediately. A $49 one-time visit is refunded. A visit covered by the $100 membership is not.

Public pages keep both facts together: the $49 visit fee is refunded as soon as that request is found ineligible, and an included membership visit does not refund the $100. Cancellation of a membership still has no partial-month refund.

## Who can mark a visit ineligible

`POST /api/review` with `{ "id": "<uuid>", "decision": "ineligible" }`.

The caller must be a confirmed Supabase session, and one of:

- `app_metadata.role` is `physician` or `admin` (set in the Supabase dashboard, not by the user), or
- the confirmed email is listed in `PHYSICIAN_EMAILS` (comma-separated).

Anyone else gets `403`. A missing session gets `401`. The browser must send an allowlisted `Origin`, the same rule as the other patient routes.

`GET /api/review` lists recent rows for that same physician session: id, plan, source, amount, decision, refund status, refund id, and created time. It does not return the patient email. `GET /api/review?check=1` reports whether Stripe, the service role, and `PHYSICIAN_EMAILS` are set. It does not return those values.

The Akute task for a paid visit, an included member visit, or a member-page request includes `Ineligibility review id: <uuid>`. That id is what the physician sends. It is not a clinical note.

## $49 one-time visits

`checkout.session.completed` with `mode=payment` inserts `ispry_requests` (plan `visit`). The row stores the checkout id, payment intent, customer id, amount, account email, and Akute patient id when those values match the expected id shapes. Stripe metadata is not copied, so a condition never lands in this table.

Marking that row ineligible calls the Stripe Refunds API:

- amount `4900` cents
- `payment_intent` (or the charge id if that is all the row has)
- reason `requested_by_customer`
- metadata `ispry_request_id` set to the row id
- `Idempotency-Key: ineligible-refund-<request uuid>`

A retry uses the same key, so Stripe returns the original refund instead of creating a second one. If the row is already `succeeded` with a refund id, Stripe is not called again. The refund id and status are saved on the row. An audit row is written to `ispry_audit_log`.

The patient email says the $49 visit fee refund was issued. It has no symptoms, no names, and no reason. Resend idempotency key: `patient-refund/<request uuid>`.

If Stripe, the store, or the patient email fails, the failure is logged with the review id and a short result code, and `NOTIFY_TO` gets an email with the same code. That email has no patient details. The API response is `502` or `503` when the refund did not happen, so the physician sees it in the client as well.

A visit whose amount is not 4900 cents, or that has no payment intent and no charge, is not refunded. The row is `needs_review` and the physician is emailed to check Stripe by hand.

## $100 membership visits

Included member visits (`after: "book"` on handoff) and member-page requests (refill, follow-up, question) insert a row with plan `membership`. The message text is not stored.

This codebase does not keep a visit-credit balance. `VISIT_CAP` is compared with Akute appointments for the current month (`visitsThisMonth`). A cancelled or no-show appointment is already excluded from that count. There is no stored credit to put back, and the server does not cancel an appointment on its own.

Marking a membership row ineligible therefore:

- does not call Stripe
- does not refund the subscription
- sets `refund_status` to `member_flagged`
- writes an audit row (`member_no_credit_ledger`)
- emails the physician that no credit was restored and that an appointment should be cancelled in the chart if it should not count

The patient is not told that a refund was issued.

## Webhook reconciliation

`charge.refunded` still files the existing Akute task. It also looks up `ispry_requests` by the refund metadata request id, the charge id, or the payment intent. A match updates `refund_id`, `refund_status` (`succeeded` or `partial`), and the charge id, then writes `refund_reconciled`.

The patient refund email is sent from the webhook only when the row was already marked ineligible, the refund is complete, and `refund_email_sent_at` is empty. A partial refund does not send that email. A refund that does not match a row does not create one. Marking the same visit ineligible again does not create a second Stripe refund. If that patient email never went out, the retry sends it.

`refund.failed` marks the visit `failed` even when it was already recorded as succeeded, files the usual chart task, and emails the physician. The patient is not told the fee was returned.

A refund still does not cancel a membership or change `ispry_memberships`.

## Tables and RLS

Migration: `supabase/migrations/20261128180000_ispry_refunds.sql`.

Run it in the Supabase SQL editor for project `jodcpflzbmhnnivtwghw`. It is safe to re-run.

- `public.ispry_requests` — one row per paid visit or covered member visit. Service role may select, insert, and update.
- `public.ispry_audit_log` — append-only. Service role may select and insert.

Both tables enable row level security. `public`, `anon`, and `authenticated` have no grants and no policies, so the browser cannot read or write them. The API uses `SUPABASE_SERVICE_ROLE_KEY` after the physician check. The service role bypasses RLS.

## Environment

Set these on the Vercel project. Do not commit the values.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Already used for caps and membership. Required to store refund rows. |
| `STRIPE_SECRET_KEY` | Restricted key. Add **Refunds: Write** next to the existing Customers and Subscriptions access. |
| `PHYSICIAN_EMAILS` | Sign-in emails allowed to call `/api/review`, if `app_metadata.role` is not set. |
| `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM` | Patient refund mail and physician failure mail. |

Until the migration has been run, a paid visit still files the Akute task. The physician gets an email that the refund row was not stored. Automatic refund cannot run for that visit.

`GET /api/health` is unchanged. `GET /api/review?check=1` is the config probe for this path. It is not on the uptime workflow until this is deployed.
