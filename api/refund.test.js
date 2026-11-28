import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { patientRefundCopy } from "./_lib/notify.js";
import { sessionUser } from "./_lib/session.js";
import { handleReview } from "./review.js";
import {
  createStripeRefund,
  listRequests,
  matchFailedRefund,
  matchRefundFromCharge,
  patientRefundIdempotencyKey,
  reconcileRefundedCharge,
  recordPaidVisit,
  recordRefundFailed,
  refundIdempotencyKey,
  settleIneligible,
} from "./_lib/refund.js";

const REQ = "22222222-2222-4222-8222-222222222222";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const PHI = /patient@example\.com|sinus|uti|sore throat|semaglutide|diagnosis/i;

function visitRow(extra = {}) {
  return {
    id: REQ,
    plan: "visit",
    source: "checkout",
    email: "patient@example.com",
    amount_cents: 4900,
    stripe_payment_intent_id: "pi_abc12345",
    decision: "",
    refund_status: "",
    refund_id: "",
    ...extra,
  };
}

function harness(initial, createRefund) {
  let row = initial ? { ...initial } : null;
  const audits = [];
  const physicians = [];
  const patients = [];
  const stripe = [];
  return {
    audits,
    physicians,
    patients,
    stripe,
    row: () => row,
    set(patch) { row = { ...row, ...patch }; },
    deps: {
      async load() { return row ? { ...row } : null; },
      async save(_id, patch) {
        row = { ...row, ...patch };
        return { ...row };
      },
      async audit(entry) { audits.push(entry); return { saved: true }; },
      async createRefund(args) {
        stripe.push(args);
        if (createRefund) return createRefund(args, stripe.length);
        return { id: "re_testrefund1", status: "succeeded", charge: "ch_testcharge1" };
      },
      async notifyPhysician(msg) { physicians.push(msg); return { sent: true }; },
      async notifyPatient(msg) { patients.push(msg); return { sent: true }; },
      now: () => "2026-11-28T18:00:00.000Z",
    },
  };
}

function call(req = {}, deps = {}) {
  const headers = { origin: "https://ispry.ai", ...(req.headers || {}) };
  const { headers: _ignored, ...rest } = req;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
    };
    handleReview({ url: "/api/review", ...rest, headers }, res, deps);
  });
}

test("a retry reuses the request idempotency key and does not refund twice", async () => {
  const h = harness(visitRow());
  const first = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(first.action, "refunded");
  assert.equal(first.refund_id, "re_testrefund1");
  assert.equal(h.stripe.length, 1);
  assert.equal(h.stripe[0].idempotencyKey, `ineligible-refund-${REQ}`);
  assert.equal(h.stripe[0].idempotencyKey, refundIdempotencyKey(REQ));
  assert.equal(h.stripe[0].paymentIntent, "pi_abc12345");
  assert.equal(h.patients.length, 1);
  assert.equal(h.patients[0].idempotencyKey, patientRefundIdempotencyKey(REQ));
  assert.equal(h.patients[0].to, "patient@example.com");

  h.set({ refund_status: "pending", refund_id: "" });
  const second = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(second.refund_status, "succeeded");
  assert.equal(h.stripe.length, 2);
  assert.equal(h.stripe[1].idempotencyKey, h.stripe[0].idempotencyKey);

  const third = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(third.action, "already_refunded");
  assert.equal(h.stripe.length, 2);
  assert.ok(h.audits.some((a) => a.action === "ineligible_replay" && a.detail === "already_refunded"));
});

test("a refund that already succeeded retries an unsent patient email and does not call Stripe", async () => {
  const h = harness(visitRow({
    decision: "ineligible",
    refund_status: "succeeded",
    refund_id: "re_testrefund1",
    refund_email_sent_at: "",
  }));
  h.deps.notifyPatient = async (msg) => {
    h.patients.push(msg);
    return h.patients.length === 1 ? { sent: false, reason: "http_502" } : { sent: true };
  };
  const missed = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(missed.action, "already_refunded");
  assert.equal(missed.email_sent, false);
  assert.equal(h.stripe.length, 0);
  assert.equal(h.physicians.length, 1);
  assert.match(h.physicians[0].text, /patient email did not send/i);
  assert.doesNotMatch(`${h.physicians[0].subject}\n${h.physicians[0].text}`, PHI);

  const sent = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(sent.email_sent, true);
  assert.equal(h.stripe.length, 0);
  assert.equal(h.patients.length, 2);
  assert.equal(h.patients[1].idempotencyKey, patientRefundIdempotencyKey(REQ));
  assert.ok(h.row().refund_email_sent_at);
});

