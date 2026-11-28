// iSpry.ai — Stripe → Akute membership sync.
// Stripe is the membership record (who is paid up). Akute is the chart.
// Every membership event becomes a TASK on the Akute patient for the physician:
//   checkout.session.completed      → "membership ACTIVE" or one-time visit PAID
//   customer.subscription.updated   → status changes / cancel scheduled
//   customer.subscription.deleted   → "membership CANCELED"
//   invoice.payment_failed          → "payment FAILED — Stripe is retrying"
//   charge.refunded                 → refund task (full or partial), and
//                                     reconcile ispry_requests when the charge matches
//   charge.dispute.created          → dispute task, hold non-urgent care
// Membership status for benefit checks is also written to ispry_memberships
// (service role): active / trialing on checkout and invoice.paid, the Stripe
// status on subscription.updated, canceled on subscription.deleted, and
// past_due on invoice.payment_failed. A one-time visit payment does not.
// ispry_profiles stays demographics only. The condition is never sent to
// Stripe and is not put in the physician email.
// Processed event ids are stored in ispry_stripe_events when
// SUPABASE_SERVICE_ROLE_KEY is set. A missing key skips dedupe and still
// handles the event. Signature verification is unchanged.
// The Akute patient id travels as Stripe's client_reference_id on the checkout link
// (set by api/handoff.js) and is copied onto the Subscription + Customer metadata
// here, so later events can find the patient without name matching.
//
// Uses the Web signature (Request/Response) so the raw body is available for
// signature verification. No npm dependencies.
//
// Env (Vercel): STRIPE_WEBHOOK_SECRET (required), STRIPE_SECRET_KEY (restricted key:
// Subscriptions write, Customers write — optional but recommended), AKUTE_API_KEY,
// AKUTE_USER_ID.

import { createHmac, timingSafeEqual } from "node:crypto";
import { akuteConfigured, createTask, findPatientByEmail } from "./_lib/akute.js";
import { notifyPatientPayment, notifyPhysician } from "./_lib/notify.js";
import { alertRouteFailure } from "./_lib/alert.js";
import { rememberStripeEvent, stripeEventAlreadyProcessed } from "./_lib/stripe-events.js";
import { notePayment } from "./_lib/care-flow.js";
import { stripeExternalKey } from "./_lib/care-status.js";
import { applyMembershipPatch, eventStatusAt } from "./_lib/membership.js";
import { physicianReconcileFailureText, physicianStoreFailureText, reconcileRefundedCharge, recordPaidVisit, recordRefundFailed, reviewChartLine } from "./_lib/refund.js";

