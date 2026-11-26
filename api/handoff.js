// iSpry.ai — hand a completed Spry intake to the physician in Akute.
// Flow: patient finishes Spry -> enters identifiers on the site -> this function
//   1) finds or creates the patient in Akute,
//   2) counts this month's visits (3-visit membership cap),
//   3) creates a task for Dr. Merrick containing the Spry summary,
//   4) returns Stripe checkout (membership) or Akute follow-through links
//      (forms for demographics + pharmacy, then booking) for normal intake.
// Identifiers never go to the AI model; they go only to Akute (covered by Akute's BAA).
// Required env vars: AKUTE_API_KEY, AKUTE_USER_ID (Dr. Merrick's Akute user id).
// Patient links default to the live iSpry Akute forms + booking URLs; override with
//   AKUTE_FORMS_URL / AKUTE_BOOKING_URL. Weight loss, ED and refill intakes get their own
//   bundle (FORMS_BUNDLES below). Optional: AKUTE_BASE_URL, VISIT_CAP (default 3).

import { originAllowed, rateLimit, safeBookingUrl } from "./_lib/guard.js";
import { sessionUser } from "./_lib/session.js";
import { consumeDailyCap } from "./_lib/usage.js";
import { memberBenefitDenial, resolveMembership } from "./_lib/membership.js";
import { checkoutUrl, visitUrl } from "./checkout.js";
import { notifyPhysician } from "./_lib/notify.js";
import { alertRouteFailure } from "./_lib/alert.js";

const BASE = process.env.AKUTE_BASE_URL || "https://api.akutehealth.com/v1";
const CAP = Number(process.env.VISIT_CAP || 3);
// Must match the version line on public/telehealth-consent.html. Bump both together.
const CONSENT_VERSION = "2026-11-13";
/** iSpry clinic self-scheduling (override with AKUTE_BOOKING_URL). */
export const DEFAULT_BOOKING_URL = "https://ispry.akutehealth.com/appointments";
/**
 * Published "iSpry - Address & Preferred Pharmacy" bundle (only that one form; ends on
 * iSpry booking). The older id 6ad624f0... was the GLP Tennessee intake bundle — do not reuse it here.
 * Address + Preferred Pharmacy form bundle on the iSpry subdomain
 * (override with AKUTE_FORMS_URL if the bundle is republished).
 */
export const DEFAULT_FORMS_URL = "https://ispry.akutehealth.com/forms/6afb373681e9b56ea6ffacd2";

/**
 * Visit types that need more than address + pharmacy. Each bundle is the address/pharmacy
 * form plus one extra form (GLP-1 consent, ED acknowledgment, refill medication list).
 * Akute forms have no show/hide logic, so it is one published bundle per visit type.
 * Every other visit type uses DEFAULT_FORMS_URL.
 */
export const FORMS_BUNDLES = {
  "weight-loss": { label: "iSpry - Weight Loss", url: "https://ispry.akutehealth.com/forms/6b01f8b4b2014eaf70844c0c" },
  ed: { label: "iSpry - ED", url: "https://ispry.akutehealth.com/forms/6b01f8d6b2014eaf70844e21" },
  refill: { label: "iSpry - Refill", url: "https://ispry.akutehealth.com/forms/6b01f8e7d338a328c0498282" },
};

const KIND_RULES = [
  // Order matters: a semaglutide or sildenafil refill still needs that medication's consent.
  ["weight-loss", /\b(weight[- ]?(loss|management)|obes\w*|overweight|glp-?1|semaglutide|tirzepatide|wegovy|zepbound|ozempic|mounjaro)\b/i],
  ["ed", /\b(erectile|erections?|impotence|sildenafil|tadalafil|viagra|cialis)\b/i],
  ["refill", /\b(refill\w*|renew\w*)\b/i],
];

/**
 * Which forms bundle an intake needs, read from where Spry landed ("Problem:" /
 * "Most likely:" lines of the summary) rather than the button the patient tapped.
 * Returns a FORMS_BUNDLES key, or "" for address + pharmacy only. Pure, for tests.
 */
