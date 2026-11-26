// Membership status for member-priced visits and clinician reviews.
// The Stripe webhook writes public.ispry_memberships (service role only).
// Benefit checks read that row when it is fresh. A missing or stale row
// falls back to a live Stripe subscription lookup and is stored when the
// lookup succeeds. active and trialing grant benefits. Every other status
// does not, including past_due, unpaid, canceled, incomplete, and paused.
// A cancel-at-period-end subscription stays active in Stripe until it ends,
// so it still grants benefits. No clinical text is stored.

import { supabaseConfig } from "../auth-config.js";

export const MEMBERSHIP_FRESH_MS = 6 * 60 * 60 * 1000;
const STRIPE_API = "https://api.stripe.com/v1";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_RE = /^[a-z_]{1,32}$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{1,200}$/;
const SUB_RE = /^sub_[A-Za-z0-9]{1,200}$/;

export const INACTIVE_MESSAGE =
  "Your membership isn't active, so this isn't included. Pay $49 for a visit, or resubscribe for $100 a month.";
export const UNCONFIRMED_MESSAGE =
  "We couldn't confirm an active membership, so this isn't included. Pay $49 for a visit, or resubscribe for $100 a month.";

export function normalizeEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(s) || s.length > 120) return "";
  return s;
}

export function safeCustomerId(id) {
  const s = String(id || "");
  return CUSTOMER_RE.test(s) ? s : "";
}

export function safeSubscriptionId(id) {
  const s = String(id || "");
  return SUB_RE.test(s) ? s : "";
}

export function normalizeStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return STATUS_RE.test(s) ? s : "";
}

