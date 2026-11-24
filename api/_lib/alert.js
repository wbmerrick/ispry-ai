// Internal ops email when an API route is about to return an unexpected 5xx,
// or when the Stripe webhook / Akute handoff fails. Uses the same Resend
// path as physician heads-up mail (api/_lib/notify.js).
//
// At most one email per error type per 15 minutes per warm instance.
// The body is only the route name, error class, a short operational message,
// and the request id. Patient messages, conditions, emails, and phone
// numbers are not included.

import { notifyPhysician } from "./notify.js";

export const ALERT_WINDOW_MS = 15 * 60 * 1000;

const buckets = globalThis.__ispryOpsAlerts || (globalThis.__ispryOpsAlerts = new Map());

const STATUS_SUMMARY = /^(?:Akute\s+[A-Z]+\s+|Stripe\s+)\/[A-Za-z0-9_./-]+\s+->\s+\d{3}/;
const CONDITION =
  /\b(uti|sore throat|sinus|erectile|hair loss|weight loss|chest pain|pregnan\w*|diabetes|glp-?1|semaglutide|tirzepatide|symptom|diagnosis|patient said|condition)\b/i;

function redact(s) {
  return String(s || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted]")
    .replace(/sk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

/** Route + class + short operational message. Drops identifiers and clinical text. */
export function safeOpsError(err) {
  const errorClass = String(err?.name || "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";
  const one = String(err?.message || err || "error").replace(/\s+/g, " ").trim();
  const summary = one.match(STATUS_SUMMARY);
  if (summary && !CONDITION.test(summary[0])) return { errorClass, message: redact(summary[0]).slice(0, 180) };
  const short = one.slice(0, 120);
  const operational = /^[A-Za-z0-9_ .:/\->()]{1,80}$/.test(short) && short.length <= 80 && !CONDITION.test(short) && !/@/.test(short);
  return { errorClass, message: operational ? redact(short) : errorClass };
}

export function requestIdFrom(req) {
  const h = req?.headers;
  if (!h) return "";
  const read = (name) => {
    if (typeof h.get === "function") return h.get(name) || "";
    return h[name] || h[name.toLowerCase()] || "";
  };
  const id = String(read("x-vercel-id") || read("x-request-id") || "");
  return id.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120);
}

/** True the first time this error type is seen inside the window. */
export function claimAlertSlot(type, now = Date.now(), store = buckets) {
  const key = String(type || "unknown").slice(0, 200);
  const prev = store.get(key);
  if (prev && now - prev < ALERT_WINDOW_MS) return false;
  store.set(key, now);
  if (store.size > 500) {
    for (const [k, t] of store) {
      if (now - t >= ALERT_WINDOW_MS) store.delete(k);
    }
  }
  return true;
}

/**
 * Send one rate-limited ops email. Never throws.
 * deps.notify / deps.now / deps.store are for tests.
 */
export async function alertRouteFailure(req, { route, error, status } = {}, deps = {}) {
  const notify = deps.notify || notifyPhysician;
  const now = deps.now || Date.now();
  const store = deps.store || buckets;
  const name = String(route || "api").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "api";
  const { errorClass, message } = safeOpsError(error);
  const requestId = requestIdFrom(req);
  const type = `${name}:${errorClass}:${message}`;
  if (!claimAlertSlot(type, now, store)) return { sent: false, reason: "rate_limited" };
  const text = [
    `Route: ${name}`,
    `Error: ${errorClass}`,
    `Message: ${message}`,
    `Request id: ${requestId || "n/a"}`,
    `Status: ${Number(status) || 500}`,
  ].join("\n");
  try {
    return await notify({
      subject: `iSpry alert: ${name} ${errorClass}`.slice(0, 200),
      text,
    });
  } catch {
    return { sent: false, reason: "error" };
  }
}