const TOLERANCE_SEC = 300;
const STRIPE_API = "https://api.stripe.com/v1";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>] — HMAC-SHA256 over `${t}.${rawBody}`. */
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(header || "").split(",").map((s) => s.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !/^\d+$/.test(t) || !sigs.length) return { ok: false, reason: "malformed_header" };
  if (Math.abs(nowSec - Number(t)) > TOLERANCE_SEC) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const exp = Buffer.from(expected, "utf8");
  const match = sigs.some((s) => {
    const got = Buffer.from(s, "utf8");
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
  return match ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

const safeRef = (s) => (/^[A-Za-z0-9_-]{1,200}$/.test(String(s || "")) ? String(s) : "");
const money = (cents, cur) =>
  typeof cents === "number" ? `$${(cents / 100).toFixed(2)} ${String(cur || "usd").toUpperCase()}` : "";
const when = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");
// Newer API versions keep period bounds on the subscription items, older ones on the subscription.
const periodEnd = (sub) => sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || 0;

async function stripe(path, form) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  const r = await fetch(STRIPE_API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!r.ok) throw new Error(`Stripe ${path} -> ${r.status}`);
  return r.json();
}

async function stripeGetCharge(chargeId) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  const id = safeRef(chargeId);
  if (!key || !id.startsWith("ch_")) return null;
  try {
    const r = await fetch(`${STRIPE_API}/charges/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const REFUND_FAIL_RE = /^(lost_or_stolen_card|expired_or_canceled_card|charge_for_pending_refund_disputed|insufficient_funds|declined|merchant_request|unknown)$/;
const DISPUTE_REASONS = new Set([
  "bank_cannot_process",
  "check_returned",
  "credit_not_processed",
  "customer_initiated",
  "debit_not_authorized",
  "duplicate",
  "fraudulent",
  "general",
  "incorrect_account_details",
  "insufficient_funds",
  "product_not_received",
  "product_unacceptable",
  "subscription_canceled",
  "unrecognized",
]);

function disputeReason(raw) {
  const s = String(raw || "");
  return DISPUTE_REASONS.has(s) ? s : "unspecified";
}

/** visit / membership only. Any other metadata value is ignored so a condition cannot leak into the task title. */
function idOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.id === "string") return value.id;
  return "";
}

function invoiceSubscriptionId(obj) {
  return idOf(obj?.subscription)
    || idOf(obj?.subscription_details?.subscription)
    || idOf(obj?.parent?.subscription_details?.subscription);
}

/** Status row for ispry_memberships. Null when the event has no usable status. */
function membershipPatch(fields) {
  const status = String(fields.status || "");
  if (!/^[a-z_]{1,32}$/.test(status)) return null;
  const patch = { status };
  if (fields.email) patch.email = fields.email;
  if (typeof fields.customer === "string" && fields.customer) patch.stripe_customer_id = fields.customer;
  if (typeof fields.subscription === "string" && fields.subscription) patch.stripe_subscription_id = fields.subscription;
  if (typeof fields.cancel_at_period_end === "boolean") patch.cancel_at_period_end = fields.cancel_at_period_end;
  if (fields.periodEnd) patch.current_period_end = new Date(fields.periodEnd * 1000).toISOString();
  return patch;
}

function planLabel(meta) {
  if (meta?.ispry_plan === "visit") return "one-time visit";
  if (meta?.ispry_plan === "membership") return "membership";
  return "payment";
}

function customerWrite(customerId, form) {
  const id = safeRef(customerId);
  if (!id) return null;
  return { path: `/customers/${id}`, form };
}

function subscriptionWrite(subscriptionId, form) {
  const id = safeRef(subscriptionId);
  if (!id) return null;
  return { path: `/subscriptions/${id}`, form };
}

/**
 * Pure description of what an event should do. No network, no PHI beyond the
 * payment email the Akute task already records for other Stripe events.
 * Returns { skipped } or { title, lines, tags, priority, email, patientHint, writes }.
 */
export function planStripeEvent(event, extra = {}) {
  const obj = event?.data?.object || {};
  const prev = event?.data?.previous_attributes || {};
  let title = "";
  let lines = [];
  let tags = ["iSpry", "membership", "stripe"];
  let priority = "p2";
  let email = "";
  let patientHint = "";
  let patientMail = null;
  let membership = null;
  let review = null;
  const writes = [];

  switch (event?.type) {
    case "checkout.session.completed": {
      if (obj.mode === "payment") {
        email = obj.customer_details?.email || obj.customer_email || "";
        patientHint = obj.client_reference_id || "";
        const ref = safeRef(patientHint);
        const write = ref ? customerWrite(obj.customer, { "metadata[akute_patient_id]": ref, "metadata[ispry_plan]": "visit" }) : null;
        if (write) writes.push(write);
        title = "iSpry one-time visit PAID — not a membership";
        tags = ["iSpry", "visit", "stripe", "paid"];
        if (email) patientMail = { to: email, plan: "visit", amount: money(obj.amount_total, obj.currency) };
        review = { kind: "visit", createIfMissing: true };
        lines = [
          "One-time visit payment received through Stripe Checkout. This is not a membership.",
          `Amount: ${money(obj.amount_total, obj.currency)} once.`,
          `Stripe customer: ${obj.customer || "n/a"}.`,
          `Email on payment: ${email || "n/a"}.`,
          "Next step: physician review of the Spry intake task on this patient; send Rx when appropriate.",
          "The patient may upgrade to membership later. Do not mark them as an active member from this payment.",
        ];
        break;
      }
      if (obj.mode !== "subscription") return { skipped: "not_subscription" };
      email = obj.customer_details?.email || obj.customer_email || "";
      patientHint = obj.client_reference_id || "";
      if (email) patientMail = { to: email, plan: "membership", amount: money(obj.amount_total, obj.currency) };
      const ref = safeRef(patientHint);
      review = { kind: "membership", createIfMissing: Boolean(ref) };
      if (ref) {
        const sub = subscriptionWrite(obj.subscription, { "metadata[akute_patient_id]": ref });
        const cus = customerWrite(obj.customer, { "metadata[akute_patient_id]": ref });
        if (sub) writes.push(sub);
        if (cus) writes.push(cus);
      }
      const pay = obj.payment_status;
      membership = membershipPatch({
        status: pay === "no_payment_required" ? "trialing" : pay === "unpaid" ? "incomplete" : "active",
        email,
        customer: obj.customer,
        subscription: obj.subscription,
        cancel_at_period_end: false,
      });
      title = "iSpry membership ACTIVE — paid via Stripe";
      tags.push("active");
      lines = [
        "Membership payment received through Stripe Checkout.",
        `Amount: ${money(obj.amount_total, obj.currency)} / month.`,
        `Stripe customer: ${obj.customer || "n/a"}. Subscription: ${obj.subscription || "n/a"}.`,
        `Email on payment: ${email || "n/a"}.`,
        "Next step: physician review of the Spry intake task on this patient; send Rx when appropriate.",
      ];
      break;
    }
    case "customer.subscription.updated": {
      patientHint = obj.metadata?.akute_patient_id || "";
      const statusChanged = typeof prev.status === "string" && prev.status !== obj.status;
      const cancelScheduled = prev.cancel_at_period_end === false && obj.cancel_at_period_end === true;
      const cancelUndone = prev.cancel_at_period_end === true && obj.cancel_at_period_end === false;
      if (!statusChanged && !cancelScheduled && !cancelUndone) return { skipped: "no_meaningful_change" };
      membership = membershipPatch({
        status: obj.status,
        customer: obj.customer,
        subscription: obj.id,
        cancel_at_period_end: obj.cancel_at_period_end === true,
        periodEnd: periodEnd(obj),
      });
      if (cancelScheduled) {
        title = `iSpry membership — cancellation scheduled for ${when(periodEnd(obj)) || "period end"}`;
        tags.push("cancel-scheduled");
        lines = ["Patient chose to cancel at the end of the current period (Stripe customer portal).", `Access continues through ${when(periodEnd(obj)) || "period end"}.`];
      } else if (cancelUndone) {
        title = "iSpry membership — cancellation reversed, membership continues";
        tags.push("active");
        lines = ["Patient reversed a scheduled cancellation. Membership continues."];
      } else {
        const bad = ["past_due", "unpaid", "canceled", "incomplete_expired", "paused"].includes(obj.status);
        title = `iSpry membership status: ${String(obj.status).toUpperCase()} (was ${prev.status})`;
        tags.push(bad ? "inactive" : "active");
        if (bad) priority = "p1";
        lines = [`Stripe subscription status changed from ${prev.status} to ${obj.status}.`, bad ? "Treat as NOT an active member until Stripe shows active again." : "Member is active."];
      }
      lines.push(`Stripe customer: ${obj.customer || "n/a"}. Subscription: ${obj.id || "n/a"}.`);
      break;
    }
    case "customer.subscription.deleted": {
      patientHint = obj.metadata?.akute_patient_id || "";
      membership = membershipPatch({
        status: "canceled",
        customer: obj.customer,
        subscription: obj.id,
        cancel_at_period_end: false,
        periodEnd: obj.ended_at || obj.canceled_at || 0,
      });
      title = "iSpry membership CANCELED";
      tags.push("inactive");
      lines = [
        "Stripe subscription ended. Patient is no longer an active member.",
        `Ended: ${when(obj.ended_at || obj.canceled_at) || "now"}.`,
        `Stripe customer: ${obj.customer || "n/a"}. Subscription: ${obj.id || "n/a"}.`,
      ];
      break;
    }
    case "invoice.payment_failed": {
      const sd = obj.subscription_details || obj.parent?.subscription_details || {};
      patientHint = sd.metadata?.akute_patient_id || "";
      email = obj.customer_email || "";
      const failedSub = invoiceSubscriptionId(obj);
      if (failedSub) {
        membership = membershipPatch({
          status: "past_due",
          email,
          customer: obj.customer,
          subscription: failedSub,
        });
      }
      title = "iSpry membership payment FAILED — Stripe is retrying";
      tags.push("payment-failed");
      priority = "p1";
      lines = [
        `Card payment of ${money(obj.amount_due, obj.currency)} failed (attempt ${obj.attempt_count ?? "?"}).`,
        "Stripe Smart Retries will try again and email the patient to update their card.",
        "If it keeps failing the subscription moves to past_due/unpaid — hold non-urgent care until resolved.",
        `Email on file: ${email || "n/a"}. Stripe customer: ${obj.customer || "n/a"}.`,
      ];
      break;
    }
    case "charge.refunded": {
      email = obj.billing_details?.email || obj.receipt_email || "";
      patientHint = obj.metadata?.akute_patient_id || "";
      const label = planLabel(obj.metadata);
      const full = obj.refunded === true || (typeof obj.amount === "number" && obj.amount > 0 && obj.amount_refunded === obj.amount);
      title = full ? `iSpry ${label} REFUNDED` : `iSpry ${label} partially refunded`;
      tags = ["iSpry", "stripe", "refund"];
      lines = [
        full ? "Stripe refunded this charge in full." : "Stripe recorded a partial refund on this charge.",
        `Amount refunded: ${money(obj.amount_refunded, obj.currency)} of ${money(obj.amount, obj.currency)}.`,
        `Stripe customer: ${obj.customer || "n/a"}. Charge: ${obj.id || "n/a"}.`,
        `Email on payment: ${email || "n/a"}.`,
        label === "membership"
          ? "A refund does not by itself cancel the subscription. Check Stripe before treating the membership as ended."
          : "This refund does not create or cancel a membership.",
      ];
      break;
    }
    case "charge.dispute.created": {
      const charge = extra.charge || {};
      email = charge.billing_details?.email || charge.receipt_email || "";
      patientHint = charge.metadata?.akute_patient_id || "";
      title = "iSpry payment DISPUTED — hold non-urgent care";
      tags = ["iSpry", "stripe", "dispute"];
      priority = "p1";
      lines = [
        "A cardholder opened a dispute on a Stripe charge.",
        `Amount: ${money(obj.amount, obj.currency)}.`,
        `Dispute reason code: ${disputeReason(obj.reason)}.`,
        `Stripe charge: ${safeRef(obj.charge) || "n/a"}. Customer: ${charge.customer || "n/a"}.`,
        "Hold non-urgent care until this dispute is resolved in Stripe.",
        `Email on payment: ${email || "n/a"}.`,
      ];
      break;
    }
    case "refund.failed": {
      const reason = REFUND_FAIL_RE.test(String(obj.failure_reason || "")) ? obj.failure_reason : "unspecified";
      title = "iSpry visit refund FAILED";
      tags = ["iSpry", "stripe", "refund", "failed"];
      priority = "p1";
      lines = [
        "Stripe reported that a refund failed after it was created.",
        `Failure code: ${reason}.`,
        `Refund: ${safeRef(obj.id) || "n/a"}. Charge: ${safeRef(idOf(obj.charge)) || "n/a"}.`,
        "Do not treat the visit fee as returned until Stripe shows a succeeded refund.",
      ];
      break;
    }
    case "invoice.paid": {
      const subId = String(invoiceSubscriptionId(obj) || "");
      if (!subId) return { skipped: "not_subscription_invoice" };
      return {
        silent: true,
        membership: membershipPatch({
          status: "active",
          email: obj.customer_email || "",
          customer: obj.customer,
          subscription: subId,
        }),
      };
    }
    default:
      return { skipped: "unhandled_event" };
  }

  const out = { title, lines, tags, priority, email, patientHint, writes };
  if (patientMail) out.patientMail = patientMail;
  if (membership) out.membership = membership;
  if (review && email) out.review = review;
  return out;
}

/** Physician email for a Stripe task. No email address, no condition, no message text. */
export function physicianNotice(title, patientId) {
  return `${title}\n\nA task was added in Akute${patientId ? " on the patient" : " (unlinked — needs manual linking)"}. Open Akute to review.`;
}

/** Resolve the Akute patient for an event: explicit id → metadata → exact email match. */
async function resolvePatient({ patientId, email }) {
  const id = safeRef(patientId);
  if (id) return { patientId: id, how: "patient_id" };
  if (email) {
    try {
      const found = await findPatientByEmail(email);
      if (found) return { patientId: found, how: "email" };
    } catch { /* lookup is best-effort */ }
  }
  return { patientId: "", how: "unmatched" };
}

function describe(lines) {
  return lines.filter(Boolean).join("\n");
}

async function handleEvent(event) {
  const ownerId = String(process.env.AKUTE_USER_ID || "").trim();
  let charge = null;
  if (event.type === "charge.dispute.created") {
    charge = await stripeGetCharge(event.data?.object?.charge);
  }
  const plan = planStripeEvent(event, { charge });
  if (plan.membership) {
    // Order by Stripe's event time. A delayed delivery must not refresh the
    // six-hour cache with an older status.
    await applyMembershipPatch({ ...plan.membership, status_at: eventStatusAt(event?.created) });
  }
  if (plan.skipped || plan.silent) {
    return { skipped: plan.skipped || "membership_status", membership: Boolean(plan.membership) };
  }
  // Record a paid visit before the chart task so a store outage retries with
  // Stripe and does not leave a task that has no refund row. A 5xx throws.
  // A missing table is reported to the physician and does not block the task.
  let reviewId = "";
  if (event?.type === "checkout.session.completed" && event.data?.object?.mode === "payment") {
    const recorded = await recordPaidVisit(event.data.object);
    if (recorded.retry) throw new Error("request_store_unavailable");
    if (recorded.id) reviewId = recorded.id;
    else if (recorded.reason && recorded.reason !== "not_configured" && recorded.reason !== "not_a_visit") {
      await notifyPhysician({
        subject: "iSpry: visit payment was not recorded for an ineligibility refund",
        text: physicianStoreFailureText(recorded.reason),
      });
    }
  }
  if (event?.type === "refund.failed") {
    const failed = await recordRefundFailed(event.data?.object || {});
    if (failed.retry) throw new Error("refund_failed_reconcile_unavailable");
    if (failed.requestId) reviewId = failed.requestId;
    else if (failed.reason && !["no_match", "no_ids", "not_configured", "not_a_visit"].includes(failed.reason)) {
      await notifyPhysician({
        subject: "iSpry: a failed refund was not recorded",
        text: physicianReconcileFailureText(failed.reason),
      });
    }
  }
  if (event?.type === "charge.refunded") {
    const reconciled = await reconcileRefundedCharge(event.data?.object || {});
    if (reconciled.retry) throw new Error("refund_reconcile_unavailable");
    if (reconciled.requestId) reviewId = reconciled.requestId;
    else if (reconciled.reason && !["no_match", "no_ids", "not_configured"].includes(reconciled.reason)) {
      await notifyPhysician({
        subject: "iSpry: a Stripe refund was not reconciled",
        text: physicianReconcileFailureText(reconciled.reason),
      });
    }
  }
  // ispry_profiles stores name, age, sex, and Tennessee only. Subscription
  // status is in ispry_memberships. Refunds and disputes stay a physician task.
  for (const w of plan.writes || []) {
    await stripe(w.path, w.form).catch(() => null);
  }
  const { title, lines, tags, priority, email, patientHint } = plan;
  const reviewLine = reviewChartLine(reviewId);
  if (reviewLine) lines.push(reviewLine);
  const { patientId, how } = await resolvePatient({ patientId: patientHint, email });
  if (!patientId) {
    tags.push("needs-linking");
    lines.push(`No Akute patient matched (${how}). Link this manually by the email above.`);
  }
  const result = await createTask({
    title,
    description: describe(lines.concat([`Stripe event ${event.id} (${event.type}), ${new Date(event.created * 1000).toISOString()}.`])),
    patientId,
    ownerId,
    priority,
    tags,
  });
  await notifyPhysician({
    subject: `iSpry: ${title}`,
    text: [physicianNotice(title, patientId), reviewLine].filter(Boolean).join("\n\n"),
  });
  // Patient receipt. Failures stay inside notifyPatientPayment so a mail outage
  // does not make Stripe retry the chart task. The idempotency key is the event id.
  if (plan.patientMail) {
    await notifyPatientPayment({
      ...plan.patientMail,
      idempotencyKey: event?.id ? `patient-pay/${event.id}` : "",
    });
  }
  // The review clock starts at payment, not at the earlier intake. A membership
  // checkout with no chart link only wakes a request that is already waiting.
  if (plan.review) {
    await notePayment({
      email: plan.email,
      patientId,
      kind: plan.review.kind,
      createIfMissing: Boolean(plan.review.createIfMissing),
      externalKey: stripeExternalKey(event?.id),
      paidTaskId: result?.taskId || "",
    });
  }
  return { task: true, matched: how, ...result };
}

/**
 * Skip an event id we already handled, then handle, then record the id.
 * A thrown handler is not recorded, so Stripe's retry still runs.
 * deps are for tests.
 */
export async function processStripeEvent(event, deps = {}) {
  const storeOpts = deps.storeOpts;
  const seen = await (deps.already || stripeEventAlreadyProcessed)(event, storeOpts);
  if (seen.duplicate) return { received: true, duplicate: true };
  const out = await (deps.handle || handleEvent)(event);
  await (deps.remember || rememberStripeEvent)(event, storeOpts);
  return { received: true, ...out };
}

export async function GET() {
  return json({
    ok: true,
    webhook_secret_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    stripe_key_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    akute_configured: akuteConfigured() && Boolean(process.env.AKUTE_USER_ID),
  });
}

export async function POST(request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) return json({ error: "not_configured" }, 503);
  if (!akuteConfigured()) return json({ error: "akute_not_configured" }, 503);

  const raw = await request.text();
  const check = verifyStripeSignature(raw, request.headers.get("stripe-signature"), secret);
  if (!check.ok) return json({ error: "bad_signature", reason: check.reason }, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  if (!event || typeof event.type !== "string") return json({ error: "bad_event" }, 400);

  try {
    const out = await processStripeEvent(event);
    return json(out);
  } catch (e) {
    // Non-2xx makes Stripe retry later, so a transient Akute outage still ends in a task.
    // The alert carries the route and error class only — not the event body.
    console.error("stripe-webhook:", event.type, String(e?.message || e).slice(0, 200));
    await alertRouteFailure(request, { route: "stripe-webhook", error: e, status: 500 });
    return json({ error: "sync_failed" }, 500);
  }
}
