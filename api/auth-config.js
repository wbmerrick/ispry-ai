// iSpry.ai — public Supabase Auth config for the browser account gate.
// Returns only the project URL and anon/publishable key (safe for the client).
// Optional env: SUPABASE_URL, SUPABASE_ANON_KEY (or NEXT_PUBLIC_* aliases).

import { originAllowed, rateLimit } from "./_lib/guard.js";

const DEFAULT_URL = "https://jodcpflzbmhnnivtwghw.supabase.co";
const DEFAULT_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvZGNwZmx6Ym1obm5pdnR3Z2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMTM0NDIsImV4cCI6MjEwNTY4OTQ0Mn0.Jf3_CjQ_UALHyMvzhQTxisEvSqCK7AAM-DaKe0KJNG8";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function safeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:") return null;
    if (!u.hostname.endsWith(".supabase.co")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });
  const limit = rateLimit(req, { name: "auth-config", limit: 60, windowMs: 60_000 });
  if (!limit.ok) return json(res, 429, { error: "rate" });

  const url =
    safeUrl(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) || DEFAULT_URL;
  const anon = String(
    process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      DEFAULT_ANON,
  ).trim();

  return json(res, 200, {
    configured: Boolean(url && anon),
    supabase_url: url,
    anon_key: anon,
    auth_mode: "magic_link",
    email_redirect_hint: "https://ispry.ai/",
  });
}
