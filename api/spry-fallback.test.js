import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import spry, { SPRY_UNAVAILABLE_MESSAGE, cloudflareFallbackEnabled } from "./spry.js";
import speak from "./speak.js";

const root = path.join(import.meta.dirname, "..");
const PHI = "zephyr-lilac-complaint-4419";
const UPSTREAM_ECHO = "upstream-echo-must-not-be-logged";
const CF_TOKEN = "cf-token-must-not-leak";
const GATEWAY_KEY = "gateway-test-key";

const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
  "SPRY_CLOUDFLARE_FALLBACK",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "RESEND_API_KEY",
  "NOTIFY_TO",
  "XAI_API_KEY",
  "GROK_API_KEY",
];

function saveEnv() {
  const prev = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  return prev;
}

function restoreEnv(prev) {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function call(handler, req = {}) {
  const headers = { origin: "https://ispry.ai", ...(req.headers || {}) };
  const { headers: _ignored, ...rest } = req;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      chunks: [],
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      write(chunk) {
        this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      },
      end(body) {
        if (body != null) this.chunks.push(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
        const raw = this.chunks.join("");
        const ct = String(this.headers["content-type"] || "");
        let parsed = raw;
        if (ct.includes("json") && raw) {
          try { parsed = JSON.parse(raw); } catch { /* keep text */ }
        }
        resolve({ status: this.statusCode, body: parsed, raw, headers: this.headers });
      },
    };
    Promise.resolve(handler({ method: "POST", url: "/", ...rest, headers }, res)).catch((err) => {
      resolve({ status: 500, body: String(err), raw: String(err), headers: res.headers });
    });
  });
}