/** Stripe `created` (unix seconds) as an ISO time. Empty when it is missing. */
export function eventStatusAt(created) {
  const n = Number(created);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * True when the incoming status is at least as new as the one stored.
 * A missing stored time can be replaced. A missing incoming time cannot.
 */
export function membershipWriteIsNewer(existingStatusAt, incomingStatusAt) {
  const next = Date.parse(incomingStatusAt || "");
  if (!Number.isFinite(next)) return false;
  const prev = Date.parse(existingStatusAt || "");
  if (!Number.isFinite(prev)) return true;
  return next >= prev;
}

/** active and trialing only. A stale or unconfirmed row never grants benefits. */
export function grantsMemberBenefits(row) {
  if (!row || row.stale || row.unconfirmed) return false;
  const status = normalizeStatus(row.status);
  return status === "active" || status === "trialing";
}

export function memberBenefitDenial(access) {
  if (access?.benefits) return null;
  const unconfirmed = !access || access.unconfirmed || access.status === "unknown";
  return {
    code: "membership_inactive",
    error: unconfirmed ? UNCONFIRMED_MESSAGE : INACTIVE_MESSAGE,
  };
}

const periodEndUnix = (sub) => sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || 0;

export function periodEndIso(sub) {
  const unix = periodEndUnix(sub);
  return unix ? new Date(unix * 1000).toISOString() : null;
}

/**
 * Best subscription for this customer. Active and trialing outrank a failed
 * payment, which outranks a canceled or incomplete subscription.
 */
export function pickSubscription(subs) {
  const rank = (s) => {
    if (["active", "trialing"].includes(s.status) && !s.cancel_at_period_end) return 4;
    if (["active", "trialing"].includes(s.status)) return 3;
    if (["past_due", "unpaid"].includes(s.status)) return 2;
    if (["incomplete", "paused", "canceled", "incomplete_expired"].includes(s.status)) return 1;
    return 0;
  };
  return (subs || [])
    .slice()
    .sort((a, b) => rank(b) - rank(a) || (b.created || 0) - (a.created || 0))[0] || null;
}

export function recordFromSubscription(sub, customerId = "") {
  if (!sub) {
    return {
      status: "none",
      stripe_customer_id: safeCustomerId(customerId),
      stripe_subscription_id: "",
      cancel_at_period_end: false,
      current_period_end: null,
    };
  }
  return {
    status: normalizeStatus(sub.status) || "none",
    stripe_customer_id: safeCustomerId(customerId) || safeCustomerId(typeof sub.customer === "string" ? sub.customer : sub.customer?.id),
    stripe_subscription_id: safeSubscriptionId(sub.id),
    cancel_at_period_end: sub.cancel_at_period_end === true,
    current_period_end: periodEndIso(sub),
  };
}

/**
 * What the member page shows. Benefits stay on for active, trialing, and a
 * scheduled cancel that has not ended yet.
 */
export function displayMembership(row) {
  const raw = normalizeStatus(row?.status);
  if (!row || row.unconfirmed || row.stale || !raw || raw === "unknown") {
    return { status: "unknown", date: null, benefits: false, stripe_status: raw || null };
  }
  const date = row.current_period_end ? String(row.current_period_end).slice(0, 10) : null;
  if (raw === "none") return { status: "none", date: null, benefits: false, stripe_status: "none" };
  if (raw === "active" || raw === "trialing") {
    if (row.cancel_at_period_end) return { status: "canceling", date, benefits: true, stripe_status: raw };
    return { status: "active", date, benefits: true, stripe_status: raw };
  }
  if (raw === "past_due" || raw === "unpaid") {
    return { status: "past_due", date: null, benefits: false, stripe_status: raw };
  }
  return { status: "inactive", date: null, benefits: false, stripe_status: raw };
}

/** Member-page summary of a Stripe subscription list. Pure, for tests. */
export function summarizeSubscriptions(subs) {
  const best = pickSubscription(subs);
  if (!best) return { status: "none", date: null };
  const shown = displayMembership(recordFromSubscription(best));
  return { status: shown.status, date: shown.date };
}

export function isMembershipFresh(row, now = Date.now()) {
  const t = Date.parse(row?.updated_at || "");
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age <= MEMBERSHIP_FRESH_MS && age >= -60_000;
}

function serviceKey(env) {
  return String(env?.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function restHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function stripeKey(env) {
  return String(env?.STRIPE_SECRET_KEY || "").trim();
}

async function stripeGet(path, params, opts) {
  const key = stripeKey(opts.env || process.env);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl || fetch;
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const r = await fetchImpl(`${STRIPE_API}${path}${qs}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const err = new Error(`stripe_${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function lookupStripeMembership(email, opts = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (!stripeKey(opts.env || process.env)) return null;
  const customers = (await stripeGet("/customers", { email: normalized, limit: "10" }, opts))?.data || [];
  const subs = [];
  let customerId = "";
  for (const c of customers.slice(0, 5)) {
    if (!customerId) customerId = safeCustomerId(c.id);
    const page = await stripeGet("/subscriptions", { customer: c.id, status: "all", limit: "10" }, opts);
    subs.push(...(page?.data || []));
  }
  const best = pickSubscription(subs);
  return recordFromSubscription(best, best ? (typeof best.customer === "string" ? best.customer : customerId) : customerId);
}

function rowFromDb(row) {
  if (!row || typeof row !== "object") return null;
  const email = normalizeEmail(row.email);
  const status = normalizeStatus(row.status);
  if (!email || !status) return null;
  return {
    email,
    user_id: UUID_RE.test(String(row.user_id || "")) ? String(row.user_id) : "",
    status,
    stripe_customer_id: safeCustomerId(row.stripe_customer_id),
    stripe_subscription_id: safeSubscriptionId(row.stripe_subscription_id),
    cancel_at_period_end: row.cancel_at_period_end === true,
    current_period_end: row.current_period_end || null,
    status_at: Number.isFinite(Date.parse(row.status_at || "")) ? new Date(row.status_at).toISOString() : "",
    updated_at: row.updated_at || null,
  };
}

export async function readMembership(email, opts = {}) {
  const normalized = normalizeEmail(email);
  const env = opts.env || process.env;
  const key = serviceKey(env);
  if (!normalized || !key) return null;
  const base = opts.supabaseUrl || supabaseConfig().url;
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const r = await fetchImpl(
      `${base}/rest/v1/ispry_memberships?email=eq.${encodeURIComponent(normalized)}&select=email,user_id,status,stripe_customer_id,stripe_subscription_id,cancel_at_period_end,current_period_end,status_at,updated_at`,
      { headers: restHeaders(key) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rowFromDb(Array.isArray(rows) ? rows[0] : null);
  } catch {
    return null;
  }
}

async function findEmailByStripeIds(patch, opts) {
  const customerId = safeCustomerId(patch.stripe_customer_id);
  const subId = safeSubscriptionId(patch.stripe_subscription_id);
  const env = opts.env || process.env;
  const key = serviceKey(env);
  if (!key || (!customerId && !subId)) return "";
  const filters = [];
  if (customerId) filters.push(`stripe_customer_id.eq.${customerId}`);
  if (subId) filters.push(`stripe_subscription_id.eq.${subId}`);
  const base = opts.supabaseUrl || supabaseConfig().url;
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const r = await fetchImpl(
      `${base}/rest/v1/ispry_memberships?or=(${filters.join(",")})&select=email&limit=1`,
      { headers: restHeaders(key) },
    );
    if (!r.ok) return "";
    const rows = await r.json();
    return normalizeEmail(Array.isArray(rows) ? rows[0]?.email : "");
  } catch {
    return "";
  }
}

async function emailFromStripeCustomer(customerId, opts) {
  const id = safeCustomerId(customerId);
  if (!id || !stripeKey(opts.env || process.env)) return "";
  try {
    const customer = await stripeGet(`/customers/${id}`, null, opts);
    return normalizeEmail(customer?.email);
  } catch {
    return "";
  }
}

export async function upsertMembership(patch, opts = {}) {
  const email = normalizeEmail(patch?.email);
  const status = normalizeStatus(patch?.status);
  const statusAt = eventStatusAt(patch?.status_at) || (Number.isFinite(Date.parse(patch?.status_at || "")) ? new Date(patch.status_at).toISOString() : "");
  const env = opts.env || process.env;
  const key = serviceKey(env);
  if (!email || !status) return { saved: false, reason: "bad_row" };
  if (!statusAt) return { saved: false, reason: "no_event_time" };
  if (!key) return { saved: false, reason: "not_configured" };
  const customerId = safeCustomerId(patch.stripe_customer_id);
  const subId = safeSubscriptionId(patch.stripe_subscription_id);
  const userId = UUID_RE.test(String(patch.user_id || "")) ? String(patch.user_id) : null;
  const body = {
    p_email: email,
    p_status: status,
    p_status_at: statusAt,
    p_stripe_customer_id: customerId || null,
    p_stripe_subscription_id: subId || null,
    p_cancel_at_period_end: typeof patch.cancel_at_period_end === "boolean" ? patch.cancel_at_period_end : null,
    p_current_period_end: patch.current_period_end || null,
    p_user_id: userId,
  };
  const base = opts.supabaseUrl || supabaseConfig().url;
  const fetchImpl = opts.fetchImpl || fetch;
  const r = await fetchImpl(`${base}/rest/v1/rpc/ispry_apply_membership`, {
    method: "POST",
    headers: restHeaders(key),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // 5xx is worth a Stripe retry. A missing function (404) must not block the
    // Akute task; benefit checks fall back to Stripe until the migration runs.
    if (r.status >= 500) {
      const err = new Error(`membership_store_${r.status}`);
      err.status = r.status;
      throw err;
    }
    console.warn("membership store", r.status);
    return { saved: false, reason: `http_${r.status}` };
  }
  const saved = await r.json().catch(() => null);
  const result = Array.isArray(saved) ? saved[0] : saved;
  if (result?.applied === false) return { saved: false, reason: result.reason || "stale_event" };
  return {
    saved: true,
    row: {
      email,
      status,
      status_at: statusAt,
      stripe_customer_id: customerId,
      stripe_subscription_id: subId,
      cancel_at_period_end: patch.cancel_at_period_end === true,
      current_period_end: patch.current_period_end || null,
      updated_at: new Date(opts.now || Date.now()).toISOString(),
    },
  };
}

/**
 * Webhook write. Resolves the account email from the event, an existing row,
 * or the Stripe customer. Does not throw when the email or service role is
 * missing — the benefit check can still read Stripe live. A store HTTP error
 * throws so Stripe retries the event.
 */
export async function applyMembershipPatch(patch, opts = {}) {
  if (!patch || !normalizeStatus(patch.status)) return { saved: false, reason: "bad_status" };
  const statusAt = eventStatusAt(patch.status_at) || (Number.isFinite(Date.parse(patch.status_at || "")) ? new Date(patch.status_at).toISOString() : "");
  // No event time means we would stamp updated_at as now and trust an unordered
  // delivery for six hours. Skip the write instead.
  if (!statusAt) return { saved: false, reason: "no_event_time" };
  let email = normalizeEmail(patch.email);
  if (!email) email = await findEmailByStripeIds(patch, opts);
  if (!email) email = await emailFromStripeCustomer(patch.stripe_customer_id, opts);
  if (!email) return { saved: false, reason: "no_email" };
  const existing = await readMembership(email, opts);
  if (existing && !membershipWriteIsNewer(existing.status_at, statusAt)) {
    return { saved: false, reason: "stale_event" };
  }
  const next = { ...patch, email, status_at: statusAt };
  if (typeof patch.cancel_at_period_end !== "boolean") delete next.cancel_at_period_end;
  return upsertMembership(next, opts);
}

function withBenefits(row, extra = {}) {
  const merged = { ...row, ...extra };
  return { ...merged, benefits: grantsMemberBenefits(merged) };
}

/**
 * Authoritative membership for a signed-in email.
 * Fresh store row wins. Otherwise live Stripe, then store the result.
 * If Stripe cannot be checked, benefits are false.
 */
export async function resolveMembership(email, opts = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return withBenefits({ status: "unknown", unconfirmed: true, stale: true });
  const now = opts.now || Date.now();
  const row = await readMembership(normalized, opts);
  if (row && isMembershipFresh(row, now)) return withBenefits(row, { stale: false, unconfirmed: false });
  let live = null;
  try {
    live = await lookupStripeMembership(normalized, opts);
  } catch {
    live = null;
  }
  if (!live) return withBenefits({ status: "unknown", email: normalized, unconfirmed: true, stale: true });
  const userId = UUID_RE.test(String(opts.userId || "")) ? String(opts.userId) : "";
  try {
    const saved = await upsertMembership({
      ...live,
      email: normalized,
      user_id: userId,
      status_at: new Date(now).toISOString(),
    }, { ...opts, now });
    return withBenefits(saved.row || { ...live, email: normalized, updated_at: new Date(now).toISOString() }, {
      stale: false,
      unconfirmed: false,
    });
  } catch {
    return withBenefits({ ...live, email: normalized, updated_at: new Date(now).toISOString() }, {
      stale: false,
      unconfirmed: false,
    });
  }
}
