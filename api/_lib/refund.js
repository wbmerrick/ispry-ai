// Ineligibility refunds for a recorded visit.
// A physician marks ispry_requests.ineligible. A $49 one-time visit is refunded
// in Stripe with an idempotency key derived from the request id. A membership
// visit does not refund the $100 subscription: visits are counted from Akute
// appointments, and there is no credit balance to restore. That case is flagged
// to the physician. No symptoms or message text are stored or emailed.

import { randomUUID } from "node:crypto";
import { supabaseConfig } from "../auth-config.js";
import { normalizeEmail, safeCustomerId } from "./membership.js";
import { notifyPatientRefund, notifyPhysician } from "./notify.js";

export const VISIT_FEE_CENTS = 4900;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUND_STATUS = new Set(["pending", "succeeded", "failed", "partial", "member_flagged", "needs_review"]);
const ID_RE = {
  pi_: /^pi_[A-Za-z0-9_]{1,200}$/,
  ch_: /^ch_[A-Za-z0-9_]{1,200}$/,
  re_: /^re_[A-Za-z0-9_]{1,200}$/,
  cs_: /^cs_[A-Za-z0-9_]{1,200}$/,
};

const REQUEST_COLUMNS = "id,user_id,email,plan,source,amount_cents,stripe_payment_intent_id,stripe_charge_id,stripe_customer_id,decision,decided_by,refund_id,refund_status,refund_email_sent_at";
const PUBLIC_COLUMNS = "id,plan,source,amount_cents,decision,refund_status,refund_id,created_at";

export function safeRequestId(id) {
  const s = String(id || "");
  return UUID_RE.test(s) ? s : "";
}

export function safeStripeId(id, prefix) {
  const s = String(id || "");
  const re = ID_RE[prefix];
  return re && re.test(s) ? s : "";
}

export function safeCode(raw, fallback = "note") {
  const s = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(s) ? s : fallback;
}

export function refundIdempotencyKey(requestId) {
  const id = safeRequestId(requestId);
  return id ? `ineligible-refund-${id}` : "";
}

export function patientRefundIdempotencyKey(requestId) {
  const id = safeRequestId(requestId);
  return id ? `patient-refund/${id}` : "";
}

/** Chart line. The id only — no condition, no email. */
export function reviewChartLine(requestId) {
  const id = safeRequestId(requestId);
  return id ? `Ineligibility review id: ${id}.` : "";
}

export function isPhysician(user, env = process.env) {
  const email = normalizeEmail(user?.email);
  if (!safeRequestId(user?.id) || !email) return false;
  if (user.role === "physician" || user.role === "admin") return true;
  const allow = String(env?.PHYSICIAN_EMAILS || "")
    .split(",")
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  return allow.includes(email);
}

/**
 * What marking this row ineligible should do. Pure.
 * Membership never refunds, even if a payment intent was stored by mistake.
 */
export function settlementPlan(row) {
  if (!row || !safeRequestId(row.id)) return { action: "missing" };
  if (row.decision === "ineligible" && row.refund_status === "succeeded" && safeStripeId(row.refund_id, "re_")) {
    return { action: "already_refunded", refundId: safeStripeId(row.refund_id, "re_") };
  }
  if (row.decision === "ineligible" && row.refund_status === "member_flagged") {
    return { action: "already_flagged" };
  }
  if (row.plan === "membership") return { action: "flag_member" };
  if (row.plan !== "visit") return { action: "needs_review", detail: "bad_plan" };
  if (Number(row.amount_cents) !== VISIT_FEE_CENTS) return { action: "needs_review", detail: "amount_mismatch" };
  const paymentIntent = safeStripeId(row.stripe_payment_intent_id, "pi_");
  const charge = safeStripeId(row.stripe_charge_id, "ch_");
  if (!paymentIntent && !charge) return { action: "needs_review", detail: "no_charge" };
  return {
    action: "refund",
    paymentIntent,
    charge,
    idempotencyKey: refundIdempotencyKey(row.id),
  };
}

export function physicianMemberFlagText(requestId) {
  return [
    "A membership visit was marked ineligible.",
    "The $100 subscription was not refunded.",
    "Visits are counted from chart appointments, not a credit balance, so no visit credit was restored automatically.",
    `Review id: ${safeRequestId(requestId) || "unknown"}.`,
    "If an appointment should not count, cancel it in the chart.",
    "This email has no patient details.",
  ].join("\n\n");
}

