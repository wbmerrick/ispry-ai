// iSpry.ai — signed-in member home (public/member.html).
// GET  -> membership status (Stripe), visits used this month (Akute), and patient links.
// POST -> a non-urgent request (refill / follow-up / question) filed as an Akute TASK.
//
// The caller proves who they are with their Supabase session token. The verified,
// confirmed email is the only key used to look anything up — the browser never
// supplies an email, a patient id, or a Stripe id.
// Nothing is stored by this route. Request text goes only to Akute (covered by its BAA);
// the physician heads-up email carries no identifiers and no clinical detail.

import { originAllowed, rateLimit } from "./_lib/guard.js";
import { akuteConfigured, createTask, findPatientByEmail, visitsThisMonth } from "./_lib/akute.js";
import { notifyPhysician } from "./_lib/notify.js";
import { supabaseConfig } from "./auth-config.js";
import { checkoutUrl, portalUrl, visitUrl } from "./checkout.js";
import { bookingFollowUrl, formsFollowUrl } from "./handoff.js";

const CAP = Number(process.env.VISIT_CAP || 3);
const STRIPE_API = "https://api.stripe.com/v1";
export const AKUTE_PORTAL_URL = "https://portal.akutehealth.com/login";

export const REQUEST_KINDS = {
  refill: "Refill request",
  followup: "Follow-up on a recent visit",
  question: "Question for the physician",
};

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

const clean = (s, max) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const day = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null);
// Newer API versions keep period bounds on the subscription items, older ones on the subscription.
const periodEnd = (sub) => sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || 0;

/** Verified, email-confirmed Supabase user for a bearer token, or null. */
export async function sessionUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+([A-Za-z0-9._-]{20,4000})$/);
  if (!m) return null;
  const { url, anon } = supabaseConfig();
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${m[1]}`, apikey: anon },
    });
    if (!r.ok) return null;
    const u = await r.json();
    const email = String(u?.email || "").trim().toLowerCase();
    if (!u?.id || !email || !(u.email_confirmed_at || u.confirmed_at)) return null;
    return { id: u.id, email };
  } catch {
    return null;
  }
}

/**
 * Reduce a customer's subscriptions to what the member page shows. Pure, for tests.
 * status: active | canceling | past_due | none
 */
export function summarizeSubscriptions(subs) {
  const rank = (s) => {
    if (["active", "trialing"].includes(s.status)) return s.cancel_at_period_end ? 2 : 3;
    if (["past_due", "unpaid"].includes(s.status)) return 1;
    return 0;
  };
  const best = (subs || []).filter((s) => rank(s) > 0).sort((a, b) => rank(b) - rank(a))[0];
  if (!best) return { status: "none", date: null };
  const r = rank(best);
  if (r === 3) return { status: "active", date: day(periodEnd(best)) };
  if (r === 2) return { status: "canceling", date: day(best.cancel_at || periodEnd(best)) };
  return { status: "past_due", date: null };
}

async function stripeGet(path, params) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) throw new Error("stripe_not_configured");
  const r = await fetch(`${STRIPE_API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`Stripe GET ${path} -> ${r.status}`);
  return r.json();
}

async function membershipFor(email) {
  try {
    const customers = (await stripeGet("/customers", { email, limit: "10" }))?.data || [];
    const subs = [];
    for (const c of customers.slice(0, 5)) {
      const page = await stripeGet("/subscriptions", { customer: c.id, status: "all", limit: "10" });
      subs.push(...(page?.data || []));
    }
    return summarizeSubscriptions(subs);
  } catch (e) {
    console.warn("member: stripe", String(e?.message || e).slice(0, 120));
    return { status: "unknown", date: null };
  }
}

async function chartFor(email) {
  if (!akuteConfigured()) return { patientId: null, used: null };
  try {
    const patientId = await findPatientByEmail(email);
    if (!patientId) return { patientId: null, used: null };
    let used = null;
    try { used = await visitsThisMonth(patientId); } catch { /* advisory */ }
    return { patientId, used };
  } catch (e) {
    console.warn("member: akute", String(e?.message || e).slice(0, 120));
    return { patientId: null, used: null, error: true };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "GET or POST only" });

  // Config probe for the uptime check — no session, never calls Supabase, Stripe or Akute.
  if (req.method === "GET" && String(req.url || "").includes("check=1")) {
    return json(res, 200, {
      ok: true,
      akute_configured: akuteConfigured(),
      stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    });
  }
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });

  const isPost = req.method === "POST";
  const rl = rateLimit(req, isPost
    ? { name: "member-request", limit: 5, windowMs: 10 * 60_000 }
    : { name: "member", limit: 30, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "Please wait a few minutes and try again." });
  }

  const user = await sessionUser(req);
  if (!user) return json(res, 401, { error: "signed_out" });

  if (!isPost) {
    const [membership, chart] = await Promise.all([membershipFor(user.email), chartFor(user.email)]);
    return json(res, 200, {
      ok: true,
      membership,
      chart_linked: Boolean(chart.patientId),
      visits: {
        cap: CAP,
        used: chart.used,
        left: chart.used === null ? null : Math.max(0, CAP - chart.used),
      },
      links: {
        portal_url: portalUrl(),
        join_url: checkoutUrl(),
        visit_url: visitUrl() || null,
        forms_url: formsFollowUrl() || null,
        booking_url: bookingFollowUrl() || null,
        chart_url: AKUTE_PORTAL_URL,
      },
    });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b) return json(res, 400, { error: "Invalid request" });
  if (b.website) return json(res, 200, { ok: true }); // honeypot

  const kind = Object.hasOwn(REQUEST_KINDS, b.kind) ? b.kind : "";
  const message = clean(b.message, 2000);
  if (!kind) return json(res, 400, { error: "Choose what this request is about." });
  if (message.length < 10) return json(res, 400, { error: "Add a sentence or two so your physician knows what you need." });
  if (b.in_tennessee !== true) {
    return json(res, 400, { error: "iSpry can only treat patients located in Tennessee at the time of the request." });
  }
  if (!akuteConfigured() || !process.env.AKUTE_USER_ID) return json(res, 503, { error: "not_configured" });

  try {
    const patientId = await findPatientByEmail(user.email);
    if (!patientId) {
      // No chart under this email yet: a request needs a patient to attach to.
      return json(res, 409, { error: "no_chart" });
    }
    const label = REQUEST_KINDS[kind];
    await createTask({
      title: `iSpry member request — ${label}`,
      description:
        `${label} sent from the signed-in member page on ispry.ai (patient-written, not verified).\n\n` +
        `${message}\n\n` +
        "Located in Tennessee: confirmed by patient. Signed in with a confirmed email matching this chart.",
      patientId,
      ownerId: String(process.env.AKUTE_USER_ID).trim(),
      priority: "p2",
      tags: ["iSpry", "member request", kind],
    });
    await notifyPhysician({
      subject: "iSpry: new member request",
      text: "A member request task is waiting in Akute.\n\nOpen Akute to review.",
    });
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error("member request error:", String(e?.message || e).slice(0, 200));
    return json(res, 502, { error: "We couldn't send this to your physician right now. Please try again shortly, or call (731) 415-0724." });
  }
}
