// Wires the review queue to handoff, member requests, Stripe payments,
// Akute webhooks, and the stale-queue cron. Failures are swallowed by the
// note* helpers so a mail or database problem cannot duplicate an Akute task
// or make Stripe retry one. The Akute webhook returns retry when a send fails
// after the signature has already been checked.

import { randomUUID } from "node:crypto";
import { notifyConfigured, notifyPhysician, patientPayConfigured } from "./notify.js";
import {
  REQUEST_LOOKBACK_MS,
  patientEmail,
  rxEventIsFresh,
  safeAkuteId,
  safeNoticeKey,
  deliverStatus,
  planAkuteEvent,
  runStaleAlerts,
} from "./care-status.js";
import {
  activatePayment,
  claimNotice,
  claimStaleRow,
  requestByExternalKey,
  findAwaitingPayment,
  findByTaskId,
  findNewestCare,
  findRecentReviewedIntake,
  insertRequest,
  listStaleRows,
  markRequest,
  releaseNotice,
  releaseStaleRows,
} from "./review-queue.js";

const PREPAY_REVIEW_MS = 3 * 60 * 60 * 1000;

async function sendFixedCopy(to, copy, key) {
  if (!patientPayConfigured()) return { sent: false, reason: "not_configured" };
  const from = process.env.NOTIFY_FROM || "iSpry <onboarding@resend.dev>";
  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  const idem = String(key || "").replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, 256);
  if (idem) headers["Idempotency-Key"] = idem;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from,
        to: [to],
        subject: copy.subject.slice(0, 200),
        text: copy.text.slice(0, 4000),
      }),
    });
    if (r.status === 409) return { sent: true, duplicate: true };
    if (!r.ok) {
      console.warn("status mail", r.status);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch {
    console.warn("status mail unreachable");
    return { sent: false, reason: "error" };
  }
}

function mailDeps(opts = {}) {
  const mail = opts.mail || {};
  return {
    claim: mail.claim || ((key, kind) => claimNotice(key, kind, opts)),
    release: mail.release || ((key) => releaseNotice(key, opts)),
    send: mail.send || sendFixedCopy,
    configured: mail.configured !== undefined ? mail.configured : patientPayConfigured(),
  };
}

async function mailMilestone(row, kind, id, opts) {
  const key = safeNoticeKey(kind, id || row?.id);
  if (!row?.patient_email || !key) return { sent: false, reason: "bad_email" };
  return deliverStatus({
    to: row.patient_email,
    kind,
    noticeKey: key,
    optOut: row.email_opt_out === true,
  }, mailDeps(opts));
}

export async function noteIntakeFiled({ email, patientId, taskId, awaitingPayment } = {}, opts = {}) {
  try {
    const row = await insertRequest({
      externalKey: `intake:${randomUUID()}`,
      source: "intake",
      status: awaitingPayment ? "awaiting_payment" : "queued",
      email,
      patientId,
      taskId,
    }, opts);
    if (!row?.id || awaitingPayment) return { queued: Boolean(row?.id), mailed: false };
    const mailed = await mailMilestone(row, "received", row.id, opts);
    return { queued: true, mailed: Boolean(mailed.sent) };
  } catch {
    console.warn("review queue intake");
    return { queued: false };
  }
}

export async function noteMemberRequest({ email, patientId, taskId } = {}, opts = {}) {
  try {
    const row = await insertRequest({
      externalKey: `member:${randomUUID()}`,
      source: "member_request",
      status: "queued",
      email,
      patientId,
      taskId,
    }, opts);
    if (!row?.id) return { queued: false };
    const mailed = await mailMilestone(row, "received", row.id, opts);
    return { queued: true, mailed: Boolean(mailed.sent) };
  } catch {
    console.warn("review queue member");
    return { queued: false };
  }
}