export function physicianRefundFailureText(requestId, code) {
  return [
    "An ineligible one-time visit refund did not go through.",
    `Review id: ${safeRequestId(requestId) || "unknown"}.`,
    `Result: ${safeCode(code, "stripe_error")}.`,
    "The patient was not told that a refund was issued.",
    "This email has no patient details.",
  ].join("\n\n");
}

export function physicianRefundMailFailureText(requestId, reason) {
  return [
    "The visit fee refund was issued, but the patient email did not send.",
    `Review id: ${safeRequestId(requestId) || "unknown"}.`,
    `Result: ${safeCode(reason, "email_failed")}.`,
    "This email has no patient details.",
  ].join("\n\n");
}

export function physicianReconcileFailureText(reason) {
  return [
    "Stripe reported a refund, but the visit record was not updated.",
    `Result: ${safeCode(reason, "store_error")}.`,
    "This email has no patient details.",
  ].join("\n\n");
}

export function physicianStoreFailureText(reason) {
  return [
    "A visit could not be recorded for an ineligibility refund.",
    `Result: ${safeCode(reason, "store_error")}.`,
    "The chart task was still filed when this was a patient handoff. Automatic refund cannot run for that visit until the record exists.",
    "This email has no patient details.",
  ].join("\n\n");
}

export function physicianNeedsReviewText(requestId, detail) {
  return [
    "A visit was marked ineligible, but it was not refunded automatically.",
    `Review id: ${safeRequestId(requestId) || "unknown"}.`,
    `Result: ${safeCode(detail, "needs_review")}.`,
    "Check the payment in Stripe before refunding it by hand. Do not refund a membership subscription for one visit.",
    "This email has no patient details.",
  ].join("\n\n");
}

function idOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.id === "string") return value.id;
  return "";
}

function safeAkuteId(id) {
  const s = String(id || "");
  return /^[A-Za-z0-9_-]{1,200}$/.test(s) ? s : "";
}

/** Fields stored for a one-time Checkout. Metadata, including any condition, is ignored. */
export function visitRequestFromCheckout(session) {
  if (!session || session.mode !== "payment") return null;
  const amount = Number(session.amount_total);
  const amountCents = Number.isInteger(amount) && amount >= 1 && amount <= 100000 ? amount : null;
  const email = normalizeEmail(session.customer_details?.email || session.customer_email || "");
  return {
    plan: "visit",
    source: "checkout",
    amount_cents: amountCents,
    email: email || null,
    user_id: null,
    stripe_payment_intent_id: safeStripeId(idOf(session.payment_intent), "pi_") || null,
    stripe_charge_id: null,
    stripe_customer_id: safeCustomerId(idOf(session.customer)) || null,
    stripe_checkout_session_id: safeStripeId(session.id, "cs_") || null,
    akute_patient_id: safeAkuteId(session.client_reference_id) || null,
  };
}

/** Charge.refunded fields used to find a request. Description and metadata conditions are ignored. */
export function matchRefundFromCharge(charge) {
  const refunds = Array.isArray(charge?.refunds?.data) ? charge.refunds.data : [];
  const first = refunds[0] || {};
  const full = charge?.refunded === true
    || (typeof charge?.amount === "number" && charge.amount > 0 && charge.amount_refunded === charge.amount);
  return {
    chargeId: safeStripeId(charge?.id, "ch_"),
    paymentIntent: safeStripeId(idOf(charge?.payment_intent), "pi_"),
    refundId: safeStripeId(first.id, "re_"),
    requestId: safeRequestId(first.metadata?.ispry_request_id),
    refundStatus: full ? "succeeded" : "partial",
  };
}

