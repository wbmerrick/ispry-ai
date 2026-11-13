import test from "node:test";
import assert from "node:assert/strict";
import handler, { summarizeSubscriptions, sessionUser, REQUEST_KINDS } from "./member.js";
import { countVisitsThisMonth } from "./_lib/akute.js";

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function call(req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
    };
    handler({ headers: {}, url: "/api/member", ...req }, res);
  });
}

test("no subscriptions means no membership", () => {
  assert.deepEqual(summarizeSubscriptions([]), { status: "none", date: null });
  assert.equal(summarizeSubscriptions([{ status: "canceled" }]).status, "none");
});

test("an active subscription wins over an old canceled one and reports its renewal date", () => {
  const out = summarizeSubscriptions([
    { status: "canceled" },
    { status: "active", current_period_end: unix("2026-12-01T00:00:00Z") },
  ]);
  assert.deepEqual(out, { status: "active", date: "2026-12-01" });
});

test("period end is read from subscription items on newer Stripe API versions", () => {
  const out = summarizeSubscriptions([
    { status: "active", items: { data: [{ current_period_end: unix("2026-12-15T00:00:00Z") }] } },
  ]);
  assert.equal(out.date, "2026-12-15");
});

test("a scheduled cancel shows as canceling with its end date", () => {
  const out = summarizeSubscriptions([
    { status: "active", cancel_at_period_end: true, current_period_end: unix("2026-11-30T00:00:00Z") },
  ]);
  assert.deepEqual(out, { status: "canceling", date: "2026-11-30" });
});

test("a failed payment shows as past due", () => {
  assert.equal(summarizeSubscriptions([{ status: "past_due" }]).status, "past_due");
});

test("visit count ignores last month and cancelled or no-show appointments", () => {
  const now = new Date("2026-11-13T18:00:00Z");
  const n = countVisitsThisMonth([
    { start_time: "2026-11-02T15:00:00Z", status: "fulfilled" },
    { start_time: "2026-11-10T15:00:00Z", status: "booked" },
    { start_time: "2026-11-11T15:00:00Z", status: "cancelled" },
    { start_time: "2026-11-12T15:00:00Z", status: "noshow" },
    { start_time: "2026-10-30T15:00:00Z", status: "fulfilled" },
  ], now);
  assert.equal(n, 2);
});

test("a request without a session token is refused before any lookup", async () => {
  assert.equal(await sessionUser({ headers: {} }), null);
  assert.equal(await sessionUser({ headers: { authorization: "Bearer short" } }), null);
  const get = await call({ method: "GET" });
  assert.equal(get.status, 401);
  const post = await call({ method: "POST", body: { kind: "refill", message: "Need my refill please", in_tennessee: true } });
  assert.equal(post.status, 401);
});

test("an unconfirmed email is not a signed-in member", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "u1", email: "a@b.co" }), { status: 200 });
  try {
    const u = await sessionUser({ headers: { authorization: "Bearer " + "x".repeat(40) } });
    assert.equal(u, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("other origins are refused and the probe answers without a session", async () => {
  const bad = await call({ method: "GET", headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  const probe = await call({ method: "GET", url: "/api/member?check=1" });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);
});

test("request kinds are a fixed list", () => {
  assert.deepEqual(Object.keys(REQUEST_KINDS), ["refill", "followup", "question"]);
});
