// iSpry.ai — Cloudflare Turnstile check for account creation.
// No-op (ok + skipped) when TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are unset.
// Spry verifies its own token on /api/spry; this route is the signup gate.

import { clientIp, originAllowed, rateLimit } from "./_lib/guard.js";
import { verifyTurnstile } from "./_lib/turnstile.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });

  const rl = rateLimit(req, { name: "bot-check", limit: 20, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "rate_limited" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
  }

  const result = await verifyTurnstile(body?.token, clientIp(req));
  if (result.skipped) return json(res, 200, { ok: true, skipped: true });
  if (!result.ok) return json(res, 403, { error: "bot_check" });
  return json(res, 200, { ok: true });
}