function serviceKey(env) {
  return String(env?.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function restHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

function storeOpts(opts = {}) {
  return {
    env: opts.env || process.env,
    supabaseUrl: opts.supabaseUrl || supabaseConfig().url,
    fetchImpl: opts.fetchImpl || fetch,
  };
}

function rowFromDb(row) {
  if (!row || typeof row !== "object") return null;
  const id = safeRequestId(row.id);
  const plan = row.plan === "visit" || row.plan === "membership" ? row.plan : "";
  if (!id || !plan) return null;
  const amount = Number(row.amount_cents);
  return {
    id,
    user_id: safeRequestId(row.user_id),
    email: normalizeEmail(row.email),
    plan,
    source: row.source === "checkout" || row.source === "handoff" || row.source === "member" ? row.source : "",
    amount_cents: Number.isInteger(amount) ? amount : null,
    stripe_payment_intent_id: safeStripeId(row.stripe_payment_intent_id, "pi_"),
    stripe_charge_id: safeStripeId(row.stripe_charge_id, "ch_"),
    stripe_customer_id: safeCustomerId(row.stripe_customer_id),
    decision: row.decision === "ineligible" ? "ineligible" : "",
    refund_id: safeStripeId(row.refund_id, "re_"),
    refund_status: REFUND_STATUS.has(row.refund_status) ? row.refund_status : "",
    refund_email_sent_at: row.refund_email_sent_at || "",
  };
}

async function rest(path, init, opts) {
  const { env, supabaseUrl, fetchImpl } = storeOpts(opts);
  const key = serviceKey(env);
  if (!key) return { ok: false, reason: "not_configured", status: 0, data: null };
  try {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: restHeaders(key, init.headers || {}),
    });
    const data = await r.json().catch(() => null);
    if (r.status >= 500) return { ok: false, reason: `http_${r.status}`, retry: true, status: r.status, data };
    if (!r.ok) return { ok: false, reason: `http_${r.status}`, status: r.status, data };
    return { ok: true, status: r.status, data };
  } catch {
    return { ok: false, reason: "unreachable", retry: true, status: 0, data: null };
  }
}

function storeFailure(reason, retry = false) {
  const err = new Error(safeCode(reason, "store_error"));
  err.code = err.message;
  err.retry = Boolean(retry);
  return err;
}

export async function loadRequest(id, opts = {}) {
  const requestId = safeRequestId(id);
  if (!requestId) return null;
  if (!serviceKey(storeOpts(opts).env)) throw storeFailure("not_configured");
  const got = await rest(
    `ispry_requests?id=eq.${requestId}&select=${REQUEST_COLUMNS}&limit=1`,
    { method: "GET" },
    opts,
  );
  if (!got.ok) throw storeFailure(got.reason, got.retry);
  const rows = Array.isArray(got.data) ? got.data : [];
  return rowFromDb(rows[0]);
}

