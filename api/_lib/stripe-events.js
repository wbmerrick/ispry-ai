// Idempotency store for Stripe webhook event ids.
// Rows live in public.ispry_stripe_events (service role only).
// An id is recorded only after the event is handled, so a failed Akute
// write can still be retried by Stripe. Without SUPABASE_SERVICE_ROLE_KEY
// the webhook keeps working and simply does not dedupe.
// The table stores the event id and type only — never the payload.

import { supabaseConfig } from "../auth-config.js";

const EVENT_ID = /^evt_[A-Za-z0-9]{8,200}$/;

export function safeStripeEventId(id) {
  const s = String(id || "");
  return EVENT_ID.test(s) ? s : "";
}

export function safeStripeEventType(type) {
  const s = String(type || "");
  return /^[a-z0-9._]{1,80}$/.test(s) ? s : "unknown";
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

/**
 * Whether this event id was already handled.
 * duplicate: false when the key is missing, the id is malformed, or the
 * store cannot be read (fail open so a Stripe retry still creates the task).
 */
export async function stripeEventAlreadyProcessed(event, opts = {}) {
  const id = safeStripeEventId(event?.id);
  const env = opts.env || process.env;
  const key = serviceKey(env);
  if (!id) return { duplicate: false, reason: "bad_id" };
  if (!key) return { duplicate: false, reason: "not_configured" };
  const base = opts.supabaseUrl || supabaseConfig().url;
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const r = await fetchImpl(
      `${base}/rest/v1/ispry_stripe_events?event_id=eq.${encodeURIComponent(id)}&select=event_id`,
      { headers: restHeaders(key) },
    );
    if (!r.ok) {
      console.warn("stripe event lookup", r.status);
      return { duplicate: false, reason: `http_${r.status}` };
    }
    const rows = await r.json();
    return { duplicate: Array.isArray(rows) && rows.length > 0 };
  } catch {
    console.warn("stripe event lookup unreachable");
    return { duplicate: false, reason: "unreachable" };
  }
}

/** Record a handled event id. 409 means it is already stored. Never throws. */
export async function rememberStripeEvent(event, opts = {}) {
  const id = safeStripeEventId(event?.id);
  const env = opts.env || process.env;
  const key = serviceKey(env);
  if (!id) return { recorded: false, reason: "bad_id" };
  if (!key) return { recorded: false, reason: "not_configured" };
  const base = opts.supabaseUrl || supabaseConfig().url;
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const r = await fetchImpl(`${base}/rest/v1/ispry_stripe_events`, {
      method: "POST",
      headers: { ...restHeaders(key), Prefer: "return=minimal" },
      body: JSON.stringify({ event_id: id, event_type: safeStripeEventType(event?.type) }),
    });
    if (r.status === 409) return { recorded: true, duplicate: true };
    if (!r.ok) {
      console.warn("stripe event remember", r.status);
      return { recorded: false, reason: `http_${r.status}` };
    }
    return { recorded: true };
  } catch {
    console.warn("stripe event remember unreachable");
    return { recorded: false, reason: "unreachable" };
  }
}
