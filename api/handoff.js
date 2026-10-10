// iSpry.ai — hand a completed Spry intake to the physician in Akute.
// Flow: patient finishes Spry -> enters identifiers on the site -> this function
//   1) finds or creates the patient in Akute,
//   2) counts this month's visits (3-visit membership cap),
//   3) creates a task for Dr. Merrick containing the Spry summary,
//   4) returns the Akute self-scheduling link.
// Identifiers never go to the AI model; they go only to Akute (covered by Akute's BAA).
// Required env vars: AKUTE_API_KEY, AKUTE_USER_ID (Dr. Merrick's Akute user id), AKUTE_BOOKING_URL.
// Optional: AKUTE_BASE_URL (defaults to production), VISIT_CAP (defaults to 3).

const BASE = process.env.AKUTE_BASE_URL || "https://api.akutehealth.com/v1";
const CAP = Number(process.env.VISIT_CAP || 3);

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
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!process.env.AKUTE_API_KEY || !process.env.AKUTE_USER_ID) {
    return json(res, 503, { error: "not_configured" });
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
  const inTN = b.in_tennessee === true;
  const consent = b.consent === true;
  const smsOptIn = b.sms_opt_in === true;
  const urgency = /same[- ]day/i.test(summary) ? "same-day" : "routine";

  if (!p.first_name || !p.last_name || !/^\d{4}-\d{2}-\d{2}$/.test(p.date_of_birth) ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email) || p.phone.length !== 10) {
    return json(res, 400, { error: "Please complete every field." });
  }
  const age = (Date.now() - new Date(p.date_of_birth + "T12:00:00Z")) / 31557600000;
  if (!(age >= 18 && age < 120)) return json(res, 400, { error: "iSpry currently serves adults 18 and older." });
  if (!inTN) return json(res, 400, { error: "iSpry can only treat patients located in Tennessee at the time of the visit." });
  if (!consent) return json(res, 400, { error: "Please agree to the telehealth consent to continue." });
  if (!summary) return json(res, 400, { error: "Missing Spry summary." });

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
    const plain =
      "Spry AI intake (patient-reported, not physician-verified)\n" +
      lines.map((l) => `- ${l.replace(/^[-*•]\s*/, "")}`).join("\n") +
      `\nLocated in Tennessee: confirmed. Telehealth consent: accepted. SMS opt-in: ${smsOptIn ? "yes" : "no"}.` +
      `\nVisits this month: ${visitsThisMonth ?? "unknown"} of ${CAP}${overCap ? " — MONTHLY VISIT CAP REACHED" : ""}.` +
      `\n${isNew ? "New patient created by iSpry." : "Existing patient."}`;
    const title = `iSpry intake review${urgency === "same-day" ? " — SAME DAY" : ""}${overCap ? " — OVER 3-VISIT CAP" : ""}`;
    const ownerId = String(process.env.AKUTE_USER_ID || "").trim();
    if (!ownerId) throw new Error("AKUTE_USER_ID missing");

    // Prefer rich HTML; fall back to plain text if Akute rejects HTML descriptions.
    const html =
      `<div><b>Spry AI intake (patient-reported, not physician-verified)</b></div>` +
      `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-*•]\s*/, ""))}</li>`).join("")}</ul>` +
      `<div>Located in Tennessee: confirmed by patient. Telehealth consent: accepted. SMS opt-in: ${smsOptIn ? "yes" : "no"}.</div>` +
      `<div>Visits this month: ${visitsThisMonth ?? "unknown"} of ${CAP}${overCap ? " — <b>MONTHLY VISIT CAP REACHED</b>" : ""}.</div>` +
      `<div>${isNew ? "New patient created by iSpry." : "Existing patient."}</div>`;

    const taskBodies = [
      {
        task: title,
        description: html,
        due_date: today,
        owner_id: ownerId,
        patient_id: patientId,
        priority: urgency === "same-day" ? "p1" : "p2",
        status: "not-started",
        tags: ["iSpry", "Spry intake"].concat(overCap ? ["visit-cap"] : []),
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
    ];
    let taskErr = null;
    for (const body of taskBodies) {
      try {
        await akute("/tasks", { method: "POST", body: JSON.stringify(body) });
        taskErr = null;
        break;
      } catch (e) {
        taskErr = e;
      }
    }
    if (taskErr) throw taskErr;

    return json(res, 200, {
      ok: true,
      over_cap: overCap,
      booking_url: process.env.AKUTE_BOOKING_URL || null,
    });
  } catch (e) {
    // Log only the error class/route — never patient data.
    console.error("handoff error:", String(e.message || e).slice(0, 200));
    return json(res, 502, { error: "We couldn't send this to your physician right now. Please try again shortly." });
  }
}
