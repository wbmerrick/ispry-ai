import test from "node:test";
import assert from "node:assert/strict";
import spry from "./spry.js";
import speak from "./speak.js";
import handoff from "./handoff.js";
import botCheck from "./bot-check.js";
import { consumeDailyCap } from "./_lib/usage.js";
import { turnstileConfigured, verifyTurnstile } from "./_lib/turnstile.js";

function call(handler, req = {}) {
  const headers = { origin: "https://ispry.ai", ...(req.headers || {}) };
  const { headers: _ignored, ...rest } = req;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) {
        const ct = String(this.headers["content-type"] || "");
        let parsed = body;
        if (ct.includes("json") && typeof body === "string") {
          try { parsed = JSON.parse(body); } catch { /* keep text */ }
        }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers });
      },
    };
    Promise.resolve(handler({ method: "POST", url: "/", ...rest, headers }, res)).catch((err) => {
      resolve({ status: 500, body: String(err), headers: res.headers });
    });
  });
}

const basics = {
  messages: [{ role: "user", content: "Visit basics — Age: 34. Sex: Female (F). In Tennessee now: Yes.\n\nSore throat." }],
};

test("spry, speak, and handoff reject a signed-out caller", async () => {
  const spryRes = await call(spry, { body: basics });
  assert.equal(spryRes.status, 401);
  assert.equal(spryRes.body.error, "signed_out");

  const speakRes = await call(speak, { body: { text: "Hello from Spry." } });
  assert.equal(speakRes.status, 401);

  const handoffRes = await call(handoff, {
    body: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", summary: "Problem: sore throat" },
  });
  assert.equal(handoffRes.status, 401);
});

test("a visit-basics string is not a session", async () => {
  const res = await call(spry, { body: basics });
  assert.equal(res.status, 401);
});

test("an emergency message is answered without an account", async () => {
  const res = await call(spry, {
    body: { messages: [{ role: "user", content: "I have chest pain and I can't breathe" }] },
  });
  assert.equal(res.status, 200);
  assert.match(String(res.body), /^\[EMERGENCY\]/);
  assert.match(String(res.body), /911/);
});

test("spry and speak POST without an Origin are rejected", async () => {
  const spryRes = await call(spry, { headers: { origin: "" }, body: basics });
  assert.equal(spryRes.status, 403);
  const speakRes = await call(speak, { headers: { origin: "" }, body: { text: "Hello" } });
  assert.equal(speakRes.status, 403);
});

test("config probes answer without a session or an Origin", async () => {
  const spryRes = await call(spry, { method: "GET", url: "/api/spry?check=1", headers: { origin: "" } });
  assert.equal(spryRes.status, 200);
  assert.equal(spryRes.body.ok, true);
  const handoffRes = await call(handoff, { method: "GET", url: "/api/handoff?check=1", headers: { origin: "" } });
  assert.equal(handoffRes.status, 200);
  assert.equal(handoffRes.body.ok, true);
});

test("turnstile is a no-op when its env vars are empty", async () => {
  const skipped = await verifyTurnstile("", "127.0.0.1", {});
  assert.deepEqual(skipped, { ok: true, skipped: true });
  if (turnstileConfigured()) return;
  const res = await call(botCheck, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, true);
});

test("the daily cap is not enforced without a service role key", async () => {
  const res = await consumeDailyCap("11111111-1111-4111-8111-111111111111", "spry", {});
  assert.equal(res.ok, true);
  assert.equal(res.enforced, false);
});
