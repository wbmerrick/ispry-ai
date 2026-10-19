// iSpry.ai — clinician (physician / NP / PA) interest form on /physicians.html.
// Emails the details to NOTIFY_TO via Resend (see _lib/notify.js). No patient data is involved.
// Returns { ok: true } only when the email actually went out, so the page can show a
// call/text fallback instead of silently losing an application.

import { originAllowed, rateLimit } from "./_lib/guard.js";
import { notifyPhysician, notifyConfigured } from "./_lib/notify.js";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const CREDS = new Set(["MD", "DO", "NP", "PA"]);

export default async function handler(req, res) {
  if (req.method === "GET" && String(req.url || "").includes("check=1")) {
    return json(res, 200, { ok: true, notify_configured: notifyConfigured() });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed." });
  if (!originAllowed(req)) return json(res, 403, { ok: false, error: "Not allowed." });
  if (!rateLimit(req, { name: "clinician", limit: 5, windowMs: 60 * 60 * 1000 }).ok) {
    return json(res, 429, { ok: false, error: "Too many submissions. Please try again later." });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return json(res, 400, { ok: false, error: "Invalid request." });

  // Honeypot: bots fill hidden fields. Pretend success.
  if (clean(b.website, 200)) return json(res, 200, { ok: true });

  const f = {
    name: clean(b.name, 120),
    credential: clean(b.credential, 4).toUpperCase(),
    email: clean(b.email, 160),
    phone: clean(b.phone, 40),
    specialty: clean(b.specialty, 120),
    states: clean(b.states, 200),
    hours: clean(b.hours, 20),
    note: String(b.note ?? "").replace(/[<>]/g, "").trim().slice(0, 1500),
  };
  if (!f.name || !CREDS.has(f.credential) || !f.states || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) {
    return json(res, 400, { ok: false, error: "Please add your name, credential, a valid email, and the states you're licensed in." });
  }

  const text = [
    "New clinician interest from ispry.ai/physicians",
    "",
    `Name: ${f.name}, ${f.credential}`,
    `Email: ${f.email}`,
    `Phone: ${f.phone || "-"}`,
    `Specialty: ${f.specialty || "-"}`,
    `Licensed in: ${f.states}`,
    `Hours/week: ${f.hours || "-"}`,
    "",
    "Note:",
    f.note || "-",
  ].join("\n");

  const r = await notifyPhysician({ subject: `iSpry clinician interest: ${f.name}, ${f.credential} (${f.states})`, text });
  if (!r.sent) {
    console.warn("clinician-interest: not delivered", r.reason);
    return json(res, 503, { ok: false });
  }
  return json(res, 200, { ok: true });
}
