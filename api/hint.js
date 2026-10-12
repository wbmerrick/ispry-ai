// iSpry.ai — public Hint Health membership signup link.
// Hint bills the $100/month membership and syncs plan status into Akute.
// This route returns only that public URL. It does not accept patient data.
// Set HINT_SIGNUP_URL to the page under Hint Admin → Online Signup
// (the practice link is https://ispry.hint.com/signup once that subdomain exists).
// Until it is set, Join stays on the SpryMD membership checkout.

import { originAllowed, rateLimit, safeHintSignupUrl } from "./_lib/guard.js";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });
  const limit = rateLimit(req, { name: "hint", limit: 60, windowMs: 60_000 });
  if (!limit.ok) return json(res, 429, { error: "rate" });
  const signupUrl = safeHintSignupUrl(process.env.HINT_SIGNUP_URL || "");
  return json(res, 200, {
    configured: Boolean(signupUrl),
    signup_url: signupUrl || null,
  });
}