export async function notePayment({ email, patientId, kind, createIfMissing, externalKey, paidTaskId } = {}, opts = {}) {
  try {
    const normalized = patientEmail(email);
    if (!normalized) return { queued: false, reason: "bad_email" };
    const key = externalKey && String(externalKey).startsWith("stripe:") ? externalKey : "";
    if (key) {
      const existing = await requestByExternalKey(key, opts);
      if (existing?.id && existing.status !== "awaiting_payment") {
        const mailed = await mailMilestone(existing, "received", existing.id, opts);
        return { queued: true, already: true, mailed: Boolean(mailed.sent) };
      }
    }
    const waiting = await findAwaitingPayment({ email: normalized, patientId }, opts);
    let row = null;
    if (waiting?.id) {
      row = await activatePayment(waiting.id, key, opts);
    } else {
      const since = new Date(Date.now() - PREPAY_REVIEW_MS).toISOString();
      const early = await findRecentReviewedIntake({ email: normalized, patientId, since }, opts);
      if (early?.id) {
        const mailed = await mailMilestone(early, "received", early.id, opts);
        return { queued: true, already: true, mailed: Boolean(mailed.sent) };
      }
      if (!createIfMissing) return { queued: false, skipped: true };
      const insertKey = key || `stripe:${randomUUID()}`;
      row = await insertRequest({
        externalKey: insertKey,
        source: kind === "membership" ? "stripe_membership" : "stripe_visit",
        status: "queued",
        email: normalized,
        patientId,
        taskId: paidTaskId,
      }, opts);
    }
    if (!row?.id || row.status === "awaiting_payment") return { queued: false };
    const mailed = await mailMilestone(row, "received", row.id, opts);
    return { queued: true, mailed: Boolean(mailed.sent) };
  } catch {
    console.warn("review queue payment");
    return { queued: false };
  }
}

async function finishReviewed(row, opts) {
  const sent = await mailMilestone(row, "reviewed", row.id, opts);
  if (sent.retry) return { ok: false, retry: true };
  if (row.status === "queued" || row.status === "awaiting_payment") await markRequest(row.id, "reviewed", opts);
  return { ok: true, reviewed: true, mailed: Boolean(sent.sent), duplicate: Boolean(sent.duplicate) };
}

export async function applyAkuteEvent(event, opts = {}) {
  try {
    return await applyAkuteEventInner(event, opts);
  } catch (e) {
    if (e?.retry) return { ok: false, retry: true };
    throw e;
  }
}

async function applyAkuteEventInner(event, opts) {
  const now = opts.now || Date.now();
  const plan = planAkuteEvent(event);
  if (plan.ignore) return { ok: true, ignored: plan.ignore };
  if (plan.kind === "rx_sent" && !rxEventIsFresh(plan.at, now)) return { ok: true, ignored: "rx_stale" };

  if (plan.kind === "reviewed" || plan.kind === "closed") {
    // Only the task id we stored for this request. Completing some other
    // Akute task for the same patient must not clear the review clock.
    const row = await findByTaskId(plan.taskId, opts);
    if (!row) return { ok: true, ignored: "no_request" };
    if (plan.kind === "closed") {
      await markRequest(row.id, "closed", opts);
      return { ok: true, closed: true };
    }
    return finishReviewed(row, opts);
  }

  if (plan.kind === "rx_sent") {
    const row = await findNewestCare(plan.patientId, new Date(now - REQUEST_LOOKBACK_MS).toISOString(), opts);
    if (!row) return { ok: true, ignored: "no_request" };
    if (row.status === "queued") {
      const reviewed = await finishReviewed(row, opts);
      if (reviewed.retry) return reviewed;
    }
    const sent = await mailMilestone(row, "rx_sent", plan.medId || row.id, opts);
    if (sent.retry) return { ok: false, retry: true };
    return { ok: true, rx_sent: Boolean(sent.sent || sent.duplicate || sent.reason === "not_configured" || sent.reason === "opt_out") };
  }
  return { ok: true, ignored: "unhandled" };
}

export async function sweepStaleQueue(opts = {}) {
  const env = opts.env || process.env;
  if (!notifyConfigured()) return { alerted: 0, reason: "not_configured" };
  const now = opts.now || Date.now();
  const storeOpts = { env, fetchImpl: opts.fetchImpl };
  const rows = await listStaleRows(now, env, storeOpts);
  return runStaleAlerts({
    rows,
    now,
    env,
    claim: (row) => claimStaleRow(row, now, env, storeOpts),
    notify: (copy) => notifyPhysician(copy),
    release: (claimed) => releaseStaleRows(claimed, storeOpts),
  });
}

