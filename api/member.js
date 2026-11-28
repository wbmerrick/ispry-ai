// iSpry.ai — signed-in member home (public/member.html).
// GET  -> membership status (Stripe), visits used this month (Akute), and patient links.
// POST -> a non-urgent request (refill / follow-up / question) filed as an Akute TASK.
//
// The caller proves who they are with their Supabase session token. The verified,
// confirmed email is the only key used to look anything up — the browser never
// supplies an email, a patient id, or a Stripe id.
// Request text goes only to Akute (covered by its BAA). The physician heads-up
// email carries no identifiers and no clinical detail. Refill, follow-up, and
// question tasks are a member benefit: the server allows them only when the
// Stripe-backed membership is active or trialing.

import { originAllowed, rateLimit } from "./_lib/guard.js";
import { sessionUser } from "./_lib/session.js";
import { akuteConfigured, createTask, findPatientByEmail, visitsThisMonth } from "./_lib/akute.js";
import { notifyPhysician } from "./_lib/notify.js";
import { noteMemberRequest } from "./_lib/care-flow.js";
import { displayMembership, memberBenefitDenial, resolveMembership, summarizeSubscriptions } from "./_lib/membership.js";
import { checkoutUrl, portalUrl, visitUrl } from "./checkout.js";
import { bookingFollowUrl, formsFollowUrl, FORMS_BUNDLES } from "./handoff.js";

const CAP = Number(process.env.VISIT_CAP || 3);
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

export { sessionUser, summarizeSubscriptions };

async function membershipFor(email, userId) {
  try {
    const access = await resolveMembership(email, { userId });
    return displayMembership(access);
  } catch (e) {
    console.warn("member: membership", String(e?.message || e).slice(0, 120));
    return { status: "unknown", date: null, benefits: false, stripe_status: null };
  }
}

/** linked: true | false | null (lookup failed — unknown, not "no chart"). */
export async function chartFor(email) {
  if (!akuteConfigured()) return { linked: null, used: null };
  try {
    const patientId = await findPatientByEmail(email);
    if (!patientId) return { linked: false, used: null };
    let used = null;
    try { used = await visitsThisMonth(patientId); } catch { /* advisory */ }
    return { linked: true, used };
  } catch (e) {
    console.warn("member: akute", String(e?.message || e).slice(0, 120));
    return { linked: null, used: null };
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
    // Optional ?forms=<kind> from this browser's last intake; only known slugs are honored.
    const asked = (String(req.url || "").match(/[?&]forms=([a-z-]{1,20})(?:&|$)/) || [])[1] || "";
    const formsKind = Object.hasOwn(FORMS_BUNDLES, asked) ? asked : "";
    const membership = await membershipFor(user.email, user.id);
    // Chat only needs the benefit bit. Skip the chart lookup.
    if (String(req.url || "").includes("scope=benefits")) {
      return json(res, 200, { ok: true, membership });
    }
    const chart = await chartFor(user.email);
    return json(res, 200, {
      ok: true,
      membership,
      // null = could not check; the page keeps the request form and lets POST decide.
      chart_linked: chart.linked,
      visits: {
        cap: CAP,
        used: chart.used,
        left: chart.used === null ? null : Math.max(0, CAP - chart.used),
      },
      links: {
        portal_url: portalUrl(),
        join_url: checkoutUrl(),
        visit_url: visitUrl() || null,
        forms_url: formsFollowUrl(formsKind) || null,
        forms_kind: formsKind || null,
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
  const access = await resolveMembership(user.email, { userId: user.id });
  const denial = memberBenefitDenial(access);
  if (denial) {
    return json(res, 402, {
      ...denial,
      visit_url: visitUrl() || null,
      join_url: checkoutUrl(),
    });
  }
  if (!akuteConfigured() || !process.env.AKUTE_USER_ID) return json(res, 503, { error: "not_configured" });

  try {
    const patientId = await findPatientByEmail(user.email);
    if (!patientId) {
      // No chart under this email yet: a request needs a patient to attach to.
      return json(res, 409, { error: "no_chart" });
    }
    const label = REQUEST_KINDS[kind];
    const task = await createTask({
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
    await noteMemberRequest({ email: user.email, patientId, taskId: task?.taskId || "" });
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
