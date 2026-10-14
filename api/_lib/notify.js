// Physician heads-up email (optional). Never includes patient identifiers or clinical
// detail — only that something is waiting in Akute or changed in Stripe.
// Active when RESEND_API_KEY and NOTIFY_TO are set (Resend: https://resend.com; verify the
// ispry.ai domain, then NOTIFY_FROM may be e.g. "iSpry <notify@ispry.ai>").
// Failures are swallowed: a missing email must never break a patient's handoff.

export function notifyConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_TO);
}

export async function notifyPhysician({ subject, text }) {
  if (!notifyConfigured()) return { sent: false, reason: "not_configured" };
  const to = String(process.env.NOTIFY_TO).split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.NOTIFY_FROM || "iSpry <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: String(subject).slice(0, 200), text: String(text).slice(0, 4000) }),
    });
    if (!r.ok) {
      console.warn("notify: resend", r.status);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn("notify:", String(e?.message || e).slice(0, 120));
    return { sent: false, reason: "error" };
  }
}
