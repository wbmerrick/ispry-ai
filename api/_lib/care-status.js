// PHI-free patient status mail and the stale-review clock.
// Resend has no BAA, so a message is chosen only by a fixed kind. Callers
// cannot pass a symptom, a medication name, a diagnosis, or a task title
// into the subject or body. The physician stale mail is a count and a
// threshold, nothing else.
// Patient opt-out: there is no stored email preference. The handoff form's
// SMS checkbox is consent for texts and is written only into the Akute task,
// which this mailer does not read. deliverStatus still honors optOut when a
// caller has a real preference flag.

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_STALE_MINUTES = 60;
export const MAX_STALE_MINUTES = 7 * 24 * 60;
export const AKUTE_TOLERANCE_SEC = 300;
export const RX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const REQUEST_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_URL = "https://ispry.ai/member.html";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NOTICE_KEY = /^(received|reviewed|rx):[A-Za-z0-9_:-]{4,160}$/;
const AKUTE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REVIEWED = new Set(["completed", "complete", "done", "finished"]);
const CLOSED = new Set(["cancelled", "canceled", "entered-in-error", "deleted"]);
const RX_SENT = new Set(["sent", "verified", "filled"]);
const PHI_LEAK = /\b(semaglutide|tirzepatide|sildenafil|tadalafil|lisinopril|tablet|capsule)\b/i;

export function patientEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!EMAIL.test(s) || s.length > 120) return "";
  return s;
}

export function safeAkuteId(raw) {
  const s = String(raw || "");
  return AKUTE_ID.test(s) ? s : "";
}

export function readMinutes(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.floor(n);
  if (whole < 1 || whole > MAX_STALE_MINUTES) return fallback;
  return whole;
}

export function staleMinutes(env = process.env) {
  return readMinutes(env?.STALE_QUEUE_MINUTES, DEFAULT_STALE_MINUTES);
}

export function escalationMinutes(env = process.env) {
  return readMinutes(env?.STALE_ALERT_WINDOW_MINUTES, staleMinutes(env));
}

export function staleThresholdMs(env) {
  return staleMinutes(env) * 60 * 1000;
}

export function escalationWindowMs(env) {
  return escalationMinutes(env) * 60 * 1000;
}

/** Queued, old enough, and not already alerted inside the escalation window. */
export function isStale(row, now, env = process.env) {
  if (!row || row.status !== "queued") return false;
  const submitted = Date.parse(row.submitted_at);
  if (!Number.isFinite(submitted)) return false;
  if (now - submitted < staleThresholdMs(env)) return false;
  if (row.stale_alerted_at) {
    const alerted = Date.parse(row.stale_alerted_at);
    if (Number.isFinite(alerted) && now - alerted < escalationWindowMs(env)) return false;
  }
  return true;
}

export function staleCandidates(rows, now, env = process.env) {
  return (rows || []).filter((row) => isStale(row, now, env));
}

export function staleAlertCopy(count, minutes) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const m = Math.max(1, Math.floor(Number(minutes) || DEFAULT_STALE_MINUTES));
  const noun = n === 1 ? "request is" : "requests are";
  return {
    subject: "iSpry: a request is waiting for review",
    text: [
      `${n} paid or submitted ${noun} still waiting for review after ${m} minutes.`,
      "Open Akute to review.",
      "This email does not include a name, a contact, or a clinical detail.",
    ].join("\n\n"),
  };
}

function patientStatusText(lead) {
  return [
    lead,
    `Sign in to My care: ${LOGIN_URL}`,
    "This email does not include your symptoms, a medication name, or a diagnosis.",
    "iSpry is not for emergencies. Call 911, or call or text 988 if you are in crisis.",
    "Questions: call or text (731) 415-0724.",
  ].join("\n\n");
}