export async function updateRequest(id, patch, opts = {}) {
  const requestId = safeRequestId(id);
  if (!requestId) {
    const err = new Error("bad_request");
    err.code = "bad_request";
    throw err;
  }
  const body = { updated_at: new Date().toISOString() };
  if (patch.decision === "ineligible") body.decision = "ineligible";
  if (patch.decided_at) body.decided_at = patch.decided_at;
  if (safeRequestId(patch.decided_by)) body.decided_by = safeRequestId(patch.decided_by);
  if (patch.refund_id === null) body.refund_id = null;
  else if (safeStripeId(patch.refund_id, "re_")) body.refund_id = safeStripeId(patch.refund_id, "re_");
  if (REFUND_STATUS.has(patch.refund_status)) body.refund_status = patch.refund_status;
  if (patch.refund_email_sent_at) body.refund_email_sent_at = patch.refund_email_sent_at;
  if (safeStripeId(patch.stripe_charge_id, "ch_")) body.stripe_charge_id = safeStripeId(patch.stripe_charge_id, "ch_");
  const got = await rest(`ispry_requests?id=eq.${requestId}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  }, opts);
  if (!got.ok) {
    const err = new Error(got.reason || "store_error");
    err.code = safeCode(got.reason, "store_error");
    err.retry = Boolean(got.retry);
    throw err;
  }
  const rows = Array.isArray(got.data) ? got.data : [];
  return rowFromDb(rows[0]) || { id: requestId };
}

export async function writeAudit(entry, opts = {}) {
  const requestId = safeRequestId(entry?.requestId);
  const action = safeCode(entry?.action, "");
  if (!requestId || !action) return { saved: false, reason: "bad_audit" };
  const { env } = storeOpts(opts);
  if (!serviceKey(env)) return { saved: false, reason: "not_configured" };
  const body = {
    request_id: requestId,
    actor_id: safeRequestId(entry.actorId) || null,
    action,
    detail: entry.detail ? safeCode(entry.detail, "note") : null,
    stripe_refund_id: safeStripeId(entry.refundId, "re_") || null,
  };
  const got = await rest("ispry_audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body),
  }, opts);
  if (!got.ok) {
    console.error("refund audit", requestId, safeCode(got.reason, "store_error"));
    return { saved: false, reason: safeCode(got.reason, "store_error") };
  }
  return { saved: true };
}

async function findByColumn(column, value, opts) {
  const got = await rest(
    `ispry_requests?${column}=eq.${encodeURIComponent(value)}&select=id&limit=1`,
    { method: "GET" },
    opts,
  );
  if (!got.ok) return { id: "", retry: Boolean(got.retry), reason: got.reason || "store_error" };
  const rows = Array.isArray(got.data) ? got.data : [];
  return { id: safeRequestId(rows[0]?.id), retry: false };
}

async function insertRequest(row, opts) {
  const { env } = storeOpts(opts);
  if (!serviceKey(env)) return { saved: false, reason: "not_configured" };
  const got = await rest("ispry_requests", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  }, opts);
  if (got.status === 409) {
    const column = row.stripe_checkout_session_id ? "stripe_checkout_session_id" : "";
    const value = row.stripe_checkout_session_id || "";
    if (!column) return { saved: false, reason: "conflict" };
    const existing = await findByColumn(column, value, opts);
    if (existing.retry) return { saved: false, reason: safeCode(existing.reason, "store_error"), retry: true };
    if (existing.id) return { saved: true, id: existing.id, duplicate: true };
    return { saved: false, reason: "conflict" };
  }
  if (!got.ok) return { saved: false, reason: safeCode(got.reason, "store_error"), retry: Boolean(got.retry) };
  const saved = Array.isArray(got.data) ? got.data[0] : got.data;
  const id = safeRequestId(saved?.id) || safeRequestId(row.id);
  return id ? { saved: true, id } : { saved: false, reason: "bad_response" };
}

export async function recordPaidVisit(session, opts = {}) {
  const draft = visitRequestFromCheckout(session);
  if (!draft) return { saved: false, reason: "not_a_visit" };
  if (!draft.stripe_checkout_session_id) return { saved: false, reason: "bad_session" };
  const id = safeRequestId(opts.id) || randomUUID();
  const recorded = await insertRequest({ ...draft, id }, opts);
  if (!recorded.saved && recorded.reason && recorded.reason !== "not_configured") {
    console.error("visit record", recorded.reason);
  }
  return recorded;
}

export async function recordCoveredVisit({ userId, email, source } = {}, opts = {}) {
  const src = source === "member" || source === "handoff" ? source : "";
  const normalized = normalizeEmail(email);
  if (!src || !normalized) return { saved: false, reason: "bad_row" };
  const id = safeRequestId(opts.id) || randomUUID();
  const recorded = await insertRequest({
    id,
    user_id: safeRequestId(userId) || null,
    email: normalized,
    plan: "membership",
    source: src,
    amount_cents: null,
  }, opts);
  if (!recorded.saved && recorded.reason && recorded.reason !== "not_configured") {
    console.error("member visit record", recorded.reason);
  }
  return recorded;
}

export async function listRequests(opts = {}) {
  const { env } = storeOpts(opts);
  if (!serviceKey(env)) return { requests: [], reason: "not_configured" };
  const got = await rest(
    `ispry_requests?select=${PUBLIC_COLUMNS}&order=created_at.desc&limit=30`,
    { method: "GET" },
    opts,
  );
  if (!got.ok) return { requests: [], reason: safeCode(got.reason, "store_error"), retry: Boolean(got.retry) };
  const rows = Array.isArray(got.data) ? got.data : [];
  return {
    requests: rows.map((row) => ({
      id: safeRequestId(row.id),
      plan: row.plan === "visit" || row.plan === "membership" ? row.plan : "",
      source: row.source === "checkout" || row.source === "handoff" || row.source === "member" ? row.source : "",
      amount_cents: Number.isInteger(Number(row.amount_cents)) ? Number(row.amount_cents) : null,
      decision: row.decision === "ineligible" ? "ineligible" : null,
      refund_status: REFUND_STATUS.has(row.refund_status) ? row.refund_status : null,
      refund_id: safeStripeId(row.refund_id, "re_") || null,
      created_at: row.created_at || null,
    })).filter((row) => row.id),
  };
}

async function findRequestForRefund(match, opts) {
  if (match.requestId) {
    const row = await loadRequest(match.requestId, opts);
    if (row) return row;
  }
  const filters = [];
  if (match.chargeId) filters.push(`stripe_charge_id.eq.${match.chargeId}`);
  if (match.paymentIntent) filters.push(`stripe_payment_intent_id.eq.${match.paymentIntent}`);
  if (!filters.length) return null;
  const query = filters.length === 1
    ? `${filters[0]}`
    : `or=(${filters.join(",")})`;
  const got = await rest(
    `ispry_requests?${query}&select=${REQUEST_COLUMNS}&limit=1`,
    { method: "GET" },
    opts,
  );
  if (!got.ok) throw storeFailure(got.reason, got.retry);
  const rows = Array.isArray(got.data) ? got.data : [];
  return rowFromDb(rows[0]);
}

function mergedStatus(current, incoming) {
  if (current === "succeeded") return "succeeded";
  if (current === "member_flagged") return "member_flagged";
  return incoming === "partial" ? "partial" : "succeeded";
}

/**
 * Apply a charge.refunded event onto a stored visit. Does not create a refund.
 * Sends the patient email only when the physician already marked it ineligible,
 * the refund is complete, and that email has not been recorded yet.
 */
export async function reconcileRefundedCharge(charge, opts = {}) {
  const match = matchRefundFromCharge(charge);
  if (!match.chargeId && !match.paymentIntent && !match.requestId) return { matched: false, reason: "no_ids" };
  let row;
  try {
    row = await findRequestForRefund(match, opts);
  } catch (e) {
    console.error("refund reconcile", safeCode(e?.code, "store_error"));
    return { matched: false, reason: safeCode(e?.code, "store_error"), retry: Boolean(e?.retry) };
  }
  if (!row) return { matched: false, reason: "no_match" };
  const status = mergedStatus(row.refund_status, match.refundStatus);
  const refundId = match.refundId || row.refund_id || "";
  try {
    await updateRequest(row.id, {
      refund_status: status,
      refund_id: refundId || undefined,
      stripe_charge_id: match.chargeId || undefined,
    }, opts);
  } catch (e) {
    console.error("refund reconcile", row.id, safeCode(e?.code, "store_error"));
    return { matched: true, requestId: row.id, reason: safeCode(e?.code, "store_error"), retry: Boolean(e?.retry) };
  }
  await writeAudit({
    requestId: row.id,
    action: "refund_reconciled",
    detail: status === "partial" ? "partial" : "succeeded",
    refundId,
  }, opts);
  let emailSent = Boolean(row.refund_email_sent_at);
  if (status === "succeeded" && row.decision === "ineligible" && row.plan === "visit" && !emailSent) {
    const mailed = await (opts.notifyPatient || notifyPatientRefund)({
      to: row.email,
      idempotencyKey: patientRefundIdempotencyKey(row.id),
    });
    if (mailed?.sent) {
      emailSent = true;
      try {
        await updateRequest(row.id, { refund_email_sent_at: new Date().toISOString() }, opts);
      } catch (e) {
        console.error("refund reconcile mail stamp", row.id, safeCode(e?.code, "store_error"));
      }
    } else if (mailed?.reason && mailed.reason !== "not_configured") {
      console.error("refund reconcile mail", row.id, safeCode(mailed.reason, "email_failed"));
      await (opts.notifyPhysician || notifyPhysician)({
        subject: "iSpry: visit refund email did not send",
        text: physicianRefundMailFailureText(row.id, mailed.reason),
      });
    }
  }
  return { matched: true, requestId: row.id, refundStatus: status, emailSent };
}

export async function createStripeRefund({ paymentIntent, charge, requestId, idempotencyKey, env, fetchImpl } = {}) {
  const key = String((env || process.env).STRIPE_SECRET_KEY || "").trim();
  const idem = String(idempotencyKey || "");
  if (!key) {
    const err = new Error("stripe_not_configured");
    err.code = "stripe_not_configured";
    throw err;
  }
  if (!idem || idem !== refundIdempotencyKey(requestId)) {
    const err = new Error("bad_idempotency_key");
    err.code = "bad_idempotency_key";
    throw err;
  }
  const body = new URLSearchParams();
  if (paymentIntent) body.set("payment_intent", paymentIntent);
  else body.set("charge", charge);
  body.set("amount", String(VISIT_FEE_CENTS));
  body.set("reason", "requested_by_customer");
  body.set("metadata[ispry_request_id]", safeRequestId(requestId));
  const fetchFn = fetchImpl || fetch;
  let response;
  try {
    response = await fetchFn("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idem,
      },
      body: body.toString(),
    });
  } catch {
    const err = new Error("stripe_unreachable");
    err.code = "stripe_unreachable";
    throw err;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = safeCode(data?.error?.code, `stripe_${response.status}`);
    if (code === "charge_already_refunded") {
      return { alreadyRefunded: true, id: "", status: "succeeded", charge: "" };
    }
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  const status = data.status === "succeeded" || data.status === "pending" || data.status === "failed"
    ? data.status
    : "pending";
  const id = safeStripeId(data.id, "re_");
  if (!id) {
    const err = new Error("bad_refund_id");
    err.code = "bad_refund_id";
    throw err;
  }
  return { id, status, charge: safeStripeId(data.charge, "ch_") };
}

async function auditOrNote(deps, entry) {
  try {
    const saved = await deps.audit(entry);
    if (saved && saved.saved === false && saved.reason !== "not_configured") {
      console.error("refund audit", safeRequestId(entry.requestId), safeCode(saved.reason, "store_error"));
    }
    return saved;
  } catch (e) {
    console.error("refund audit", safeRequestId(entry.requestId), safeCode(e?.code, "store_error"));
    return { saved: false, reason: "store_error" };
  }
}

/**
 * Mark one request ineligible and refund or flag it.
 * deps.load / save / audit / createRefund / notifyPhysician / notifyPatient / now
 * keep tests off the network. save and load throw on a store outage.
 */
export async function settleIneligible(requestId, actor, deps) {
  const id = safeRequestId(requestId);
  const actorId = safeRequestId(actor?.id);
  if (!id || !actorId) return { ok: false, status: 400, error: "bad_request" };
  const now = deps.now || (() => new Date().toISOString());
  let row;
  try {
    row = await deps.load(id);
  } catch (e) {
    console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    await deps.notifyPhysician({
      subject: "iSpry: ineligible visit could not be loaded",
      text: physicianStoreFailureText(e?.code || "store_error"),
    });
    return { ok: false, status: 503, error: "store_unavailable" };
  }
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const plan = settlementPlan(row);

  if (plan.action === "already_refunded" || plan.action === "already_flagged") {
    await auditOrNote(deps, {
      requestId: id,
      actorId,
      action: "ineligible_replay",
      detail: plan.action === "already_refunded" ? "already_refunded" : "member_flagged",
      refundId: plan.refundId || "",
    });
    return {
      ok: true,
      status: 200,
      action: plan.action,
      refund_status: plan.action === "already_refunded" ? "succeeded" : "member_flagged",
      refund_id: plan.refundId || null,
    };
  }

  if (plan.action === "flag_member") {
    try {
      await deps.save(id, {
        decision: "ineligible",
        decided_at: now(),
        decided_by: actorId,
        refund_status: "member_flagged",
      });
    } catch (e) {
      console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
      await deps.notifyPhysician({
        subject: "iSpry: ineligible member visit was not recorded",
        text: physicianStoreFailureText(e?.code || "store_error"),
      });
      return { ok: false, status: 503, error: "store_unavailable" };
    }
    await auditOrNote(deps, {
      requestId: id,
      actorId,
      action: "ineligible_member_flagged",
      detail: "member_no_credit_ledger",
    });
    await deps.notifyPhysician({
      subject: "iSpry: ineligible member visit — no automatic refund",
      text: physicianMemberFlagText(id),
    });
    return { ok: true, status: 200, action: "member_flagged", refund_status: "member_flagged", refund_id: null };
  }

  if (plan.action === "needs_review") {
    try {
      await deps.save(id, {
        decision: "ineligible",
        decided_at: now(),
        decided_by: actorId,
        refund_status: "needs_review",
      });
    } catch (e) {
      console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    }
    await auditOrNote(deps, {
      requestId: id,
      actorId,
      action: "ineligible_needs_review",
      detail: plan.detail,
    });
    await deps.notifyPhysician({
      subject: "iSpry: ineligible visit needs a manual refund check",
      text: physicianNeedsReviewText(id, plan.detail),
    });
    return { ok: false, status: 409, error: "not_refunded", action: "needs_review", refund_status: "needs_review", refund_id: null };
  }

  if (plan.action !== "refund") return { ok: false, status: 409, error: "not_refunded" };

  try {
    await deps.save(id, {
      decision: "ineligible",
      decided_at: now(),
      decided_by: actorId,
      refund_status: "pending",
    });
  } catch (e) {
    console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    await deps.notifyPhysician({
      subject: "iSpry: ineligible visit refund did not start",
      text: physicianStoreFailureText(e?.code || "store_error"),
    });
    return { ok: false, status: 503, error: "store_unavailable" };
  }

  let refund;
  try {
    refund = await deps.createRefund({
      paymentIntent: plan.paymentIntent,
      charge: plan.charge,
      requestId: id,
      idempotencyKey: plan.idempotencyKey,
    });
  } catch (e) {
    const code = safeCode(e?.code, "stripe_error");
    console.error("ineligible refund", id, code);
    try {
      await deps.save(id, { refund_status: "failed" });
    } catch (saveErr) {
      console.error("ineligible refund", id, safeCode(saveErr?.code, "store_error"));
    }
    await auditOrNote(deps, { requestId: id, actorId, action: "ineligible_refund_failed", detail: code });
    await deps.notifyPhysician({
      subject: "iSpry: ineligible visit refund failed",
      text: physicianRefundFailureText(id, code),
    });
    return { ok: false, status: 502, error: "refund_failed", action: "refund_failed", refund_status: "failed", refund_id: null };
  }

  if (refund.status === "failed") {
    console.error("ineligible refund", id, "stripe_failed");
    try {
      await deps.save(id, { refund_status: "failed", refund_id: refund.id || undefined });
    } catch (e) {
      console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    }
    await auditOrNote(deps, { requestId: id, actorId, action: "ineligible_refund_failed", detail: "stripe_failed", refundId: refund.id });
    await deps.notifyPhysician({
      subject: "iSpry: ineligible visit refund failed",
      text: physicianRefundFailureText(id, "stripe_failed"),
    });
    return { ok: false, status: 502, error: "refund_failed", action: "refund_failed", refund_status: "failed", refund_id: refund.id || null };
  }

  const refundStatus = refund.status === "pending" ? "pending" : "succeeded";
  try {
    await deps.save(id, {
      refund_status: refundStatus,
      refund_id: refund.id || undefined,
      stripe_charge_id: refund.charge || undefined,
    });
  } catch (e) {
    console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    await deps.notifyPhysician({
      subject: "iSpry: refund issued but the record was not saved",
      text: physicianStoreFailureText(e?.code || "store_error"),
    });
  }
  await auditOrNote(deps, {
    requestId: id,
    actorId,
    action: refund.alreadyRefunded
      ? "ineligible_refund_issued"
      : refundStatus === "pending" ? "ineligible_refund_pending" : "ineligible_refund_issued",
    detail: refund.alreadyRefunded ? "charge_already_refunded" : refundStatus,
    refundId: refund.id,
  });

  if (refundStatus !== "succeeded") {
    return { ok: true, status: 200, action: "refund_pending", refund_status: "pending", refund_id: refund.id || null, email_sent: false };
  }

  const mailed = await deps.notifyPatient({
    to: row.email,
    idempotencyKey: patientRefundIdempotencyKey(id),
  });
  if (mailed?.sent) {
    try { await deps.save(id, { refund_email_sent_at: now() }); } catch (e) {
      console.error("ineligible refund", id, safeCode(e?.code, "store_error"));
    }
    return { ok: true, status: 200, action: "refunded", refund_status: "succeeded", refund_id: refund.id || null, email_sent: true };
  }
  await auditOrNote(deps, {
    requestId: id,
    actorId,
    action: "refund_email_failed",
    detail: safeCode(mailed?.reason, "email_failed"),
    refundId: refund.id,
  });
  await deps.notifyPhysician({
    subject: "iSpry: visit refund email did not send",
    text: physicianRefundMailFailureText(id, mailed?.reason || "email_failed"),
  });
  return {
    ok: true,
    status: 200,
    action: "refunded",
    refund_status: "succeeded",
    refund_id: refund.id || null,
    email_sent: false,
  };
}

export function realSettleDeps(opts = {}) {
  const store = opts.storeOpts || {};
  return {
    load: (id) => loadRequest(id, store),
    save: (id, patch) => updateRequest(id, patch, store),
    audit: (entry) => writeAudit(entry, store),
    createRefund: (args) => createStripeRefund({ ...args, env: store.env, fetchImpl: store.fetchImpl }),
    notifyPhysician: opts.notifyPhysician || notifyPhysician,
    notifyPatient: opts.notifyPatient || notifyPatientRefund,
    now: opts.now || (() => new Date().toISOString()),
  };
}