test("a membership visit is flagged and the subscription is not refunded", async () => {
  const h = harness({
    id: REQ,
    plan: "membership",
    source: "handoff",
    email: "patient@example.com",
    amount_cents: 10000,
    stripe_payment_intent_id: "pi_shouldnotuse",
  });
  const out = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.action, "member_flagged");
  assert.equal(out.refund_id, null);
  assert.equal(h.stripe.length, 0);
  assert.equal(h.patients.length, 0);
  assert.equal(h.row().refund_status, "member_flagged");
  assert.equal(h.row().decision, "ineligible");
  assert.equal(h.audits[0].action, "ineligible_member_flagged");
  assert.equal(h.audits[0].detail, "member_no_credit_ledger");
  const mail = `${h.physicians[0].subject}\n${h.physicians[0].text}`;
  assert.match(mail, /not refunded/i);
  assert.match(mail, /no visit credit was restored/i);
  assert.doesNotMatch(mail, PHI);

  const again = await settleIneligible(REQ, { id: ACTOR }, h.deps);
  assert.equal(again.action, "already_flagged");
  assert.equal(h.stripe.length, 0);
  assert.equal(h.physicians.length, 1);
});

test("a Stripe failure is logged and emailed to the physician without PHI", async () => {
  const h = harness(visitRow(), () => {
    const err = new Error("card said patient@example.com has a sinus infection");
    err.code = "stripe_402";
    throw err;
  });
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const out = await settleIneligible(REQ, { id: ACTOR }, h.deps);
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(out.refund_status, "failed");
    assert.equal(h.patients.length, 0);
    assert.equal(h.row().refund_status, "failed");
    assert.equal(h.audits[0].action, "ineligible_refund_failed");
    assert.equal(h.audits[0].detail, "stripe_402");
    const mail = `${h.physicians[0].subject}\n${h.physicians[0].text}`;
    assert.match(mail, /did not go through/);
    assert.match(mail, new RegExp(REQ));
    assert.match(mail, /stripe_402/);
    assert.doesNotMatch(mail, PHI);
    const log = errors.join("\n");
    assert.match(log, new RegExp(REQ));
    assert.match(log, /stripe_402/);
    assert.doesNotMatch(log, PHI);
  } finally {
    console.error = orig;
  }
});

test("the patient refund email has no health information", () => {
  const copy = patientRefundCopy();
  assert.match(copy.subject, /refund issued/i);
  assert.match(copy.text, /\$49/);
  assert.match(copy.text, /does not include your symptoms/i);
  assert.doesNotMatch(`${copy.subject}\n${copy.text}`, PHI);
  assert.doesNotMatch(copy.text, /@/);
});

test("only a physician or admin can mark a visit ineligible", async () => {
  const settle = async () => ({ ok: true, status: 200, action: "refunded", refund_status: "succeeded", refund_id: "re_testrefund1", email_sent: true });
  const signedOut = await call({
    method: "POST",
    body: { id: REQ, decision: "ineligible" },
  }, {
    sessionUser: async () => null,
    settle,
  });
  assert.equal(signedOut.status, 401);

  const patient = await call({
    method: "POST",
    body: { id: REQ, decision: "ineligible", email: "patient@example.com", symptoms: "sinus infection" },
  }, {
    sessionUser: async () => ({ id: ACTOR, email: "patient@example.com", role: "" }),
    env: { PHYSICIAN_EMAILS: "physician@example.com" },
    settle,
  });
  assert.equal(patient.status, 403);
  assert.doesNotMatch(JSON.stringify(patient.body), PHI);

  const allowed = await call({
    method: "POST",
    body: { id: REQ, decision: "ineligible" },
  }, {
    sessionUser: async () => ({ id: ACTOR, email: "physician@example.com", role: "" }),
    env: { PHYSICIAN_EMAILS: "Physician@Example.com" },
    settle,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.refund_id, "re_testrefund1");
  assert.equal(allowed.body.email, undefined);

  const admin = await call({
    method: "POST",
    body: { id: REQ, decision: "ineligible" },
  }, {
    sessionUser: async () => ({ id: ACTOR, email: "cover@example.com", role: "admin" }),
    env: { PHYSICIAN_EMAILS: "" },
    settle,
  });
  assert.equal(admin.status, 200);

  const noOrigin = await call({
    method: "POST",
    headers: { origin: "" },
    body: { id: REQ, decision: "ineligible" },
  }, { sessionUser: async () => { throw new Error("should not run"); } });
  assert.equal(noOrigin.status, 403);
});

test("staff role comes from app_metadata, not a user-editable role", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: ACTOR,
    email: "physician@example.com",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { role: "physician" },
    user_metadata: { role: "admin" },
  }), { status: 200 });
  try {
    const user = await sessionUser({ headers: { authorization: `Bearer ${"x".repeat(40)}` } });
    assert.equal(user.role, "physician");
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: ACTOR,
    email: "patient@example.com",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    user_metadata: { role: "physician" },
  }), { status: 200 });
  try {
    const user = await sessionUser({ headers: { authorization: `Bearer ${"y".repeat(40)}` } });
    assert.equal(user.role, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a paid visit record keeps the charge link and drops the condition", async () => {
  let body = "";
  const out = await recordPaidVisit({
    id: "cs_test_abc12345",
    mode: "payment",
    amount_total: 4900,
    payment_intent: "pi_abc12345",
    customer: "cus_abc12345",
    customer_details: { email: "Patient@Example.com" },
    client_reference_id: "pat_1",
    metadata: { condition: "sinus infection" },
    description: "UTI visit",
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-test" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (_url, init) => {
      body = init.body;
      return new Response(JSON.stringify([{ id: JSON.parse(init.body).id }]), { status: 201 });
    },
  });
  assert.equal(out.saved, true);
  assert.match(body, /patient@example.com/);
  assert.doesNotMatch(body, /sinus|sore throat|semaglutide|metadata|description|condition/i);
  const parsed = JSON.parse(body);
  assert.equal(parsed.plan, "visit");
  assert.equal(parsed.amount_cents, 4900);
  assert.equal(parsed.email, "patient@example.com");
  assert.equal(parsed.stripe_payment_intent_id, "pi_abc12345");
  assert.equal(parsed.stripe_checkout_session_id, "cs_test_abc12345");
});