/** Fixed copy for one milestone. The kind is the only input. */
export function statusCopy(kind) {
  if (kind === "received") {
    return {
      subject: "iSpry: we received your request",
      text: patientStatusText(
        "We received your request. Your physician reviews requests 24/7, including nights, weekends, and holidays.",
      ),
    };
  }
  if (kind === "reviewed") {
    return {
      subject: "iSpry: your physician has reviewed your request",
      text: patientStatusText("Your physician has reviewed your request. Your plan is ready to view after you sign in."),
    };
  }
  if (kind === "rx_sent") {
    return {
      subject: "iSpry: a prescription was sent to your pharmacy",
      text: patientStatusText("A prescription was sent to your pharmacy. The pharmacy may need time before it is ready."),
    };
  }
  return null;
}

export function statusMailIsSafe(copy) {
  const blob = `${copy?.subject || ""}\n${copy?.text || ""}`;
  if (!blob.trim()) return false;
  if (PHI_LEAK.test(blob)) return false;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(blob)) return false;
  return true;
}

export function staleMailIsSafe(copy) {
  const blob = `${copy?.subject || ""}\n${copy?.text || ""}`;
  if (PHI_LEAK.test(blob)) return false;
  if (/@/.test(blob)) return false;
  return true;
}

/** True unless a caller passes a real opt-out flag. No flag means send. */
export function statusEmailAllowed(flags) {
  if (!flags || typeof flags !== "object") return true;
  if (flags.email_opt_out === true || flags.status_email === false || flags.optOut === true) return false;
  return true;
}

export function validNoticeKey(key) {
  const s = String(key || "");
  return NOTICE_KEY.test(s) ? s : "";
}

export function safeNoticeKey(kind, id) {
  const prefix = kind === "received" ? "received" : kind === "reviewed" ? "reviewed" : kind === "rx_sent" ? "rx" : "";
  const body = String(id || "").replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 160);
  return validNoticeKey(`${prefix}:${body}`);
}

export function stripeExternalKey(eventId) {
  const id = String(eventId || "");
  return /^evt_[A-Za-z0-9]{8,80}$/.test(id) ? `stripe:${id}` : "";
}

