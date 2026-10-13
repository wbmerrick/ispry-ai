// iSpry.ai — public Hint Health membership signup link.
// Hint bills the $100/month membership and syncs plan status into Akute.
// This route returns only that public URL. It does not accept patient data.
// Default enrollment page is the iSpry Hint practice. HINT_SIGNUP_URL may
// replace it with another https://*.hint.com signup link from Hint Admin.

import { originAllowed, rateLimit, safeHintSignupUrl } from "./_lib/guard.js";

const DEFAULT_SIGNUP = "https://ispry.hint.com/signup";

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
  const signupUrl = safeHintSignupUrl(process.env.HINT_SIGNUP_URL || "") || DEFAULT_SIGNUP;
  return json(res, 200, {
    configured: true,
    signup_url: signupUrl,
  });
}