export function formsKind(summary) {
  const lines = String(summary || "").split(/\n+/);
  const tagged = (label) => lines.filter((l) =>
    new RegExp(`^\\s*(?:[-*•]\\s*|\\d+[.)]\\s*)?(?:\\*\\*|__)?${label}:`, "i").test(l));
  // The wrap-up's "Problem:" line is final. The earlier synopsis ("Most likely:") can name a
  // condition the patient then corrected, so it only counts when there is no Problem line.
  const problem = tagged("Problem");
  const landed = (problem.length ? problem.slice(-1) : tagged("Most likely").slice(-1)).join("\n");
  for (const [kind, re] of KIND_RULES) if (re.test(landed)) return kind;
  return "";
}

export function formsFollowUrl(kind) {
  if (kind && Object.hasOwn(FORMS_BUNDLES, kind)) return safeBookingUrl(FORMS_BUNDLES[kind].url);
  return safeBookingUrl(process.env.AKUTE_FORMS_URL || "") || safeBookingUrl(DEFAULT_FORMS_URL);
}
export function bookingFollowUrl() {
  return safeBookingUrl(process.env.AKUTE_BOOKING_URL || "") || safeBookingUrl(DEFAULT_BOOKING_URL);
}

/**
 * Label stored on the Akute task when the browser sends a pathway id.
 * The site has no server-side record that an education or contraindication
 * screen was finished, so this line does not claim that it was.
 */
