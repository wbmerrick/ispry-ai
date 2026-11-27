import test from "node:test";
import assert from "node:assert/strict";
import handler from "./employer-interest.js";

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s; },
  };
}

const reqBase = {
  headers: { origin: "https://ispry.ai", "x-forwarded-for": "203.0.113.10" },
};

test("employer inquiry rejects a missing email and hides the honeypot", async () => {
  const bad = mockRes();
  await handler({ ...reqBase, method: "POST", body: { name: "Ada", organization: "Mill" } }, bad);
  assert.equal(bad.statusCode, 400);

  const bot = mockRes();
  await handler({ ...reqBase, method: "POST", body: { name: "Ada", organization: "Mill", email: "a@b.co", website: "http://spam" } }, bot);
  assert.equal(bot.statusCode, 200);
  assert.equal(JSON.parse(bot.body).ok, true);
});

test("employer inquiry emails the office and does not invent a price", async () => {
  const prev = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NOTIFY_TO: process.env.NOTIFY_TO,
    NOTIFY_FROM: process.env.NOTIFY_FROM,
  };
  process.env.RESEND_API_KEY = "re_test";
  process.env.NOTIFY_TO = "office@example.com";
  process.env.NOTIFY_FROM = "iSpry <notify@ispry.ai>";
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  try {
    const res = mockRes();
    await handler({
      ...reqBase,
      headers: { ...reqBase.headers, "x-forwarded-for": "203.0.113.11" },
      method: "POST",
      body: { name: "Ada Lovelace", organization: "Mill Co", email: "ada@mill.example", note: "20 employees" },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(sent.url, "https://api.resend.com/emails");
    assert.match(sent.body.text, /Mill Co/);
    assert.match(sent.body.text, /No employer price is published/);
    assert.doesNotMatch(sent.body.text, /\$\d+/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