test("Stripe is called with the request idempotency key and not a second amount", async () => {
  const calls = [];
  const env = { STRIPE_SECRET_KEY: "sk_test_example" };
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ id: "re_abc12345", status: "succeeded", charge: "ch_abc12345" }), { status: 200 });
  };
  const key = refundIdempotencyKey(REQ);
  await createStripeRefund({ paymentIntent: "pi_abc12345", requestId: REQ, idempotencyKey: key, env, fetchImpl });
  await createStripeRefund({ paymentIntent: "pi_abc12345", requestId: REQ, idempotencyKey: key, env, fetchImpl });
  assert.equal(calls[0].headers["Idempotency-Key"], key);
  assert.equal(calls[1].headers["Idempotency-Key"], key);
  const decoded = decodeURIComponent(calls[0].body);
  assert.match(decoded, /amount=4900/);
  assert.match(decoded, new RegExp(`metadata\\[ispry_request_id\\]=${REQ}`));
  assert.doesNotMatch(decoded, PHI);
  await assert.rejects(
    () => createStripeRefund({ paymentIntent: "pi_abc12345", requestId: REQ, idempotencyKey: "other-key", env, fetchImpl }),
    (err) => err.code === "bad_idempotency_key",
  );
});

test("charge.refunded reconciliation ignores the condition and can send the refund email once", async () => {
  const match = matchRefundFromCharge({
    id: "ch_abc12345",
    amount: 4900,
    amount_refunded: 4900,
    refunded: true,
    payment_intent: "pi_abc12345",
    description: "sinus infection",
    receipt_email: "patient@example.com",
    metadata: { condition: "UTI" },
    refunds: { data: [{ id: "re_abc12345", metadata: { ispry_request_id: REQ, condition: "sore throat" } }] },
  });
  assert.equal(match.refundStatus, "succeeded");
  assert.equal(match.requestId, REQ);
  assert.equal(match.refundId, "re_abc12345");
  assert.doesNotMatch(JSON.stringify(match), PHI);

  const patients = [];
  const out = await reconcileRefundedCharge({
    id: "ch_abc12345",
    amount: 4900,
    amount_refunded: 4900,
    refunded: true,
    payment_intent: "pi_abc12345",
    description: "sinus infection",
    refunds: { data: [{ id: "re_abc12345", metadata: { ispry_request_id: REQ } }] },
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-test" },
    supabaseUrl: "https://example.supabase.co",
    notifyPatient: async (msg) => { patients.push(msg); return { sent: true }; },
    fetchImpl: async (url, init) => {
      if (init.method === "GET") {
        return new Response(JSON.stringify([{
          id: REQ,
          email: "patient@example.com",
          plan: "visit",
          source: "checkout",
          amount_cents: 4900,
          decision: "ineligible",
          refund_status: "pending",
          stripe_payment_intent_id: "pi_abc12345",
        }]), { status: 200 });
      }
      if (String(url).includes("ispry_audit_log")) return new Response("", { status: 201 });
      const body = JSON.parse(init.body || "{}");
      assert.equal(body.email, undefined);
      assert.doesNotMatch(init.body || "", PHI);
      return new Response(JSON.stringify([{ id: REQ, plan: "visit", refund_status: body.refund_status || "succeeded" }]), { status: 200 });
    },
  });
  assert.equal(out.matched, true);
  assert.equal(out.requestId, REQ);
  assert.equal(out.emailSent, true);
  assert.equal(patients.length, 1);
  assert.equal(patients[0].to, "patient@example.com");
  assert.equal(patients[0].idempotencyKey, patientRefundIdempotencyKey(REQ));
  assert.equal(patients[0].text, undefined);
});