export function pathwayChartLine(pathway) {
  const label = String(pathway || "").trim();
  if (!label) return "";
  return `Patient-reported pathway label: ${label}.`;
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function akute(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-API-Key": process.env.AKUTE_API_KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    // Log status + short Akute message only — never echo request/patient bodies.
    const hint =
      (data && typeof data === "object" && (data.message || data.error || data.detail)) ||
      (typeof data === "string" ? data : "") ||
      text;
    throw new Error(
      `Akute ${opts.method || "GET"} ${path.split("?")[0]} -> ${r.status} ${String(hint).replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
  return data;
}

// Akute list responses may be an array or wrapped; normalize.
const list = (d) => (Array.isArray(d) ? d : d?.data || d?.results || d?.items || []);
const idOf = (o) => o?.id || o?.data?.id || o?.patient_id;

const clean = (s, max) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async function handler(req, res) {
  // Config probe for the uptime check (.github/workflows/uptime.yml) — never calls Akute.
  if (req.method === "GET" && String(req.url || "").includes("check=1")) {
    const forms = formsFollowUrl();
    const booking = bookingFollowUrl();
    return json(res, 200, {
      ok: true,
      akute_configured: Boolean(process.env.AKUTE_API_KEY && process.env.AKUTE_USER_ID),
      forms_configured: Boolean(forms),
      booking_configured: Boolean(booking),
      // Public clinic links only (no secrets) — helps verify intake wiring without a POST.
      forms_url: forms || null,
      booking_url: booking || null,
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });

  const user = await sessionUser(req);
  if (!user) return json(res, 401, { error: "signed_out" });

  const cap = await consumeDailyCap(user.id, "handoff");
  if (!cap.ok) {
    res.setHeader("Retry-After", "3600");
    return json(res, 429, { error: "daily_limit" });
  }

  if (!process.env.AKUTE_API_KEY || !process.env.AKUTE_USER_ID) {
    return json(res, 503, { error: "not_configured" });
  }

  const rl = rateLimit(req, { name: "handoff", limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "Please wait a moment and try again." });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b) return json(res, 400, { error: "Invalid request" });
  if (b.website) return json(res, 200, { ok: true }); // honeypot: bots fill hidden fields

  const p = {
    first_name: clean(b.first_name, 60),
    last_name: clean(b.last_name, 60),
    date_of_birth: clean(b.date_of_birth, 10),
    sex: ["male", "female", "other", "unknown"].includes(b.sex) ? b.sex : "unknown",
    email: clean(b.email, 120).toLowerCase(),
    phone: clean(b.phone, 20).replace(/\D/g, "").slice(-10),
  };
  const summary = clean(b.summary, 6000);
  const pathway = clean(b.pathway, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  // "book" is the included member visit (no Stripe charge). It is explicit so a
  // pathway label cannot turn a paid visit into a free one, and it cannot be
  // implied by omitting `after` once a pathway is set. The server still checks
  // membership before any chart write.
  const requestedAfter = String(b.after || "").toLowerCase();
  const after = requestedAfter === "book"
    ? "book"
    : (requestedAfter === "pay" || requestedAfter === "hint" || Boolean(pathway) ? "pay" : "book");
  const plan = String(b.plan || "").toLowerCase() === "visit" ? "visit" : "membership";
  const inTN = b.in_tennessee === true;
  const consent = b.consent === true;
  const consentAt = new Date().toISOString(); // server clock, not the browser's
  const smsOptIn = b.sms_opt_in === true;
  const urgency = /same[- ]day/i.test(summary) ? "same-day" : "routine";
  const kind = formsKind(summary);
  const formsLabel = kind ? FORMS_BUNDLES[kind].label : "iSpry - Address & Preferred Pharmacy";

  if (!p.first_name || !p.last_name || !/^\d{4}-\d{2}-\d{2}$/.test(p.date_of_birth) ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email) || p.phone.length !== 10) {
    return json(res, 400, { error: "Please complete every field." });
  }
  if (p.email !== user.email) {
    return json(res, 400, { error: "Use the email on your iSpry account." });
  }
  const age = (Date.now() - new Date(p.date_of_birth + "T12:00:00Z")) / 31557600000;
  if (!Number.isFinite(age) || age < 18 || age > 120) {
    const error = age > 120
      ? "Enter a date of birth for an age from 18 to 120."
      : "iSpry currently serves adults 18 and older.";
    return json(res, 400, { error });
  }
  if (!inTN) return json(res, 400, { error: "iSpry can only treat patients located in Tennessee at the time of the visit." });
  if (!consent) return json(res, 400, { error: "Please agree to the telehealth consent to continue." });
  if (!summary) return json(res, 400, { error: "Missing Spry summary." });

  // Included visit and the checkout skip: file the synopsis for physician review
  // with no new charge only when membership is active or trialing.
  if (after === "book") {
    const access = await resolveMembership(user.email, { userId: user.id });
    const denial = memberBenefitDenial(access);
    if (denial) {
      return json(res, 402, {
        ...denial,
        visit_url: visitUrl() || null,
        join_url: checkoutUrl(),
      });
    }
  }

  try {
    // 1) Find or create the patient
    const q = new URLSearchParams({ first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth, limit: "5" });
    const found = list(await akute(`/patients?${q}`));
    // Name + DOB can match more than one person. Only reuse a record whose email or
    // phone matches; a record with neither on file is reused only when it is the sole
    // match. Otherwise create a new patient so an intake never lands in someone else's chart.
    const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
    const sameEmail = (x) => x.email && String(x.email).toLowerCase() === p.email;
    const samePhone = (x) => digits(x.primary_phone_number || x.phone) === p.phone;
    const noContact = (x) => !x.email && !digits(x.primary_phone_number || x.phone);
    const match = found.find(sameEmail) || found.find(samePhone) ||
      (found.length === 1 && noContact(found[0]) ? found[0] : null);
    let patientId = idOf(match);
    let isNew = false;
    if (!patientId) {
      const created = await akute("/patients", {
        method: "POST",
        body: JSON.stringify({
          first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth, sex: p.sex,
          status: "active", email: p.email, primary_phone_number: p.phone, primary_phone_type: "mobile",
        }),
      });
      patientId = idOf(created);
      isNew = true;
    }
    if (!patientId) throw new Error("No patient id returned");

    // 2) Count this month's visits for the membership cap
    let visitsThisMonth = null;
    try {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const appts = list(await akute(`/appointments?${new URLSearchParams({ patient_id: patientId, limit: "50" })}`));
      visitsThisMonth = appts.filter((a) => {
        const t = new Date(a.start_time || a.start || 0);
        const st = String(a.status || "").toLowerCase();
        return t >= monthStart && !["cancelled", "canceled", "noshow", "no-show", "entered-in-error"].includes(st);
      }).length;
    } catch { /* cap check is advisory; never block intake on it */ }
    const overCap = visitsThisMonth !== null && visitsThisMonth >= CAP;

    // 3) Task for the physician with the Spry summary
    const today = new Date().toISOString().slice(0, 10);
    const lines = summary.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const reported = pathwayChartLine(pathway);
    const pathwayLine = reported ? `\n${reported}` : "";
    const payNext = after === "book"
      ? "\nIncluded member visit. The server confirmed an active or trialing membership before filing this. No new charge. Physician review next."
      : plan === "visit"
      ? "\nNext step for patient: Stripe one-time visit payment ($49, not a membership). A \"visit PAID\" task appears here when paid, then physician review. The patient may upgrade to membership later."
      : "\nNext step for patient: Stripe membership payment (a \"membership ACTIVE\" task will appear here when paid), then physician review.";
    const plain =
      "Spry AI intake — synopsis / differential for physician review (patient-reported, not verified)\n" +
      lines.map((l) => `- ${l.replace(/^[-*•]\s*/, "")}`).join("\n") +
      pathwayLine +
      `\nLocated in Tennessee: confirmed. Telehealth consent: accepted ${consentAt} (consent version ${CONSENT_VERSION}). SMS opt-in: ${smsOptIn ? "yes" : "no"}.` +
      `\nVisits this month: ${visitsThisMonth ?? "unknown"} of ${CAP}${overCap ? " — MONTHLY VISIT CAP REACHED" : ""}.` +
      `\n${isNew ? "New patient created by iSpry." : "Existing patient."}` +
      `\nForms bundle offered to patient: ${formsLabel}.` +
      payNext;
    // Spry's wrap-up carries one line "Problem: <most likely problem>"; surface it in the
    // task title so the physician can triage from the task list without opening each one.
    const problemLine = (summary.match(/^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:\*\*|__)?Problem:\s*(?:\*\*|__)?\s*(.+)$/mi) || [])[1] || "";
    const problem = clean(problemLine.replace(/[*_`]/g, ""), 90).replace(/\s*\.$/, "");
    const title = `iSpry intake review${pathway ? ` — ${pathway}` : ""}${problem ? ` — ${problem}` : ""}${urgency === "same-day" ? " — SAME DAY" : ""}${overCap ? " — OVER 3-VISIT CAP" : ""}`;
    const ownerId = String(process.env.AKUTE_USER_ID || "").trim();
    if (!ownerId) throw new Error("AKUTE_USER_ID missing");

    // Prefer rich HTML; fall back to plain text if Akute rejects HTML descriptions.
    const html =
      `<div><b>Spry AI intake — synopsis / differential for physician review (patient-reported, not verified)</b></div>` +
      `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-*•]\s*/, ""))}</li>`).join("")}</ul>` +
      (reported
        ? `<div>${esc(reported)}</div>`
        : "") +
      `<div>Located in Tennessee: confirmed by patient. Telehealth consent: accepted ${consentAt} (consent version ${CONSENT_VERSION}). SMS opt-in: ${smsOptIn ? "yes" : "no"}.</div>` +
      `<div>Visits this month: ${visitsThisMonth ?? "unknown"} of ${CAP}${overCap ? " — <b>MONTHLY VISIT CAP REACHED</b>" : ""}.</div>` +
      `<div>${isNew ? "New patient created by iSpry." : "Existing patient."}</div>` +
      `<div>Forms bundle offered to patient: ${esc(formsLabel)}.</div>` +
      (after === "pay"
        ? (plan === "visit"
          ? `<div>Next step for patient: Stripe <b>one-time visit</b> payment ($49, not a membership). A <b>visit PAID</b> task appears on this patient when paid, then physician review / Rx when appropriate. The patient may upgrade to membership later.</div>`
          : `<div>Next step for patient: Stripe membership payment — a <b>membership ACTIVE</b> task will appear on this patient when paid — then physician review / Rx when appropriate.</div>`)
        : `<div>Included member visit. The server confirmed an active or trialing membership before filing this. <b>No new charge.</b> Physician review next.</div>`);

    // Akute returns 500 "malformed data" for some owner_id / field combos.
    // Try richest payload first, then strip optional fields (incl. owner_id).
    const taskBodies = [
      {
        task: title,
        description: html,
        due_date: today,
        owner_id: ownerId,
        patient_id: patientId,
        priority: urgency === "same-day" ? "p1" : "p2",
        status: "not-started",
        tags: ["iSpry", "Spry intake"]
          .concat(pathway ? ["pathway", pathway] : [])
          .concat(overCap ? ["visit-cap"] : []),
      },
      {
        task: title,
        description: plain,
        due_date: today,
        owner_id: ownerId,
        patient_id: patientId,
        priority: urgency === "same-day" ? "p1" : "p2",
        status: "not-started",
      },
      {
        task: title,
        description: plain,
        owner_id: ownerId,
        patient_id: patientId,
        status: "not-started",
      },
      {
        task: title,
        description: plain,
        patient_id: patientId,
        status: "not-started",
      },
      {
        task: title,
        description: plain.slice(0, 2000),
        patient_id: patientId,
      },
      { task: title, patient_id: patientId },
      { task: title },
    ];
    let taskErr = null;
    let usedBody = null;
    for (const body of taskBodies) {
      try {
        await akute("/tasks", { method: "POST", body: JSON.stringify(body) });
        taskErr = null;
        usedBody = body;
        break;
      } catch (e) {
        taskErr = e;
      }
    }
    if (taskErr) throw taskErr;
    if (usedBody && !usedBody.owner_id) {
      console.warn("handoff: task created without owner_id — check AKUTE_USER_ID");
    }

    // Membership checkout: Stripe Payment Link carrying the Akute patient id as
    // client_reference_id so the webhook can tie the subscription to the chart.
    // The condition/pathway is deliberately NOT sent to Stripe.
    // Heads-up to the physician (no identifiers and no clinical detail — just that a task is
    // waiting in Akute). The condition/pathway and likely diagnosis live only in Akute, never
    // in this email, since the email provider is not covered by a BAA.
    await notifyPhysician({
      subject: `iSpry: new intake${urgency === "same-day" ? " (same-day)" : ""}`,
      text: `A new Spry intake task is waiting in Akute.\n\nNext step for the patient: ${after === "pay" ? (plan === "visit" ? "Stripe one-time visit payment" : "Stripe membership payment") : "included member visit (membership verified active), then forms and scheduling"}.\n\nOpen Akute to review.`,
    });

    let checkout = null;
    if (after === "pay") {
      const base = plan === "visit" ? visitUrl() : checkoutUrl();
      if (base) {
        const u = new URL(base);
        if (/^[A-Za-z0-9_-]{1,200}$/.test(String(patientId))) u.searchParams.set("client_reference_id", String(patientId));
        u.searchParams.set("prefilled_email", p.email);
        checkout = u.href;
      }
    }

    return json(res, 200, {
      ok: true,
      over_cap: overCap,
      after,
      plan: after === "pay" ? plan : null,
      // Only return validated https patient links (never arbitrary client-supplied URLs).
      // Forms first: demographics + preferred pharmacy (needed for e-prescribing), then booking.
      forms_url: after === "book" ? formsFollowUrl(kind) || null : null,
      // Lets My care open the same bundle after payment. A fixed slug, never free text.
      forms_kind: kind || null,
      booking_url: after === "book" ? bookingFollowUrl() || null : null,
      checkout_url: checkout,
    });
  } catch (e) {
    // Log only the error class/route — never patient data.
    console.error("handoff error:", String(e.message || e).slice(0, 200));
    await alertRouteFailure(req, { route: "handoff", error: e, status: 502 });
    return json(res, 502, { error: "We couldn't send this to your physician right now. Please try again shortly." });
  }
}
