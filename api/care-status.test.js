import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyAkuteEvent } from "./_lib/care-flow.js";
import { GET as cronGET } from "./stale-queue.js";
import { POST as akutePOST } from "./akute-webhook.js";
import { planStripeEvent } from "./stripe-webhook.js";
import {
  authorizeCron,
  deliverStatus,
  escalationMinutes,
  isStale,
  planAkuteEvent,
  runStaleAlerts,
  rxEventIsFresh,
  safeNoticeKey,
  staleAlertCopy,
  staleMinutes,
  statusCopy,
  statusEmailAllowed,
  statusMailIsSafe,
  verifyAkuteSignature,
} from "./_lib/care-status.js";

const POISON = ["semaglutide", "lisinopril", "sore throat", "UTI", "Jane Doe"];

function sign(raw, secret, t) {
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function queued(now, minutes, extra = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "queued",
    submitted_at: new Date(now - minutes * 60 * 1000).toISOString(),
    symptom: "UTI",
    drug: "semaglutide",
    patient_email: "patient@example.com",
    ...extra,
  };
}

test("the stale threshold defaults to 60 minutes and honors an override", () => {
  const now = Date.parse("2026-11-28T18:00:00.000Z");
  const env = { STALE_QUEUE_MINUTES: "60", STALE_ALERT_WINDOW_MINUTES: "60" };
  assert.equal(staleMinutes({}), 60);
  assert.equal(staleMinutes({ STALE_QUEUE_MINUTES: "0" }), 60);
  assert.equal(staleMinutes({ STALE_QUEUE_MINUTES: "nope" }), 60);
  assert.equal(escalationMinutes({ STALE_QUEUE_MINUTES: "45" }), 45);
  assert.equal(isStale(queued(now, 59), now, env), false);
  assert.equal(isStale(queued(now, 60), now, env), true);
  assert.equal(isStale(queued(now, 60 - 1 / 60), now, env), false);
  assert.equal(isStale(queued(now, 14), now, { STALE_QUEUE_MINUTES: "15" }), false);
  assert.equal(isStale(queued(now, 15), now, { STALE_QUEUE_MINUTES: "15" }), true);
  assert.equal(isStale(queued(now, 180, { status: "awaiting_payment" }), now, env), false);
  assert.equal(isStale(queued(now, 180, { status: "reviewed" }), now, env), false);
  assert.equal(isStale(queued(now, 180, { status: "closed" }), now, env), false);
});

test("a stale request is alerted once per escalation window", async () => {
  const now = Date.parse("2026-11-28T18:00:00.000Z");
  const env = { STALE_QUEUE_MINUTES: "60", STALE_ALERT_WINDOW_MINUTES: "60" };
  const emails = [];
  const claimed = new Set();
  const claim = async (row) => {
    if (claimed.has(row.id)) return false;
    claimed.add(row.id);
    return true;
  };
  const release = async (rows) => {
    for (const row of rows) claimed.delete(row.id);
  };
  const notify = async (copy) => {
    emails.push(copy);
    return { sent: true };
  };
  const rows = [queued(now, 90)];
  const first = await runStaleAlerts({ rows, now, env, claim, notify, release });
  assert.equal(first.alerted, 1);
  assert.equal(emails[0].text, staleAlertCopy(1, 60).text);
  for (const word of POISON) assert.equal(emails[0].subject.includes(word) || emails[0].text.includes(word), false, word);
  assert.doesNotMatch(emails[0].text, /patient@example\.com/);
  assert.match(emails[0].text, /1 paid or submitted request is still waiting for review after 60 minutes/);

  const inside = [queued(now, 90, { stale_alerted_at: new Date(now - 30 * 60 * 1000).toISOString() })];
  const second = await runStaleAlerts({ rows: inside, now, env, claim, notify, release });
  assert.equal(second.alerted, 0);
  assert.equal(emails.length, 1);

  const again = [queued(now, 90, { stale_alerted_at: new Date(now - 60 * 60 * 1000).toISOString() })];
  const third = await runStaleAlerts({ rows: again, now, env, claim: async () => false, notify, release });
  assert.equal(third.alerted, 0);
  assert.equal(emails.length, 1);

  const retrySet = new Set();
  const retryClaim = async (row) => {
    if (retrySet.has(row.id)) return false;
    retrySet.add(row.id);
    return true;
  };
  const retryRelease = async (list) => {
    for (const row of list) retrySet.delete(row.id);
  };
  const failed = await runStaleAlerts({
    rows,
    now,
    env,
    claim: retryClaim,
    notify: async () => ({ sent: false, reason: "error" }),
    release: retryRelease,
  });
  assert.equal(failed.failed, true);
  assert.equal(retrySet.size, 0);
  const retried = await runStaleAlerts({ rows, now, env, claim: retryClaim, notify, release: retryRelease });
  assert.equal(retried.alerted, 1);
  assert.equal(emails.length, 2);
});