function sse(text) {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function authUser() {
  return new Response(JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ada@example.com",
    email_confirmed_at: "2026-01-01T00:00:00Z",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("the Cloudflare model fallback cannot be turned on", () => {
  for (const value of ["1", "true", "on", "yes", "enabled"]) {
    assert.equal(cloudflareFallbackEnabled({ SPRY_CLOUDFLARE_FALLBACK: value }), false, value);
  }
  assert.equal(cloudflareFallbackEnabled({}), false);
  assert.match(SPRY_UNAVAILABLE_MESSAGE, /briefly unavailable/);
  assert.match(SPRY_UNAVAILABLE_MESSAGE, /\(731\) 415-0724/);
  assert.match(SPRY_UNAVAILABLE_MESSAGE, /submit your request/);
  assert.match(SPRY_UNAVAILABLE_MESSAGE, /call 911/);
  assert.doesNotMatch(SPRY_UNAVAILABLE_MESSAGE, /error|failed|urgent/i);
});

test("Spry source, speech, the page, and CSP do not call a Cloudflare model", async () => {
  const sprySrc = await readFile(path.join(root, "api", "spry.js"), "utf8");
  const speakSrc = await readFile(path.join(root, "api", "speak.js"), "utf8");
  const home = await readFile(path.join(root, "public", "home.js"), "utf8");
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const csp = vercel.headers.find((h) => h.source === "/(.*)").headers.find((h) => h.key === "Content-Security-Policy").value;

  for (const src of [sprySrc, speakSrc]) {
    assert.doesNotMatch(src, /api\.cloudflare\.com/);
    assert.doesNotMatch(src, /workers\.ai/);
    assert.doesNotMatch(src, /@cf\//);
  }
  assert.doesNotMatch(sprySrc, /\.text\(\)/);
  assert.match(home, new RegExp(SPRY_UNAVAILABLE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(home, /r\.status === 502/);
  assert.match(home, /tel:\+17314150724/);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CF_ACCOUNT_ID", "SPRY_CLOUDFLARE_FALLBACK"]) {
    assert.match(readme, new RegExp(name));
  }
  assert.match(readme, /fallback stays off/i);
  assert.doesNotMatch(csp, /api\.cloudflare\.com/);
  assert.doesNotMatch(csp, /workers\.ai/);
  assert.match(csp, /https:\/\/challenges\.cloudflare\.com/);
});

test("a gateway failure never reaches Cloudflare and the patient gets a calm message", async () => {
  const prev = saveEnv();
  process.env.CLOUDFLARE_API_TOKEN = CF_TOKEN;
  process.env.CF_API_TOKEN = CF_TOKEN;
  process.env.CF_ACCOUNT_ID = "cf-account-ignored";
  process.env.SPRY_CLOUDFLARE_FALLBACK = "1";
  process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_API_KEY;

  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = typeof init?.body === "string" ? init.body : "";
    const auth = String(init?.headers?.Authorization || init?.headers?.authorization || "");
    calls.push({ url: u, body, auth });
    if (/api\.cloudflare\.com|workers\.ai|@cf\//i.test(u)) {
      return new Response("CLOUDFLARE-MODEL-REPLY", { status: 200 });
    }
    if (u.includes("/auth/v1/user")) return authUser();
    if (u.includes("ai-gateway.vercel.sh")) {
      return new Response(JSON.stringify({ error: UPSTREAM_ECHO, echo: PHI }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  console.error = (...args) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };

  const basics = `Visit basics — Age: 34. Sex: Female (F). In Tennessee now: Yes.\n\n${PHI}`;
  const bearer = { authorization: "Bearer " + "x".repeat(40) };

  try {
    assert.equal(cloudflareFallbackEnabled(), false);

    calls.length = 0;
    const emergency = await call(spry, {
      headers: { "x-forwarded-for": "203.0.113.10" },
      body: { messages: [{ role: "user", content: "I have chest pain" }] },
    });
    assert.equal(emergency.status, 200);
    assert.match(String(emergency.body), /^\[EMERGENCY\]/);
    assert.equal(calls.length, 0);

    calls.length = 0;
    logs.length = 0;
    const failed = await call(spry, {
      headers: { ...bearer, "x-forwarded-for": "203.0.113.11" },
      body: { messages: [{ role: "user", content: basics }] },
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, "spry_unavailable");
    assert.equal(failed.body.message, SPRY_UNAVAILABLE_MESSAGE);
    assert.equal(calls.filter((c) => c.url.includes("ai-gateway.vercel.sh")).length, 3);
    assert.ok(calls.some((c) => c.url.includes("/auth/v1/user")));
    for (const c of calls) {
      assert.doesNotMatch(c.url, /cloudflare|workers\.ai/i);
      assert.equal(c.auth.includes(CF_TOKEN), false);
      if (c.url.includes("ai-gateway.vercel.sh")) {
        assert.match(c.body, new RegExp(PHI));
        assert.match(c.auth, new RegExp(GATEWAY_KEY));
      }
    }
    const logged = logs.join("\n");
    assert.match(logged, /all_models_failed/);
    assert.match(logged, /status=503/);
    assert.doesNotMatch(logged, new RegExp(PHI));
    assert.doesNotMatch(logged, new RegExp(UPSTREAM_ECHO));
    assert.doesNotMatch(logged, new RegExp(CF_TOKEN));
    assert.doesNotMatch(failed.raw, new RegExp(PHI));
    assert.doesNotMatch(failed.raw, /CLOUDFLARE-MODEL-REPLY/);

    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      const auth = String(init?.headers?.Authorization || init?.headers?.authorization || "");
      calls.push({ url: u, body, auth });
      if (/api\.cloudflare\.com|workers\.ai/i.test(u)) return new Response("CLOUDFLARE-MODEL-REPLY", { status: 200 });
      if (u.includes("/auth/v1/user")) return authUser();
      if (u.includes("/v1/chat/completions")) return sse("Most likely: a short reply.");
      if (u.includes("ai-gateway.vercel.sh")) {
        return new Response(JSON.stringify({ error: UPSTREAM_ECHO, echo: PHI }), { status: 503 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const answered = await call(spry, {
      headers: { ...bearer, "x-forwarded-for": "203.0.113.13" },
      body: { messages: [{ role: "user", content: basics }] },
    });
    assert.equal(answered.status, 200);
    assert.match(answered.raw, /Most likely: a short reply/);
    assert.equal(calls.filter((c) => c.url.includes("ai-gateway.vercel.sh")).length, 1);
    for (const c of calls) assert.doesNotMatch(c.url, /cloudflare|workers\.ai/i);

    const probe = await call(spry, { method: "GET", url: "/api/spry?check=1", headers: { origin: "" } });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.ok, true);
    assert.equal(probe.body.gateway_configured, true);
    assert.equal(probe.body.cloudflare_fallback_configured, false);
    assert.equal(JSON.stringify(probe.body).includes(CF_TOKEN), false);

    calls.length = 0;
    logs.length = 0;
    const voice = await call(speak, {
      headers: { ...bearer, "x-forwarded-for": "203.0.113.14" },
      body: { text: `Spry said ${PHI}` },
    });
    assert.equal(voice.status, 502);
    assert.match(String(voice.body.error), /voice is unavailable/);
    const speechCalls = calls.filter((c) => c.url.includes("ai-gateway.vercel.sh"));
    assert.ok(speechCalls.length >= 1);
    for (const c of calls) {
      assert.doesNotMatch(c.url, /cloudflare|workers\.ai/i);
      assert.equal(String(c.auth).includes(CF_TOKEN), false);
    }
    assert.ok(speechCalls.some((c) => c.body.includes(PHI)));
    const voiceLog = logs.join("\n");
    assert.match(voiceLog, /tts_failed/);
    assert.doesNotMatch(voiceLog, new RegExp(PHI));
    assert.doesNotMatch(voiceLog, new RegExp(UPSTREAM_ECHO));
    assert.doesNotMatch(voice.raw, new RegExp(PHI));
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    restoreEnv(prev);
  }
});
