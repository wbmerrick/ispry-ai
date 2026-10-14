// iSpry.ai — Stripe → Akute membership sync.
// Stripe is the membership record (who is paid up). Akute is the chart.
// Every membership event becomes a TASK on the Akute patient for the physician:
//   checkout.session.completed      → "membership ACTIVE"
//   customer.subscription.updated   → status changes / cancel scheduled
//   customer.subscription.deleted   → "membership CANCELED"
//   invoice.payment_failed          → "payment FAILED — Stripe is retrying"
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
import { akute, akuteConfigured, createTask, findPatientByEmail } from "./_lib/akute.js";
import { notifyPhysician } from "./_lib/notify.js";

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
  const obj = event.data?.object || {};
  const prev = event.data?.previous_attributes || {};
  const ownerId = String(process.env.AKUTE_USER_ID || "").trim();
  let title = "";
  let lines = [];
  let tags = ["iSpry", "membership", "stripe"];
  let priority = "p2";
  let email = "";
  let patientHint = "";

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return { skipped: "not_subscription" };
      email = obj.customer_details?.email || obj.customer_email || "";
      patientHint = obj.client_reference_id || "";
      // Persist the chart link on Stripe so later events need no lookup.
      const ref = safeRef(patientHint);
      if (ref) {
        if (obj.subscription) await stripe(`/subscriptions/${obj.subscription}`, { "metadata[akute_patient_id]": ref }).catch(() => null);
        if (obj.customer) await stripe(`/customers/${obj.customer}`, { "metadata[akute_patient_id]": ref }).catch(() => null);
      }
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
    default:
      return { skipped: "unhandled_event" };
  }

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
    text: `${title}\n\nA task was added in Akute${patientId ? " on the patient" : " (unlinked — needs manual linking)"}. Open Akute to review.`,
  });
  return { task: true, matched: how, ...result };
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
    const out = await handleEvent(event);
    return json({ received: true, ...out });
  } catch (e) {
    // Non-2xx makes Stripe retry later, so a transient Akute outage still ends in a task.
    console.error("stripe-webhook:", event.type, String(e?.message || e).slice(0, 200));
    return json({ error: "sync_failed" }, 500);
  }
}
