// Cloudflare Turnstile. A no-op unless BOTH TURNSTILE_SITE_KEY and
// TURNSTILE_SECRET_KEY are set, so local and preview deploys keep working
// until the practice creates a widget.

export function turnstileConfigured(env = process.env) {
  const site = String(env.TURNSTILE_SITE_KEY || "").trim();
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  return Boolean(site && secret);
}

/** Public site key for the browser, or "" when the check is off. */
export function turnstileSiteKey(env = process.env) {
  if (!turnstileConfigured(env)) return "";
  return String(env.TURNSTILE_SITE_KEY).trim();
}

/**
 * Verify a Turnstile token with Cloudflare.
 * skipped: true means the check is off (env unset) and the caller should proceed.
 */
export async function verifyTurnstile(token, ip, env = process.env) {
  if (!turnstileConfigured(env)) return { ok: true, skipped: true };
  const tok = String(token || "").trim();
  if (!tok || tok.length > 2048) return { ok: false, skipped: false };
  const body = new URLSearchParams({
    secret: String(env.TURNSTILE_SECRET_KEY).trim(),
    response: tok,
  });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => null);
    return { ok: Boolean(j && j.success), skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}