test("status email copy is fixed and contains no clinical detail", async () => {
  for (const kind of ["received", "reviewed", "rx_sent"]) {
    const copy = statusCopy(kind);
    assert.equal(statusMailIsSafe(copy), true);
    assert.match(copy.text, /https:\/\/ispry\.ai\/member\.html/);
    for (const word of POISON) {
      assert.equal(`${copy.subject}\n${copy.text}`.includes(word), false, word);
    }
  }
  assert.equal(statusCopy("diagnosis"), null);
  assert.equal(statusEmailAllowed(undefined), true);
  assert.equal(statusEmailAllowed({ status_email: false }), false);
  assert.equal(statusEmailAllowed({ email_opt_out: true }), false);

  const event = {
    resource_type: "Medications",
    event_type: "update",
    patient_id: "pat_123",
    patient_name: "Jane Doe",
    data: {
      id: "med_abc123",
      status: "sent",
      name: "semaglutide",
      sig: "sore throat lisinopril",
      diagnosis: "UTI",
    },
  };
  const plan = planAkuteEvent(event);
  assert.equal(plan.kind, "rx_sent");
  assert.equal(plan.medId, "med_abc123");
  const planned = JSON.stringify(plan);
  for (const word of POISON) assert.equal(planned.includes(word), false, word);

  const sent = [];
  const keys = new Set();
  const deps = {
    configured: true,
    claim: async (key) => {
      if (keys.has(key)) return { duplicate: true };
      keys.add(key);
      return { claimed: true };
    },
    release: async (key) => { keys.delete(key); },
    send: async (_to, copy) => { sent.push(copy); return { sent: true }; },
  };
  const first = await deliverStatus({
    to: "patient@example.com",
    kind: plan.kind,
    noticeKey: safeNoticeKey(plan.kind, plan.medId),
    drug: "semaglutide",
    symptoms: "sore throat",
  }, deps);
  assert.equal(first.sent, true);
  assert.equal(sent[0].text, statusCopy("rx_sent").text);
  for (const word of POISON) assert.equal(JSON.stringify(sent[0]).includes(word), false, word);
  const second = await deliverStatus({
    to: "patient@example.com",
    kind: "rx_sent",
    noticeKey: safeNoticeKey("rx_sent", plan.medId),
  }, deps);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 1);
  const opted = await deliverStatus({
    to: "patient@example.com",
    kind: "received",
    noticeKey: safeNoticeKey("received", "550e8400-e29b-41d4-a716-446655440000"),
    optOut: true,
  }, deps);
  assert.equal(opted.reason, "opt_out");
  assert.equal(sent.length, 1);
});

test("akute task and medication events keep only ids and a status kind", () => {
  const reviewed = planAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    patient_id: "pat_1",
    data: { id: "task_abc123", status: "Completed", description: "Problem: sore throat semaglutide" },
  });
  assert.equal(reviewed.kind, "reviewed");
  assert.equal(reviewed.taskId, "task_abc123");
  assert.equal(JSON.stringify(reviewed).includes("sore"), false);
  assert.equal(planAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    data: { id: "task_abc123", status: "not-started" },
  }).ignore, "task_open");
  assert.equal(planAkuteEvent({
    resource_type: "Tasks",
    event_type: "create",
    data: { id: "task_abc123", status: "completed" },
  }).ignore, "task_create");
  assert.equal(planAkuteEvent({
    resource_type: "Medications",
    event_type: "update",
    data: { id: "med_abc123", status: "sending", name: "semaglutide" },
  }).ignore, "rx_not_sent");
  assert.equal(planAkuteEvent({
    resource_type: "MedicationHistory",
    event_type: "request",
    data: { medications: [{ name: "lisinopril" }] },
  }).ignore, "unhandled");
  const now = Date.parse("2026-11-28T18:00:00.000Z");
  assert.equal(rxEventIsFresh(now - 49 * 60 * 60 * 1000, now), false);
  assert.equal(rxEventIsFresh(now - 60 * 1000, now), true);
  assert.equal(rxEventIsFresh(0, now), true);
});

