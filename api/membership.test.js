import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyMembershipPatch,
  grantsMemberBenefits,
  MEMBERSHIP_FRESH_MS,
  membershipWriteIsNewer,
  resolveMembership,
} from "./_lib/membership.js";
import memberHandler from "./member.js";
import handoffHandler from "./handoff.js";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "patient@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
};

function call(handler, req) {
  const headers = { origin: "https://ispry.ai", ...(req.headers || {}) };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
    };
    handler({ url: req.url || "/api/member", ...req, headers }, res);
  });
}

test("the membership migration is service-role only and stores no clinical text", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261126120000_ispry_memberships.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.ispry_memberships from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on table public\.ispry_memberships to service_role/);
  assert.match(sql, /excluded\.status_at >= m\.status_at/);
  assert.match(sql, /ispry_apply_membership/);
  assert.doesNotMatch(sql, /to anon/);
  assert.doesNotMatch(sql, /to authenticated/);
  assert.doesNotMatch(sql, /summary|diagnosis|condition|phone/);
});

test("only active and trialing grant member benefits", () => {
  for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "none"]) {
    assert.equal(grantsMemberBenefits({ status }), false, status);
  }
  assert.equal(grantsMemberBenefits({ status: "active" }), true);
  assert.equal(grantsMemberBenefits({ status: "trialing" }), true);
  assert.equal(grantsMemberBenefits({ status: "active", cancel_at_period_end: true }), true);
  assert.equal(grantsMemberBenefits({ status: "active", stale: true }), false);
  assert.equal(grantsMemberBenefits({ status: "active", unconfirmed: true }), false);
});

test("an older stripe time does not replace a newer stored status", () => {
  assert.equal(membershipWriteIsNewer("2026-11-20T00:00:00.000Z", "2026-11-01T00:00:00.000Z"), false);
  assert.equal(membershipWriteIsNewer("2026-11-01T00:00:00.000Z", "2026-11-20T00:00:00.000Z"), true);
  assert.equal(membershipWriteIsNewer("", "2026-11-20T00:00:00.000Z"), true);
  assert.equal(membershipWriteIsNewer("2026-11-20T00:00:00.000Z", ""), false);
});

test("a fresh stored status is used without calling Stripe", async () => {
  const urls = [];
  const now = Date.now();
  const row = await resolveMembership("Patient@Example.com", {
    now,
    env: { SUPABASE_SERVICE_ROLE_KEY: "k", STRIPE_SECRET_KEY: "sk" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify([{
        email: "patient@example.com",
        status: "past_due",
        updated_at: new Date(now).toISOString(),
      }]), { status: 200 });
    },
  });
  assert.equal(row.benefits, false);
  assert.equal(row.status, "past_due");
  assert.equal(urls.some((u) => u.includes("api.stripe.com")), false);
});

test("a stale active row falls back to Stripe and does not keep the old benefit", async () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  let saved = null;
  const row = await resolveMembership("patient@example.com", {
    now,
    env: { SUPABASE_SERVICE_ROLE_KEY: "k", STRIPE_SECRET_KEY: "sk" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("ispry_memberships?email=")) {
        return new Response(JSON.stringify([{
          email: "patient@example.com",
          status: "active",
          updated_at: new Date(now - MEMBERSHIP_FRESH_MS - 1000).toISOString(),
        }]), { status: 200 });
      }
      if (u.includes("/customers?")) return new Response(JSON.stringify({ data: [{ id: "cus_abc" }] }), { status: 200 });
      if (u.includes("/subscriptions?")) {
        return new Response(JSON.stringify({ data: [{ id: "sub_abc", status: "canceled", customer: "cus_abc" }] }), { status: 200 });
      }
      if (u.includes("/rpc/ispry_apply_membership") && init?.method === "POST") {
        saved = JSON.parse(init.body);
        return new Response(JSON.stringify({ applied: true }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    },
  });
  assert.equal(saved.p_status, "canceled");
  assert.equal(saved.p_status_at, new Date(now).toISOString());
  assert.equal(row.benefits, false);
  assert.equal(row.status, "canceled");
});

test("stripe failure with no fresh row does not grant benefits", async () => {
  const row = await resolveMembership("patient@example.com", {
    env: { SUPABASE_SERVICE_ROLE_KEY: "k", STRIPE_SECRET_KEY: "sk" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (url) => {
      if (String(url).includes("ispry_memberships")) return new Response("[]", { status: 200 });
      return new Response("no", { status: 500 });
    },
  });
  assert.equal(row.benefits, false);
  assert.equal(row.unconfirmed, true);
});

test("a missing membership table does not throw, so the Akute task can still be filed", async () => {
  const result = await applyMembershipPatch({
    status: "active",
    email: "patient@example.com",
    status_at: "2026-11-26T12:00:00.000Z",
    stripe_customer_id: "cus_abc",
    stripe_subscription_id: "sub_abc",
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "k" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async () => new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 }),
  });
  assert.equal(result.saved, false);
  assert.equal(result.reason, "http_404");
});

