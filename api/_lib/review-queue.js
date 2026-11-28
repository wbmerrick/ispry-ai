// Service-role store for the review queue and status-mail claims.
// Without SUPABASE_SERVICE_ROLE_KEY the callers skip mail and the stale
// sweep. A missing table (HTTP 404) is treated the same way so a webhook does
// not retry forever before the migration is applied. A network error or a 5xx
// throws, and the Akute webhook answers 500 so Akute retries. Responses are
// not logged: a row contains an email address.

import { supabaseConfig } from "../auth-config.js";
import { escalationWindowMs, patientEmail, safeAkuteId, staleThresholdMs } from "./care-status.js";

function serviceKey(env) {
  return String(env?.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function restHeaders(key, extra) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object" && data.id) return data;
  return null;
}

function rowsOf(data) {
  return Array.isArray(data) ? data : [];
}

async function rest(path, { method = "GET", body, prefer, env, fetchImpl } = {}) {
  const key = serviceKey(env || process.env);
  if (!key) return { ok: false, status: 0, reason: "not_configured", data: null };
  const base = (env?.SUPABASE_URL && String(env.SUPABASE_URL).replace(/\/$/, "")) || supabaseConfig().url;
  const headers = restHeaders(key, prefer ? { Prefer: prefer } : null);
  try {
    const r = await (fetchImpl || fetch)(`${base}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (r.ok || r.status === 409) return { ok: r.ok, status: r.status, data };
    console.warn("review queue", method, r.status);
    if (r.status === 404) return { ok: false, status: 404, reason: "not_configured", data: null };
    if (r.status >= 500 || r.status === 408 || r.status === 429) throw storeDown();
    return { ok: false, status: r.status, data: null };
  } catch (e) {
    if (e?.retry) throw e;
    console.warn("review queue unreachable");
    throw storeDown();
  }
}

function storeDown() {
  const err = new Error("review_store");
  err.retry = true;
  return err;
}

function assertRead(res) {
  if (res.ok || res.reason === "not_configured") return res;
  throw storeDown();
}

const QUEUE_COLS = "id,status,source,patient_email,akute_patient_id,akute_task_id,submitted_at,reviewed_at,stale_alerted_at,external_key";

function queueRow(raw) {
  if (!raw?.id) return null;
  return {
    id: String(raw.id),
    status: String(raw.status || ""),
    source: String(raw.source || ""),
    patient_email: patientEmail(raw.patient_email),
    akute_patient_id: safeAkuteId(raw.akute_patient_id),
    akute_task_id: safeAkuteId(raw.akute_task_id),
    submitted_at: raw.submitted_at || null,
    reviewed_at: raw.reviewed_at || null,
    stale_alerted_at: raw.stale_alerted_at || null,
    external_key: String(raw.external_key || ""),
  };
}

export async function insertRequest(fields, opts = {}) {
  const email = patientEmail(fields.email);
  const externalKey = String(fields.externalKey || "");
  if (!email || !/^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/.test(externalKey)) return null;
  const row = {
    external_key: externalKey,
    source: fields.source,
    status: fields.status,
    patient_email: email,
    akute_patient_id: safeAkuteId(fields.patientId) || null,
    akute_task_id: safeAkuteId(fields.taskId) || null,
    submitted_at: fields.submittedAt || new Date().toISOString(),
  };
  const res = await rest("ispry_review_queue", {
    method: "POST",
    body: row,
    prefer: "return=representation",
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });
  if (res.status === 409) return requestByExternalKey(externalKey, opts);
  if (res.status === 404 || res.reason === "not_configured") return null;
  if (!res.ok) throw storeDown();
  return queueRow(firstRow(res.data));
}

export async function requestByExternalKey(externalKey, opts = {}) {
  const key = encodeURIComponent(String(externalKey || ""));
  const res = assertRead(await rest(`ispry_review_queue?external_key=eq.${key}&select=${QUEUE_COLS}&limit=1`, opts));
  return queueRow(firstRow(res.data));
}

function idFilters({ email, patientId }) {
  const parts = [];
  const id = safeAkuteId(patientId);
  const mail = patientEmail(email);
  if (id) parts.push(`akute_patient_id.eq.${encodeURIComponent(id)}`);
  if (mail) parts.push(`patient_email.eq.${encodeURIComponent(mail)}`);
  return parts;
}

async function newest(filter, opts) {
  const res = assertRead(await rest(`ispry_review_queue?${filter}&select=${QUEUE_COLS}&limit=1`, opts));
  return queueRow(firstRow(res.data));
}

export async function findAwaitingPayment({ email, patientId }, opts = {}) {
  const parts = idFilters({ email, patientId });
  if (!parts.length) return null;
  return newest(
    `status=eq.awaiting_payment&or=(${parts.join(",")})&order=created_at.desc`,
    opts,
  );
}

export async function findRecentReviewedIntake({ email, patientId, since }, opts = {}) {
  const parts = idFilters({ email, patientId });
  if (!parts.length || !since) return null;
  return newest(
    `status=eq.reviewed&source=eq.intake&reviewed_at=gte.${encodeURIComponent(since)}&or=(${parts.join(",")})&order=reviewed_at.desc`,
    opts,
  );
}

export async function activatePayment(id, externalKey, opts = {}) {
  const uuid = String(id || "");
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  const body = { status: "queued", submitted_at: new Date().toISOString() };
  if (/^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/.test(String(externalKey || ""))) {
    body.external_key = externalKey;
  }
  const res = await rest(
    `ispry_review_queue?id=eq.${uuid}&status=eq.awaiting_payment`,
    {
      method: "PATCH",
      body,
      prefer: "return=representation",
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    },
  );
  if (!res.ok && res.reason !== "not_configured") throw storeDown();
  const row = queueRow(firstRow(res.data));
  if (row) return row;
  const current = assertRead(await rest(`ispry_review_queue?id=eq.${uuid}&select=${QUEUE_COLS}&limit=1`, opts));
  return queueRow(firstRow(current.data));
}

export async function findByTaskId(taskId, opts = {}) {
  const id = safeAkuteId(taskId);
  if (!id) return null;
  return newest(
    `akute_task_id=eq.${encodeURIComponent(id)}&status=in.(queued,awaiting_payment)`,
    opts,
  );
}

export async function findNewestCare(patientId, since, opts = {}) {
  const id = safeAkuteId(patientId);
  if (!id) return null;
  return newest(
    `akute_patient_id=eq.${encodeURIComponent(id)}&status=in.(queued,reviewed)&submitted_at=gte.${encodeURIComponent(since)}&order=submitted_at.desc`,
    opts,
  );
}

export async function markRequest(id, status, opts = {}) {
  const uuid = String(id || "");
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  const now = new Date().toISOString();
  const body = status === "reviewed"
    ? { status, reviewed_at: now }
    : status === "closed"
      ? { status, closed_at: now }
      : null;
  if (!body) return null;
  const res = await rest(
    `ispry_review_queue?id=eq.${uuid}&status=in.(queued,awaiting_payment)`,
    { method: "PATCH", body, prefer: "return=representation", env: opts.env, fetchImpl: opts.fetchImpl },
  );
  if (!res.ok && res.reason !== "not_configured") throw storeDown();
  return queueRow(firstRow(res.data));
}

export async function listStaleRows(now, env, opts = {}) {
  const cutoff = new Date(now - staleThresholdMs(env)).toISOString();
  const windowCutoff = new Date(now - escalationWindowMs(env)).toISOString();
  const res = assertRead(await rest(
    `ispry_review_queue?status=eq.queued&submitted_at=lte.${encodeURIComponent(cutoff)}&or=(stale_alerted_at.is.null,stale_alerted_at.lt.${encodeURIComponent(windowCutoff)})&select=id,status,submitted_at,stale_alerted_at&order=submitted_at.asc&limit=50`,
    { ...opts, env: opts.env || env },
  ));
  return rowsOf(res.data).map(queueRow).filter(Boolean);
}

export async function claimStaleRow(row, now, env, opts = {}) {
  const id = String(row?.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const windowCutoff = new Date(now - escalationWindowMs(env)).toISOString();
  const res = await rest(
    `ispry_review_queue?id=eq.${id}&status=eq.queued&or=(stale_alerted_at.is.null,stale_alerted_at.lt.${encodeURIComponent(windowCutoff)})`,
    {
      method: "PATCH",
      body: { stale_alerted_at: new Date(now).toISOString() },
      prefer: "return=representation",
      env: opts.env || env,
      fetchImpl: opts.fetchImpl,
    },
  );
  if (!res.ok && res.reason !== "not_configured") throw storeDown();
  return Boolean(queueRow(firstRow(res.data)));
}

export async function releaseStaleRows(rows, opts = {}) {
  for (const row of rows || []) {
    const id = String(row?.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    await rest(`ispry_review_queue?id=eq.${id}`, {
      method: "PATCH",
      body: { stale_alerted_at: row.stale_alerted_at || null },
      prefer: "return=minimal",
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
  }
}

function noticeKind(key) {
  if (key.startsWith("received:")) return "received";
  if (key.startsWith("reviewed:")) return "reviewed";
  if (key.startsWith("rx:")) return "rx_sent";
  return "";
}

export async function claimNotice(key, kind, opts = {}) {
  const noticeKindValue = noticeKind(key) || (kind === "rx_sent" ? "rx_sent" : kind);
  const res = await rest("ispry_status_notices", {
    method: "POST",
    body: { notice_key: key, kind: noticeKindValue },
    prefer: "return=minimal",
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });
  if (res.reason === "not_configured" || res.status === 404) return { claimed: false, reason: "not_configured" };
  if (res.status === 409) return { claimed: false, duplicate: true };
  if (!res.ok) return { claimed: false, reason: res.status ? `http_${res.status}` : "unreachable", retry: res.status === 0 || res.status >= 500 };
  return { claimed: true };
}

export async function releaseNotice(key, opts = {}) {
  const safe = encodeURIComponent(String(key || ""));
  await rest(`ispry_status_notices?notice_key=eq.${safe}`, {
    method: "DELETE",
    prefer: "return=minimal",
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });
}