test("akute webhook signatures reject a bad, stale, or missing header", () => {
  const secret = "whsec_akute_test";
  const raw = JSON.stringify({ resource_type: "Tasks", event_type: "update", data: { id: "task_1", status: "completed" } });
  const t = 1_700_000_000;
  assert.equal(verifyAkuteSignature(raw, sign(raw, secret, t), secret, t).ok, true);
  assert.equal(verifyAkuteSignature(raw, sign(raw, "other", t), secret, t).reason, "signature_mismatch");
  assert.equal(verifyAkuteSignature(raw, "t=1", secret, t).reason, "malformed_header");
  assert.equal(verifyAkuteSignature(raw, sign(raw, secret, t), secret, t + 301).reason, "timestamp_out_of_tolerance");
  assert.equal(verifyAkuteSignature(raw, sign(raw, secret, t), "", t).reason, "not_configured");
  const pretty = JSON.stringify(JSON.parse(raw), null, 2);
  assert.equal(verifyAkuteSignature(pretty, sign(JSON.stringify(JSON.parse(pretty)), secret, t), secret, t).ok, true);
  assert.equal(verifyAkuteSignature(pretty, sign(pretty, secret, t), secret, t).ok, true);
  assert.equal(authorizeCron("Bearer secret", "secret"), true);
  assert.equal(authorizeCron("Bearer no", "secret"), false);
  assert.equal(authorizeCron("", "secret"), false);
});

test("the webhook route rejects a bad signature and returns no clinical text", async () => {
  const raw = JSON.stringify({
    resource_type: "Medications",
    event_type: "update",
    data: { id: "med_abc123", status: "sent", name: "semaglutide", diagnosis: "UTI" },
  });
  let applied = 0;
  const denied = await akutePOST(new Request("https://ispry.ai/api/akute-webhook", {
    method: "POST",
    headers: { "x-akute-signature": "t=1700000000,v1=deadbeef" },
    body: raw,
  }), {
    env: { AKUTE_WEBHOOK_SECRET: "secret_value_not_logged" },
    nowSec: 1_700_000_000,
    apply: async () => { applied += 1; return { ok: true }; },
  });
  assert.equal(denied.status, 400);
  assert.equal(applied, 0);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error, "bad_signature");
  assert.equal(JSON.stringify(deniedBody).includes("semaglutide"), false);
  assert.equal(JSON.stringify(deniedBody).includes("secret_value_not_logged"), false);

  const secret = "akute_secret_value";
  const t = 1_700_000_000;
  let seen = null;
  const ok = await akutePOST(new Request("https://ispry.ai/api/akute-webhook", {
    method: "POST",
    headers: { "x-akute-signature": sign(raw, secret, t) },
    body: raw,
  }), {
    env: { AKUTE_WEBHOOK_SECRET: secret },
    nowSec: t,
    apply: async (event) => {
      seen = planAkuteEvent(event);
      return { ok: true };
    },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes("semaglutide"), false);
  assert.equal(JSON.stringify(body).includes("UTI"), false);
  assert.equal(seen.kind, "rx_sent");
  assert.equal(JSON.stringify(seen).includes("semaglutide"), false);
});

