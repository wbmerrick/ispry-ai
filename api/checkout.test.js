import test from "node:test";
import assert from "node:assert/strict";
import { visitUrl, checkoutUrl } from "./checkout.js";

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

test("membership checkout never falls through to an off-Stripe URL", () => {
  const prev = process.env.STRIPE_CHECKOUT_URL;
  process.env.STRIPE_CHECKOUT_URL = "https://evil.example/checkout";
  assert.match(checkoutUrl(), /^https:\/\/buy\.stripe\.com\//);
  if (prev === undefined) delete process.env.STRIPE_CHECKOUT_URL;
  else process.env.STRIPE_CHECKOUT_URL = prev;
});