test("a delayed stripe event does not refresh the membership cache", async () => {
  const calls = [];
  const result = await applyMembershipPatch({
    status: "active",
    email: "patient@example.com",
    status_at: "2026-11-01T00:00:00.000Z",
    stripe_customer_id: "cus_abc",
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "k" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      if (String(url).includes("email=eq.")) {
        return new Response(JSON.stringify([{
          email: "patient@example.com",
          status: "canceled",
          status_at: "2026-11-20T00:00:00.000Z",
          updated_at: new Date().toISOString(),
        }]), { status: 200 });
      }
      return new Response("should not write", { status: 500 });
    },
  });
  assert.equal(result.saved, false);
  assert.equal(result.reason, "stale_event");
  assert.equal(calls.some((c) => c.includes("ispry_apply_membership")), false);
});

test("a webhook patch without an email loads it from the Stripe customer", async () => {
  let saved = null;
  const result = await applyMembershipPatch({
    status: "past_due",
    status_at: "2026-11-26T12:00:00.000Z",
    stripe_customer_id: "cus_abc",
    stripe_subscription_id: "sub_abc",
  }, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "k", STRIPE_SECRET_KEY: "sk" },
    supabaseUrl: "https://example.supabase.co",
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("or=(")) return new Response("[]", { status: 200 });
      if (u.includes("/customers/cus_abc")) {
        return new Response(JSON.stringify({ id: "cus_abc", email: "Patient@Example.com" }), { status: 200 });
      }
      if (init?.method === "POST") {
        saved = JSON.parse(init.body);
        return new Response(JSON.stringify([saved]), { status: 201 });
      }
      return new Response("no", { status: 404 });
    },
  });
  assert.equal(result.saved, true);
  assert.equal(saved.p_email, "patient@example.com");
  assert.equal(saved.p_status, "past_due");
  assert.equal(saved.p_status_at, "2026-11-26T12:00:00.000Z");
  assert.equal(saved.p_cancel_at_period_end, null);
});

function stripeFetch(status) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return new Response(JSON.stringify(USER), { status: 200 });
    if (u.includes("/customers?")) return new Response(JSON.stringify({ data: [{ id: "cus_abc" }] }), { status: 200 });
    if (u.includes("/subscriptions?")) {
      return new Response(JSON.stringify({
        data: [{ id: "sub_abc", status, customer: "cus_abc", cancel_at_period_end: false }],
      }), { status: 200 });
    }
    if (u.includes("akutehealth.com")) {
      const err = new Error("akute should not be called");
      err.akute = true;
      throw err;
    }
    return new Response("no", { status: 404 });
  };
}

const visitBody = {
  first_name: "Ada",
  last_name: "Lovelace",
  date_of_birth: "1990-01-15",
  sex: "female",
  email: "patient@example.com",
  phone: "7315550100",
  in_tennessee: true,
  consent: true,
  summary: "Problem: Sore throat for two days.",
};

