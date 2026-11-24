import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ALERT_WINDOW_MS, alertRouteFailure, claimAlertSlot, safeOpsError } from "./_lib/alert.js";

test("ops errors keep a status line and drop conditions, emails, and phones", () => {
  const akute = safeOpsError(new Error("Akute POST /tasks -> 502 sore throat patient@example.com 731-415-0724"));
  assert.equal(akute.errorClass, "Error");
  assert.equal(akute.message, "Akute POST /tasks -> 502");

  const stripe = safeOpsError(new Error("Stripe /customers/cus_abc -> 500"));
  assert.equal(stripe.message, "Stripe /customers/cus_abc -> 500");

  const clinical = safeOpsError(new Error("patient said chest pain and wants a GLP-1"));
  assert.equal(clinical.message, "Error");
  assert.doesNotMatch(clinical.message, /chest|GLP|patient said/i);

  const named = safeOpsError(Object.assign(new Error("tts_failed"), { name: "VoiceError" }));
  assert.equal(named.errorClass, "VoiceError");
  assert.equal(named.message, "tts_failed");
});

test("one alert per error type per 15 minutes", () => {
  const store = new Map();
  const t0 = 1_700_000_000_000;
  assert.equal(claimAlertSlot("spry:Error:all_models_failed", t0, store), true);
  assert.equal(claimAlertSlot("spry:Error:all_models_failed", t0 + 60_000, store), false);
  assert.equal(claimAlertSlot("handoff:Error:Akute POST /tasks -> 502", t0 + 60_000, store), true);
  assert.equal(claimAlertSlot("spry:Error:all_models_failed", t0 + ALERT_WINDOW_MS, store), true);
});

test("the alert email is route, class, message, and request id", async () => {
  const store = new Map();
  const sent = [];
  const req = { headers: { "x-vercel-id": "iad1::abc-123", "x-request-id": "ignore" } };
  const err = new Error("Akute POST /patients -> 500 chest pain patient@example.com");
  const first = await alertRouteFailure(req, { route: "handoff", error: err, status: 502 }, {
    store,
    now: 10,
    notify: async (msg) => { sent.push(msg); return { sent: true }; },
  });
  assert.equal(first.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /handoff/);
  assert.match(sent[0].text, /Route: handoff/);
  assert.match(sent[0].text, /Error: Error/);
  assert.match(sent[0].text, /Message: Akute POST \/patients -> 500/);
  assert.match(sent[0].text, /Request id: iad1::abc-123/);
  assert.match(sent[0].text, /Status: 502/);
  assert.doesNotMatch(sent[0].text, /chest pain|patient@example.com/i);

  const second = await alertRouteFailure(req, { route: "handoff", error: err, status: 502 }, {
    store,
    now: 11,
    notify: async (msg) => { sent.push(msg); return { sent: true }; },
  });
  assert.equal(second.reason, "rate_limited");
  assert.equal(sent.length, 1);
});

test("spry, speak, handoff, checkout, and the stripe webhook alert on failure", async () => {
  const root = new URL(".", import.meta.url);
  for (const name of ["spry.js", "speak.js", "handoff.js", "checkout.js", "stripe-webhook.js"]) {
    const src = await readFile(new URL(name, root), "utf8");
    assert.match(src, /alertRouteFailure/, name);
  }
});
