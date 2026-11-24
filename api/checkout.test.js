import test from "node:test";
import assert from "node:assert/strict";
import handler, { visitUrl, checkoutUrl } from "./checkout.js";

test("visit checkout stays empty until a Stripe-hosted link is configured", () => {
  const prev = process.env.STRIPE_VISIT_URL;
  delete process.env.STRIPE_VISIT_URL;
  assert.equal(visitUrl(), "");
  process.env.STRIPE_VISIT_URL = "https://example.com/pay";
  assert.equal(visitUrl(), "");
  process.env.STRIPE_VISIT_URL = "https://buy.stripe.com/test_visit_49";
  assert.equal(visitUrl(), "https://buy.stripe.com/test_visit_49");
  if (prev === undefined) delete process.env.STRIPE_VISIT_URL;
  else process.env.STRIPE_VISIT_URL = prev;
});

test("an unexpected checkout failure does not echo the error", async () => {
  const prev = { RESEND_API_KEY: process.env.RESEND_API_KEY, NOTIFY_TO: process.env.NOTIFY_TO };
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s || ""; },
  };
  const req = {
    get method() { throw new Error("chest pain patient@example.com"); },
    headers: { "x-request-id": "req_123" },
  };
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /unavailable/);
    assert.doesNotMatch(res.body, /chest pain|patient@example.com/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("membership checkout never falls through to an off-Stripe URL", () => {
  const prev = process.env.STRIPE_CHECKOUT_URL;
  process.env.STRIPE_CHECKOUT_URL = "https://evil.example/checkout";
  assert.match(checkoutUrl(), /^https:\/\/buy\.stripe\.com\//);
  if (prev === undefined) delete process.env.STRIPE_CHECKOUT_URL;
  else process.env.STRIPE_CHECKOUT_URL = prev;
});
