// Public liveness probe for an external uptime monitor (UptimeRobot or the
// GitHub Actions check). No Origin check: those monitors do not send one.
// Booleans only — never secret values, emails, or patient information.

import { supabaseConfig } from "./auth-config.js";
import { turnstileConfigured } from "./_lib/turnstile.js";

export function healthBody(env = process.env) {
  const { url, anon } = supabaseConfig();
  const set = (name) => Boolean(String(env[name] || "").trim());
  return {
    status: "ok",
    supabase: Boolean(url && anon),
    supabase_service_role: set("SUPABASE_SERVICE_ROLE_KEY"),
    stripe_webhook_secret: set("STRIPE_WEBHOOK_SECRET"),
    stripe_secret_key: set("STRIPE_SECRET_KEY"),
    resend: set("RESEND_API_KEY") && set("NOTIFY_TO"),
    turnstile: turnstileConfigured(env),
    akute: set("AKUTE_API_KEY"),
    cron_secret: set("CRON_SECRET"),
    akute_webhook_secret: set("AKUTE_WEBHOOK_SECRET") || set("AKUTE_MEDICATION_WEBHOOK_SECRET"),
  };
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "GET only" });
  return json(res, 200, healthBody());
}