test("a refund.failed event clears a succeeded visit and does not copy the failure text", async () => {
  const match = matchFailedRefund({
    id: "re_abc12345",
    charge: "ch_abc12345",
    failure_reason: "patient has a sore throat",
    metadata: { ispry_request_id: REQ, condition: "UTI" },
  });
  assert.equal(match.failureCode, "refund_failed");
  assert.equal(match.requestId, REQ);
  assert.doesNotMatch(JSON.stringify(match), PHI);

  const physicians = [];
  const out = await recordRefundFailed({
    id: "re_abc12345",
    status: "failed",
    charge: "ch_abc12345",
    payment_intent: "pi_abc12345",
    failure_reason: "patient has a sore throat",
    metadata: { ispry_request_id: REQ, condition: "UTI" },
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-test" },
    supabaseUrl: "https://example.supabase.co",
    notifyPhysician: async (msg) => { physicians.push(msg); return { sent: true }; },
    fetchImpl: async (url, init) => {
      if (init.method === "GET") {
        return new Response(JSON.stringify([{
          id: REQ,
          email: "patient@example.com",
          plan: "visit",
          source: "checkout",
          decision: "ineligible",
          refund_status: "succeeded",
          refund_id: "re_abc12345",
        }]), { status: 200 });
      }
      if (String(url).includes("ispry_audit_log")) {
        assert.equal(JSON.parse(init.body).detail, "refund_failed");
        assert.doesNotMatch(init.body, PHI);
        return new Response("", { status: 201 });
      }
      assert.equal(JSON.parse(init.body).refund_status, "failed");
      assert.doesNotMatch(init.body, PHI);
      return new Response(JSON.stringify([{ id: REQ, plan: "visit", refund_status: "failed" }]), { status: 200 });
    },
  });
  assert.equal(out.refundStatus, "failed");
  assert.equal(out.requestId, REQ);
  assert.match(physicians[0].text, /no longer marked refunded/);
  assert.doesNotMatch(`${physicians[0].subject}\n${physicians[0].text}`, PHI);
});

test("the physician list does not select or return the patient email", async () => {
  let url = "";
  const list = await listRequests({
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-test" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (u) => {
      url = u;
      return new Response(JSON.stringify([{
        id: REQ,
        plan: "visit",
        source: "checkout",
        amount_cents: 4900,
        email: "patient@example.com",
        decision: null,
        refund_status: "succeeded",
        refund_id: "re_abc12345",
        created_at: "2026-11-28T18:00:00.000Z",
        description: "sinus infection",
      }]), { status: 200 });
    },
  });
  assert.match(url, /select=id,plan,source,amount_cents,decision,refund_status,refund_id,created_at/);
  assert.doesNotMatch(url, /email/);
  assert.equal(list.requests[0].email, undefined);
  assert.doesNotMatch(JSON.stringify(list), PHI);
});

test("refund tables enable RLS and are not granted to the browser", async () => {
  const sql = await readFile(path.join(import.meta.dirname, "..", "supabase", "migrations", "20261128180000_ispry_refunds.sql"), "utf8");
  assert.match(sql, /alter table public\.ispry_requests enable row level security/);
  assert.match(sql, /alter table public\.ispry_audit_log enable row level security/);
  assert.match(sql, /revoke all on table public\.ispry_requests from public, anon, authenticated/);
  assert.match(sql, /revoke all on table public\.ispry_audit_log from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on table public\.ispry_requests to service_role/);
  assert.match(sql, /grant select, insert on table public\.ispry_audit_log to service_role/);
  assert.doesNotMatch(sql, /to authenticated/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /wilbur|merrick|will\.jpg|1497231054/i);
});
