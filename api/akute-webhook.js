// Akute → patient status mail.
// Tasks (update) mark a request reviewed or closed. Medications (update) with
// status sent, verified, or filled mean a prescription reached the pharmacy.
// The email is a fixed sentence and a sign-in link. The payload's drug name,
// sig, and task text are never copied into the email or the response.
//
// Signature: x-akute-signature HMAC-SHA256 over `${t}.${rawBody}` using
// AKUTE_WEBHOOK_SECRET. AKUTE_MEDICATION_WEBHOOK_SECRET is checked too when
// the medication webhook was given a different secret.
// No Origin check: Akute does not send one.

import { applyAkuteEvent } from "./_lib/care-flow.js";
import { akuteWebhookSecrets, verifyAkuteSignature } from "./_lib/care-status.js";

const MAX_BODY = 262144;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function GET() {
  return json({
    ok: true,
    webhook_secret_configured: akuteWebhookSecrets().length > 0,
  });
}

export async function POST(request, deps = {}) {
  const env = deps.env || process.env;
  const secrets = akuteWebhookSecrets(env);
  if (!secrets.length) return json({ error: "not_configured" }, 503);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  const header = request.headers.get("x-akute-signature");
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const check = secrets.some((secret) => verifyAkuteSignature(raw, header, secret, nowSec).ok);
  if (!check) {
    const reason = verifyAkuteSignature(raw, header, secrets[0], nowSec).reason;
    return json({ error: "bad_signature", reason }, 400);
  }

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }

  try {
    const out = await (deps.apply || applyAkuteEvent)(event, deps.applyOpts);
    if (out?.retry) return json({ error: "retry" }, 500);
    return json({
      ok: true,
      ignored: out?.ignored || undefined,
      duplicate: out?.duplicate || undefined,
    });
  } catch {
    console.error("akute-webhook");
    return json({ error: "failed" }, 500);
  }
}
