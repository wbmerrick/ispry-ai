// Vercel cron: paid or submitted requests still unreviewed after
// STALE_QUEUE_MINUTES (default 60). One PHI-free email to NOTIFY_TO.
// The same request is not included again until STALE_ALERT_WINDOW_MINUTES
// (default: the same threshold) has passed.
//
// Vercel sends `Authorization: Bearer ${CRON_SECRET}` when that env var is set.
// The route stays closed until the secret is set. No Origin check: the cron
// caller does not send one. There is no Twilio client in this repo, so the
// alert is email only.

import { sweepStaleQueue } from "./_lib/care-flow.js";
import { authorizeCron } from "./_lib/care-status.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request, deps = {}) {
  const env = deps.env || process.env;
  const secret = String(env.CRON_SECRET || "");
  if (!secret) return json({ error: "not_configured" }, 503);
  if (!authorizeCron(request.headers.get("authorization"), secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const out = await (deps.sweep || sweepStaleQueue)({ env, now: deps.now });
    return json({ ok: true, alerted: out.alerted || 0 });
  } catch {
    console.error("stale-queue");
    return json({ error: "failed" }, 500);
  }
}

export const POST = GET;
