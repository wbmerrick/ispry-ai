import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import handler, { healthBody } from "./health.js";
import { supabaseConfig } from "./auth-config.js";

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s || ""; },
  };
}

test("health reports config presence and never a secret or an email", () => {
  const prev = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NOTIFY_TO: process.env.NOTIFY_TO,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    AKUTE_API_KEY: process.env.AKUTE_API_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    AKUTE_WEBHOOK_SECRET: process.env.AKUTE_WEBHOOK_SECRET,
  };
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_supersecretvalue";
  process.env.STRIPE_SECRET_KEY = "sk_test_supersecretvalue";
  process.env.RESEND_API_KEY = "re_supersecretvalue";
  process.env.NOTIFY_TO = "physician@example.com";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_supersecret";
  process.env.TURNSTILE_SITE_KEY = "site_key_public";
  process.env.TURNSTILE_SECRET_KEY = "turnstile_secret_value";
  process.env.AKUTE_API_KEY = "akute_secret_value";
  process.env.CRON_SECRET = "cron_secret_value";
  process.env.AKUTE_WEBHOOK_SECRET = "akute_webhook_secret_value";
  try {
    const body = healthBody();
    assert.equal(body.status, "ok");
    assert.equal(body.supabase, true);
    assert.equal(body.supabase_service_role, true);
    assert.equal(body.stripe_webhook_secret, true);
    assert.equal(body.stripe_secret_key, true);
    assert.equal(body.resend, true);
    assert.equal(body.turnstile, true);
    assert.equal(body.akute, true);
    assert.equal(body.cron_secret, true);
    assert.equal(body.akute_webhook_secret, true);
    const raw = JSON.stringify(body);
    for (const secret of [
      "whsec_supersecretvalue",
      "sk_test_supersecretvalue",
      "re_supersecretvalue",
      "physician@example.com",
      "service_role_supersecret",
      "turnstile_secret_value",
      "akute_secret_value",
      "cron_secret_value",
      "akute_webhook_secret_value",
      supabaseConfig().anon,
    ]) {
      assert.equal(raw.includes(secret), false, secret);
    }
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("resend and turnstile are false until both of their env vars are set", () => {
  const prev = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NOTIFY_TO: process.env.NOTIFY_TO,
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const body = healthBody();
    assert.equal(body.resend, false);
    assert.equal(body.turnstile, false);
    assert.equal(body.stripe_webhook_secret, false);
    process.env.RESEND_API_KEY = "re_only";
    assert.equal(healthBody().resend, false);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("GET /api/health does not require an Origin and rejects other methods", async () => {
  const ok = mockRes();
  await handler({ method: "GET", headers: {} }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["Cache-Control"], "no-store");
  assert.equal(JSON.parse(ok.body).status, "ok");

  const denied = mockRes();
  await handler({ method: "POST", headers: { origin: "https://evil.example" } }, denied);
  assert.equal(denied.statusCode, 405);
});

test("vercel serves the health function and leaves cleanUrls off so 404.html is the not-found page", async () => {
  const vercel = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "vercel.json"), "utf8"));
  assert.equal(vercel.cleanUrls, false);
  assert.equal(vercel.outputDirectory, "public");
  assert.ok(vercel.functions["api/health.js"]);
  const src = await readFile(new URL("./health.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /originAllowed/);
});