test("member requests and included visits are refused when membership is not active", async () => {
  const realFetch = globalThis.fetch;
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAkute = process.env.AKUTE_API_KEY;
  const prevOwner = process.env.AKUTE_USER_ID;
  process.env.STRIPE_SECRET_KEY = "sk_test_membership";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.AKUTE_API_KEY = "akute-test";
  process.env.AKUTE_USER_ID = "owner-test";
  globalThis.fetch = stripeFetch("past_due");
  try {
    const post = await call(memberHandler, {
      method: "POST",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.10" },
      body: { kind: "refill", message: "Please refill my usual medicine.", in_tennessee: true },
    });
    assert.equal(post.status, 402);
    assert.equal(post.body.code, "membership_inactive");
    assert.match(post.body.error, /\$49/);
    assert.match(post.body.error, /resubscribe/i);

    const book = await call(handoffHandler, {
      method: "POST",
      url: "/api/handoff",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.11" },
      body: { ...visitBody, after: "book", pathway: "sore-throat" },
    });
    assert.equal(book.status, 402);
    assert.equal(book.body.code, "membership_inactive");
    assert.ok(book.body.join_url);

    const omitted = await call(handoffHandler, {
      method: "POST",
      url: "/api/handoff",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.12" },
      body: { ...visitBody },
    });
    assert.equal(omitted.status, 402);
  } finally {
    globalThis.fetch = realFetch;
    if (prevStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevStripe;
    if (prevService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
    if (prevAkute === undefined) delete process.env.AKUTE_API_KEY; else process.env.AKUTE_API_KEY = prevAkute;
    if (prevOwner === undefined) delete process.env.AKUTE_USER_ID; else process.env.AKUTE_USER_ID = prevOwner;
  }
});

test("a paid visit is still filed when membership is past due, and an active member is not refused", async () => {
  const realFetch = globalThis.fetch;
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAkute = process.env.AKUTE_API_KEY;
  const prevOwner = process.env.AKUTE_USER_ID;
  process.env.STRIPE_SECRET_KEY = "sk_test_membership";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.AKUTE_API_KEY = "akute-test";
  process.env.AKUTE_USER_ID = "owner-test";
  let akuteCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return new Response(JSON.stringify(USER), { status: 200 });
    if (u.includes("/customers?")) return new Response(JSON.stringify({ data: [{ id: "cus_abc" }] }), { status: 200 });
    if (u.includes("/subscriptions?")) {
      return new Response(JSON.stringify({
        data: [{ id: "sub_abc", status: "past_due", customer: "cus_abc" }],
      }), { status: 200 });
    }
    if (u.includes("akutehealth.com")) {
      akuteCalls += 1;
      return new Response("down", { status: 503 });
    }
    return new Response("no", { status: 404 });
  };
  try {
    const paid = await call(handoffHandler, {
      method: "POST",
      url: "/api/handoff",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.21" },
      body: { ...visitBody, after: "pay", plan: "visit" },
    });
    assert.notEqual(paid.status, 402);
    assert.ok(akuteCalls > 0);

    akuteCalls = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/auth/v1/user")) return new Response(JSON.stringify(USER), { status: 200 });
      if (u.includes("/customers?")) return new Response(JSON.stringify({ data: [{ id: "cus_abc" }] }), { status: 200 });
      if (u.includes("/subscriptions?")) {
        return new Response(JSON.stringify({
          data: [{ id: "sub_abc", status: "active", customer: "cus_abc" }],
        }), { status: 200 });
      }
      if (u.includes("akutehealth.com")) {
        akuteCalls += 1;
        return new Response("down", { status: 503 });
      }
      return new Response("no", { status: 404 });
    };
    const included = await call(handoffHandler, {
      method: "POST",
      url: "/api/handoff",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.22" },
      body: { ...visitBody, after: "book" },
    });
    assert.notEqual(included.status, 402);
    assert.ok(akuteCalls > 0);

    const request = await call(memberHandler, {
      method: "POST",
      headers: { authorization: "Bearer " + "x".repeat(40), "x-forwarded-for": "203.0.113.23" },
      body: { kind: "question", message: "Can you look at my last visit note?", in_tennessee: true },
    });
    assert.equal(request.status, 502);
    assert.notEqual(request.body.code, "membership_inactive");
  } finally {
    globalThis.fetch = realFetch;
    if (prevStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevStripe;
    if (prevService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
    if (prevAkute === undefined) delete process.env.AKUTE_API_KEY; else process.env.AKUTE_API_KEY = prevAkute;
    if (prevOwner === undefined) delete process.env.AKUTE_USER_ID; else process.env.AKUTE_USER_ID = prevOwner;
  }
});