export function authorizeCron(header, secret) {
  const expected = String(secret || "");
  if (!expected) return false;
  const token = String(header || "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function signedPayloads(rawBody) {
  const raw = String(rawBody ?? "");
  const payloads = [raw];
  try {
    const compact = JSON.stringify(JSON.parse(raw));
    if (compact !== raw) payloads.push(compact);
  } catch { /* signature still checked against the raw body */ }
  return payloads;
}

/**
 * Akute signs `x-akute-signature: t=<unix>,v1=<hex>` with HMAC-SHA256 over
 * `${timestamp}.${rawBody}`. Their receiver sample stringifies a parsed body,
 * so a compact re-serialization is accepted when it differs from the raw bytes.
 */
export function verifyAkuteSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!String(secret || "")) return { ok: false, reason: "not_configured" };
  const parts = String(header || "").split(",").map((s) => s.trim()).filter(Boolean);
  let timestamp = "";
  const sigs = [];
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && /^[0-9a-f]+$/i.test(value)) sigs.push(value.toLowerCase());
  }
  if (!/^\d+$/.test(timestamp) || !sigs.length) return { ok: false, reason: "malformed_header" };
  let ts = Number(timestamp);
  if (ts > 1e12) ts = Math.floor(ts / 1000);
  if (Math.abs(nowSec - ts) > AKUTE_TOLERANCE_SEC) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = signedPayloads(rawBody).map((payload) =>
    createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex"));
  const match = sigs.some((sig) => expected.some((exp) => {
    const got = Buffer.from(sig, "utf8");
    const want = Buffer.from(exp, "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  }));
  return match ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

export function akuteWebhookSecrets(env = process.env) {
  const out = [];
  for (const name of ["AKUTE_WEBHOOK_SECRET", "AKUTE_MEDICATION_WEBHOOK_SECRET"]) {
    const secret = String(env?.[name] || "").trim();
    if (secret && !out.includes(secret)) out.push(secret);
  }
  return out;
}

function resourceKind(resource) {
  const s = String(resource || "").toLowerCase();
  if (!s || /prior|history|adherence|surescript/.test(s)) return "";
  if (s.includes("task")) return "task";
  if (s.includes("medicat")) return "medication";
  return "";
}

function statusToken(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function eventTimeMs(event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const raw = data.updated_at || data.updatedAt || data.status_updated_at || event?.created_at || event?.timestamp || "";
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (!raw) return 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

/**
 * What a verified Akute webhook should do. The result has ids and a kind only.
 * Medication names and task text are dropped here.
 */
export function planAkuteEvent(event) {
  if (!event || typeof event !== "object") return { ignore: "bad_event" };
  const kind = resourceKind(event.resource_type || event.resource);
  if (!kind) return { ignore: "unhandled" };
  const action = String(event.event_type || "").toLowerCase();
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const patientId = safeAkuteId(event.patient_id || data.patient_id);
  if (kind === "task") {
    if (action === "create") return { ignore: "task_create" };
    const taskId = safeAkuteId(data.id || data.task_id);
    const status = statusToken(data.status);
    if (REVIEWED.has(status)) return { kind: "reviewed", taskId, patientId };
    if (CLOSED.has(status)) return { kind: "closed", taskId, patientId };
    return { ignore: "task_open" };
  }
  const status = statusToken(data.status || data.prescription_status);
  if (!RX_SENT.has(status)) return { ignore: "rx_not_sent" };
  const medId = safeAkuteId(data.id || data.medication_id || event.event_id);
  return { kind: "rx_sent", patientId, medId, at: eventTimeMs(event) };
}

export function rxEventIsFresh(at, now) {
  if (!at) return true;
  if (at - now > 5 * 60 * 1000) return false;
  return now - at <= RX_MAX_AGE_MS;
}

/**
 * Send one milestone, claiming the notice key first.
 * deps.claim / deps.release / deps.send / deps.configured are for tests.
 * A clinical field on the input is ignored.
 */
export async function deliverStatus(input = {}, deps = {}) {
  if (!statusEmailAllowed(input)) return { sent: false, reason: "opt_out" };
  const email = patientEmail(input.to);
  if (!email) return { sent: false, reason: "bad_email" };
  const copy = statusCopy(input.kind);
  if (!copy || !statusMailIsSafe(copy)) return { sent: false, reason: "unsafe_copy" };
  const key = validNoticeKey(input.noticeKey) || safeNoticeKey(input.kind, input.id);
  if (!key) return { sent: false, reason: "bad_key" };
  if (deps.configured === false) return { sent: false, reason: "not_configured" };
  const claim = deps.claim;
  const release = deps.release;
  const send = deps.send;
  if (!claim || !send) return { sent: false, reason: "not_configured" };
  const claimed = await claim(key, input.kind);
  if (claimed?.duplicate) return { sent: false, duplicate: true, reason: "duplicate" };
  if (!claimed?.claimed) {
    return { sent: false, reason: claimed?.reason || "store", retry: Boolean(claimed?.retry) };
  }
  let result;
  try {
    result = await send(email, copy, key);
  } catch {
    result = { sent: false, reason: "error" };
  }
  if (!result?.sent) {
    if (release) await release(key);
    const reason = result?.reason || "error";
    return { sent: false, reason, retry: reason !== "not_configured" && reason !== "bad_email" };
  }
  return { sent: true };
}

/**
 * One physician email for every row this run successfully claims.
 * A failed send releases the claims so the next run can try again.
 */
export async function runStaleAlerts({ rows, now, env, claim, notify, release }) {
  const due = staleCandidates(rows, now, env);
  const claimed = [];
  for (const row of due) {
    if (await claim(row)) claimed.push(row);
  }
  if (!claimed.length) return { alerted: 0, claimed: 0 };
  const copy = staleAlertCopy(claimed.length, staleMinutes(env));
  if (!staleMailIsSafe(copy)) {
    if (release) await release(claimed);
    return { alerted: 0, claimed: claimed.length, failed: true, reason: "unsafe_copy" };
  }
  let result;
  try {
    result = await notify(copy);
  } catch {
    result = { sent: false, reason: "error" };
  }
  if (!result?.sent) {
    if (release) await release(claimed);
    return { alerted: 0, claimed: claimed.length, failed: true, reason: result?.reason || "error" };
  }
  return { alerted: claimed.length, copy };
}