test("the cron route stays closed without CRON_SECRET and without the bearer token", async () => {
  const missing = await cronGET(new Request("https://ispry.ai/api/stale-queue"), { env: {} });
  assert.equal(missing.status, 503);
  let swept = 0;
  const denied = await cronGET(new Request("https://ispry.ai/api/stale-queue", {
    headers: { authorization: "Bearer wrong" },
  }), {
    env: { CRON_SECRET: "cron-secret-value" },
    sweep: async () => { swept += 1; return { alerted: 1 }; },
  });
  assert.equal(denied.status, 401);
  assert.equal(swept, 0);
  const ok = await cronGET(new Request("https://ispry.ai/api/stale-queue", {
    headers: { authorization: "Bearer cron-secret-value" },
  }), {
    env: { CRON_SECRET: "cron-secret-value" },
    sweep: async () => { swept += 1; return { alerted: 2 }; },
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.deepEqual(okBody, { ok: true, alerted: 2 });
  assert.equal(swept, 1);
  assert.equal(JSON.stringify(okBody).includes("cron-secret-value"), false);
});

test("a paid visit opens a review and a generic membership does not create one", () => {
  const visit = planStripeEvent({
    type: "checkout.session.completed",
    data: { object: { mode: "payment", customer_details: { email: "a@b.co" }, metadata: { condition: "UTI" } } },
  });
  assert.equal(visit.review.kind, "visit");
  assert.equal(visit.review.createIfMissing, true);
  assert.equal(JSON.stringify(visit.review).includes("UTI"), false);
  const generic = planStripeEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        payment_status: "paid",
        customer: "cus_abc",
        subscription: "sub_123",
        customer_details: { email: "a@b.co" },
      },
    },
  });
  assert.equal(generic.review.kind, "membership");
  assert.equal(generic.review.createIfMissing, false);
  const linked = planStripeEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: "pat_1",
        customer: "cus_abc",
        subscription: "sub_123",
        customer_details: { email: "a@b.co" },
      },
    },
  });
  assert.equal(linked.review.createIfMissing, true);
});

const storeEnv = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  SUPABASE_URL: "https://example.supabase.co",
};

test("an unrelated Akute task does not review the patient's open request", async () => {
  const calls = [];
  const out = await applyAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    patient_id: "pat_1",
    data: { id: "other_task", status: "completed", description: "sore throat semaglutide" },
  }, {
    env: storeEnv,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method || "GET" });
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(out.ignored, "no_request");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /akute_task_id=eq\.other_task/);
  assert.equal(JSON.stringify(out).includes("semaglutide"), false);
});

test("a Supabase outage asks Akute to retry instead of dropping the event", async () => {
  const missed = await applyAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    patient_id: "pat_1",
    data: { id: "task_abc", status: "completed" },
  }, {
    env: storeEnv,
    fetchImpl: async () => new Response("busy", { status: 503 }),
  });
  assert.equal(missed.retry, true);

  const down = await applyAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    patient_id: "pat_1",
    data: { id: "task_abc", status: "cancelled" },
  }, {
    env: storeEnv,
    fetchImpl: async () => { throw new Error("socket"); },
  });
  assert.equal(down.retry, true);

  const calls = [];
  const marked = await applyAkuteEvent({
    resource_type: "Tasks",
    event_type: "update",
    data: { id: "task_abc", status: "cancelled" },
  }, {
    env: storeEnv,
    fetchImpl: async (url, init) => {
      const method = init?.method || "GET";
      calls.push(method);
      if (method === "GET") {
        return new Response(JSON.stringify([{
          id: "11111111-1111-4111-8111-111111111111",
          status: "queued",
          patient_email: "patient@example.com",
          akute_task_id: "task_abc",
        }]), { status: 200 });
      }
      return new Response("busy", { status: 503 });
    },
  });
  assert.equal(marked.retry, true);
  assert.deepEqual(calls, ["GET", "PATCH"]);
});

test("the cron is registered and the queue tables are locked to the service role", async () => {
  const vercel = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "vercel.json"), "utf8"));
  const cron = vercel.crons.find((item) => item.path === "/api/stale-queue");
  assert.equal(cron.schedule, "*/15 * * * *");
  assert.ok(vercel.functions["api/stale-queue.js"]);
  assert.ok(vercel.functions["api/akute-webhook.js"]);
  const sql = await readFile(
    path.join(import.meta.dirname, "..", "supabase/migrations/20261128190000_ispry_review_queue.sql"),
    "utf8",
  );
  assert.match(sql, /alter table public\.ispry_review_queue enable row level security/);
  assert.match(sql, /alter table public\.ispry_status_notices enable row level security/);
  assert.match(sql, /revoke all on table public\.ispry_review_queue from public, anon, authenticated/);
  assert.match(sql, /revoke all on table public\.ispry_status_notices from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on table public\.ispry_review_queue to service_role/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /symptom|diagnosis|drug_name|medication_name/i);
});
