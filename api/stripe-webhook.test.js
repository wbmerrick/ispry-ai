import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { physicianNotice, planStripeEvent, processStripeEvent, verifyStripeSignature } from "./stripe-webhook.js";

function sign(raw, secret, t) {
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

test("signature verification still rejects a bad or stale header", () => {
  const secret = "whsec_test";
  const raw = '{"id":"evt_abcdefghij1234"}';
  const t = 1_700_000_000;
  assert.equal(verifyStripeSignature(raw, sign(raw, secret, t), secret, t).ok, true);
  assert.equal(verifyStripeSignature(raw, sign(raw, "other", t), secret, t).reason, "signature_mismatch");
  assert.equal(verifyStripeSignature(raw, "t=1", secret, t).reason, "malformed_header");
  assert.equal(verifyStripeSignature(raw, sign(raw, secret, t), secret, t + 301).reason, "timestamp_out_of_tolerance");
});

test("a full visit refund and a partial refund do not carry the condition", () => {
  const full = planStripeEvent({
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_visit",
        amount: 4900,
        amount_refunded: 4900,
        currency: "usd",
        refunded: true,
        customer: "cus_abc",
        description: "UTI and sore throat",
        receipt_email: "patient@example.com",
        metadata: { ispry_plan: "visit", condition: "sinus infection" },
      },
    },
  });
  assert.equal(full.title, "iSpry one-time visit REFUNDED");
  assert.equal(full.patientHint, "");
  const blob = [full.title, ...full.lines].join("\n");
  assert.match(blob, /in full/);
  assert.match(blob, /patient@example.com/);
  assert.doesNotMatch(blob, /UTI|sore throat|sinus/i);
  assert.equal(full.profile, undefined);
  assert.doesNotMatch(physicianNotice(full.title, ""), /patient@example.com|UTI|sore throat/i);

  const partial = planStripeEvent({
    type: "charge.refunded",
    data: { object: { amount: 10000, amount_refunded: 2000, currency: "usd", refunded: false, metadata: { ispry_plan: "membership" } } },
  });
  assert.equal(partial.title, "iSpry membership partially refunded");
  assert.match(partial.lines.join("\n"), /does not by itself cancel/);
});

test("a dispute uses the reason code and the charge link, not the evidence", () => {
  const plan = planStripeEvent({
    type: "charge.dispute.created",
    data: {
      object: {
        amount: 10000,
        currency: "usd",
        charge: "ch_abc",
        reason: "patient has a sore throat",
        evidence: { customer_name: "Jane Doe", uncategorized_text: "chest pain" },
      },
    },
  }, {
    charge: {
      customer: "cus_abc",
      billing_details: { email: "patient@example.com", name: "Jane Doe" },
      metadata: { akute_patient_id: "pat_123", condition: "hair loss" },
      description: "weight loss visit",
    },
  });
  assert.equal(plan.title, "iSpry payment DISPUTED — hold non-urgent care");
  assert.equal(plan.priority, "p1");
  assert.equal(plan.patientHint, "pat_123");
  assert.equal(plan.email, "patient@example.com");
  const blob = [plan.title, ...plan.lines].join("\n");
  assert.match(blob, /reason code: unspecified/);
  assert.match(blob, /ch_abc/);
  assert.doesNotMatch(blob, /Jane Doe|sore throat|chest pain|hair loss|weight loss/i);
  assert.doesNotMatch(physicianNotice(plan.title, "pat_123"), /patient@example.com|Jane Doe|chest/i);
});

test("a scheduled cancellation still files the existing membership task", () => {
  const plan = planStripeEvent({
    type: "customer.subscription.updated",
    data: {
      object: { id: "sub_123", customer: "cus_abc", cancel_at_period_end: true, current_period_end: 1700000000, metadata: { akute_patient_id: "pat_9" } },
      previous_attributes: { cancel_at_period_end: false },
    },
  });
  assert.match(plan.title, /cancellation scheduled for 2023-11-14/);
  assert.equal(plan.patientHint, "pat_9");
  assert.ok(plan.tags.includes("cancel-scheduled"));
});

test("ending a membership is still a cancellation task and does not invent a profile write", () => {
  const plan = planStripeEvent({
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_123", customer: "cus_abc", metadata: { akute_patient_id: "pat_9" }, ended_at: 1700000000 } },
  });
  assert.equal(plan.title, "iSpry membership CANCELED");
  assert.equal(plan.patientHint, "pat_9");
  assert.match(plan.lines.join("\n"), /no longer an active member/);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.profile, undefined);
});

test("a visit checkout writes the chart link and plan, never the condition", () => {
  const plan = planStripeEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "payment",
        client_reference_id: "pat_1",
        customer: "cus_abc",
        amount_total: 4900,
        currency: "usd",
        customer_details: { email: "patient@example.com" },
        metadata: { condition: "UTI" },
      },
    },
  });
  assert.match(plan.title, /one-time visit PAID/);
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0].form, { "metadata[akute_patient_id]": "pat_1", "metadata[ispry_plan]": "visit" });
  assert.doesNotMatch(JSON.stringify(plan.writes), /UTI/);
});

test("duplicate events are skipped and a failed handle is not recorded", async () => {
  let handled = 0;
  let remembered = 0;
  const event = { id: "evt_abcdefghij1234", type: "charge.refunded" };
  const dup = await processStripeEvent(event, {
    already: async () => ({ duplicate: true }),
    handle: async () => { handled += 1; return { task: true }; },
    remember: async () => { remembered += 1; },
  });
  assert.deepEqual(dup, { received: true, duplicate: true });
  assert.equal(handled, 0);

  const ok = await processStripeEvent(event, {
    already: async () => ({ duplicate: false }),
    handle: async () => { handled += 1; return { task: true, matched: "patient_id" }; },
    remember: async () => { remembered += 1; return { recorded: true }; },
  });
  assert.equal(ok.received, true);
  assert.equal(ok.task, true);
  assert.equal(handled, 1);
  assert.equal(remembered, 1);

  await assert.rejects(() => processStripeEvent(event, {
    already: async () => ({ duplicate: false }),
    handle: async () => { throw new Error("Akute POST /tasks -> 502"); },
    remember: async () => { remembered += 1; },
  }));
  assert.equal(remembered, 1);
});
