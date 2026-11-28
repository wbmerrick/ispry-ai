// Physician review action: mark one recorded visit ineligible.
// POST { id, decision: "ineligible" } refunds a $49 visit or flags a membership
// visit. GET lists recent rows without the patient email. Only a confirmed
// physician or admin session can call it. Patients cannot.

import { originAllowed, rateLimit } from "./_lib/guard.js";
import { sessionUser } from "./_lib/session.js";
import { alertRouteFailure } from "./_lib/alert.js";
import {
  isPhysician,
  listRequests,
  realSettleDeps,
  safeRequestId,
  settleIneligible,
} from "./_lib/refund.js";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function publicResult(result) {
  const out = {
    ok: Boolean(result.ok),
    action: result.action || null,
    refund_status: result.refund_status || null,
    refund_id: result.refund_id || null,
  };
  if (result.error) out.error = result.error;
  if (typeof result.email_sent === "boolean") out.email_sent = result.email_sent;
  return out;
}

export async function handleReview(req, res, deps = {}) {
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "GET or POST only" });

  if (req.method === "GET" && String(req.url || "").includes("check=1")) {
    return json(res, 200, {
      ok: true,
      stripe_configured: Boolean(String(process.env.STRIPE_SECRET_KEY || "").trim()),
      store_configured: Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()),
      physician_allowlist: Boolean(String(process.env.PHYSICIAN_EMAILS || "").trim()),
    });
  }
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });

  const rl = rateLimit(req, {
    name: "review",
    limit: req.method === "POST" ? 20 : 30,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "Please wait a few minutes and try again." });
  }

  try {
    const user = await (deps.sessionUser || sessionUser)(req);
    if (!user) return json(res, 401, { error: "signed_out" });
    if (!isPhysician(user, deps.env || process.env)) return json(res, 403, { error: "forbidden" });

    if (req.method === "GET") {
      const list = await (deps.list || listRequests)(deps.storeOpts);
      if (!list || list.reason) return json(res, 503, { error: "store_unavailable" });
      return json(res, 200, { ok: true, requests: list.requests || [] });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== "object") return json(res, 400, { error: "bad_request" });
    const id = safeRequestId(body.id);
    if (!id || body.decision !== "ineligible") return json(res, 400, { error: "bad_request" });

    const result = await (deps.settle || settleIneligible)(id, user, deps.settleDeps || realSettleDeps(deps));
    return json(res, result.status || (result.ok ? 200 : 502), publicResult(result));
  } catch (e) {
    console.error("review:", String(e?.message || e).slice(0, 200));
    await alertRouteFailure(req, { route: "review", error: e, status: 500 });
    return json(res, 500, { error: "review_failed" });
  }
}

export default function handler(req, res) {
  return handleReview(req, res);
}
