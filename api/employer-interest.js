// iSpry.ai — employer inquiry on /employers.html.
// Same honeypot and Resend path as the physician form. No patient information.
// A sample employer price is not included: that number is not decided.

import { originAllowed, rateLimit } from "./_lib/guard.js";
import { notifyPhysician, notifyConfigured } from "./_lib/notify.js";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method === "GET" && String(req.url || "").includes("check=1")) {
    return json(res, 200, { ok: true, notify_configured: notifyConfigured() });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed." });
  if (!originAllowed(req)) return json(res, 403, { ok: false, error: "Not allowed." });
  if (!rateLimit(req, { name: "employer", limit: 5, windowMs: 60 * 60 * 1000 }).ok) {
    return json(res, 429, { ok: false, error: "Too many submissions. Please try again later." });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return json(res, 400, { ok: false, error: "Invalid request." });
  if (clean(b.website, 200)) return json(res, 200, { ok: true });

  const f = {
    name: clean(b.name, 120),
    organization: clean(b.organization, 160),
    email: clean(b.email, 160),
    phone: clean(b.phone, 40),
    note: String(b.note ?? "").replace(/[<>]/g, "").trim().slice(0, 1500),
  };
  if (!f.name || !f.organization || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) {
    return json(res, 400, { ok: false, error: "Please add your name, organization, and a valid email." });
  }

  const text = [
    "New employer inquiry from ispry.ai/employers",
    "",
    `Name: ${f.name}`,
    `Organization: ${f.organization}`,
    `Email: ${f.email}`,
    `Phone: ${f.phone || "-"}`,
    "",
    "Note:",
    f.note || "-",
    "",
    "No employer price is published on the site.",
  ].join("\n");

  const r = await notifyPhysician({
    subject: `iSpry employer inquiry: ${f.organization}`,
    text,
  });
  if (!r.sent) {
    console.warn("employer-interest: not delivered", r.reason);
    return json(res, 503, { ok: false });
  }
  return json(res, 200, { ok: true });
}
