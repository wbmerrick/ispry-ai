import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rememberStripeEvent, stripeEventAlreadyProcessed } from "./_lib/stripe-events.js";

const EVENT = { id: "evt_abcdefghij1234", type: "charge.refunded" };

function fetchOk(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

test("a missing service role key does not block the webhook", async () => {
  let called = false;
  const opts = { env: {}, fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => [] }; } };
  const seen = await stripeEventAlreadyProcessed(EVENT, opts);
  const saved = await rememberStripeEvent(EVENT, opts);
  assert.deepEqual(seen, { duplicate: false, reason: "not_configured" });
  assert.deepEqual(saved, { recorded: false, reason: "not_configured" });
  assert.equal(called, false);
});

test("a stored event id is a duplicate and a new id is not", async () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: "service_role_test" };
  const fresh = await stripeEventAlreadyProcessed(EVENT, {
    env,
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: fetchOk([]),
  });
  assert.equal(fresh.duplicate, false);
  const again = await stripeEventAlreadyProcessed(EVENT, {
    env,
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: fetchOk([{ event_id: EVENT.id }]),
  });
  assert.equal(again.duplicate, true);
});

test("a store outage fails open", async () => {
  const opts = {
    env: { SUPABASE_SERVICE_ROLE_KEY: "service_role_test" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async () => { throw new Error("network"); },
  };
  const seen = await stripeEventAlreadyProcessed(EVENT, opts);
  assert.equal(seen.duplicate, false);
  assert.equal(seen.reason, "unreachable");
});

test("remember stores only the id and type", async () => {
  let body = "";
  const saved = await rememberStripeEvent(
    { id: EVENT.id, type: "charge.dispute.created", data: { object: { receipt_email: "patient@example.com", description: "sore throat" } } },
    {
      env: { SUPABASE_SERVICE_ROLE_KEY: "service_role_test" },
      supabaseUrl: "https://example.supabase.co",
      fetchImpl: async (url, opts) => {
        assert.match(String(url), /\/rest\/v1\/ispry_stripe_events$/);
        assert.equal(opts.method, "POST");
        body = opts.body;
        return { ok: true, status: 201, json: async () => ({}) };
      },
    },
  );
  assert.equal(saved.recorded, true);
  assert.deepEqual(JSON.parse(body), { event_id: EVENT.id, event_type: "charge.dispute.created" });
  assert.doesNotMatch(body, /patient@example.com|sore throat/);
});

test("a conflict on insert counts as already recorded", async () => {
  const saved = await rememberStripeEvent(EVENT, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "service_role_test" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({}) }),
  });
  assert.deepEqual(saved, { recorded: true, duplicate: true });
});

test("the stripe events migration is service-role only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261124120000_ispry_stripe_events.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.ispry_stripe_events from public, anon, authenticated/);
  assert.match(sql, /grant select, insert on table public\.ispry_stripe_events to service_role/);
  assert.doesNotMatch(sql, /to anon/);
  assert.doesNotMatch(sql, /to authenticated/);
  const table = sql.slice(sql.indexOf("create table"));
  assert.doesNotMatch(table, /email|payload|patient_id/);
});
