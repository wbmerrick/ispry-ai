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

const PATIENT_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Patient receipt. No symptoms, no chart text, no diagnosis. Uses RESEND_API_KEY and NOTIFY_FROM only. */
export function patientPaymentCopy({ plan, amount } = {}) {
  const kind = plan === "membership" ? "membership" : plan === "visit" ? "visit" : "payment";
  const subject = kind === "membership"
    ? "iSpry payment received — membership"
    : kind === "visit"
      ? "iSpry payment received — visit"
      : "iSpry payment received";
  const what = kind === "membership"
    ? "This confirms your iSpry membership payment of $100 a month. It renews until you cancel. You can cancel from the billing page linked in My care. There is no partial-month refund."
    : kind === "visit"
      ? "This confirms your one-time iSpry visit payment of $49. It does not renew."
      : "This confirms your iSpry payment.";
  const refundLine = kind === "visit"
    ? "You get a full refund of the iSpry visit fee as soon as the request is found ineligible for this service, for example if your iSpry physician decides telehealth is not right for it. That refund is the $49 one-time visit."
    : "Finding one included visit ineligible does not refund this membership. A $49 one-time visit is a separate charge.";
  const receipt = amount ? `Amount on the Stripe receipt: ${amount}.` : "Stripe has the card receipt.";
  const text = [
    what,
    receipt,
    "Your iSpry physician reviews requests 24/7, including nights, weekends, and holidays.",
    "Next: open My care at https://ispry.ai/member.html to add your address and preferred pharmacy and to book.",
    "A Good Faith Estimate of the published prices is at https://ispry.ai/good-faith-estimate.html.",
    "This email does not include your symptoms. Spry does not diagnose or prescribe.",
    refundLine,
    "Questions: call or text (731) 415-0724.",
    "iSpry is not for emergencies. Call 911, or call or text 988 if you are in crisis.",
  ].join("\n\n");
  return { subject, text };
}

export function patientPayConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

export async function notifyPatientPayment({ to, plan, amount, idempotencyKey } = {}) {
  if (!patientPayConfigured()) return { sent: false, reason: "not_configured" };
  const email = String(to || "").trim().toLowerCase();
  if (!PATIENT_EMAIL.test(email) || email.length > 120) return { sent: false, reason: "bad_email" };
  const copy = patientPaymentCopy({ plan, amount });
  const from = process.env.NOTIFY_FROM || "iSpry <onboarding@resend.dev>";
  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  const key = String(idempotencyKey || "").replace(/[^\w.:/-]/g, "").slice(0, 256);
  if (key) headers["Idempotency-Key"] = key;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from,
        to: [email],
        subject: copy.subject.slice(0, 200),
        text: copy.text.slice(0, 4000),
      }),
    });
    if (!r.ok) {
      console.warn("notify patient: resend", r.status);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn("notify patient:", String(e?.message || e).slice(0, 120));
    return { sent: false, reason: "error" };
  }
}

/** Patient notice that a $49 visit fee was refunded. No symptoms, no names, no reason. */
export function patientRefundCopy() {
  const subject = "iSpry refund issued";
  const text = [
    "Your iSpry visit fee refund was issued. Stripe will show it on the card that paid the $49 visit.",
    "This email does not include your symptoms or why the visit was refunded.",
    "Pharmacy and lab charges are separate and are not part of this refund.",
    "An included membership visit does not refund the $100 membership.",
    "Questions: call or text (731) 415-0724.",
    "iSpry is not for emergencies. Call 911, or call or text 988 if you are in crisis.",
  ].join("\n\n");
  return { subject, text };
}

export async function notifyPatientRefund({ to, idempotencyKey } = {}) {
  if (!patientPayConfigured()) return { sent: false, reason: "not_configured" };
  const email = String(to || "").trim().toLowerCase();
  if (!PATIENT_EMAIL.test(email) || email.length > 120) return { sent: false, reason: "bad_email" };
  const copy = patientRefundCopy();
  const from = process.env.NOTIFY_FROM || "iSpry <onboarding@resend.dev>";
  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  const key = String(idempotencyKey || "").replace(/[^\w.:/-]/g, "").slice(0, 256);
  if (key) headers["Idempotency-Key"] = key;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from,
        to: [email],
        subject: copy.subject.slice(0, 200),
        text: copy.text.slice(0, 4000),
      }),
    });
    if (!r.ok) {
      console.warn("notify refund: resend", r.status);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn("notify refund:", String(e?.message || e).slice(0, 120));
    return { sent: false, reason: "error" };
  }
}
