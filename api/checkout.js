// iSpry.ai — public membership checkout + self-service portal links (Stripe).
// Stripe bills the $100/month membership. This route returns only public URLs;
// it never accepts patient data. STRIPE_CHECKOUT_URL / STRIPE_PORTAL_URL may
// override the defaults but must stay on Stripe-hosted domains.

import { originAllowed, rateLimit, safeStripeUrl } from "./_lib/guard.js";

export const DEFAULT_CHECKOUT = "https://buy.stripe.com/4gM7sNehu4CUcef1PL7Zu01";
export const DEFAULT_PORTAL = "https://billing.stripe.com/p/login/28EfZjb5i0mEa679id7Zu00";

export function checkoutUrl() {
  return safeStripeUrl(process.env.STRIPE_CHECKOUT_URL || "") || DEFAULT_CHECKOUT;
}
export function portalUrl() {
  return safeStripeUrl(process.env.STRIPE_PORTAL_URL || "") || DEFAULT_PORTAL;
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  if (!originAllowed(req)) return json(res, 403, { error: "forbidden_origin" });
  const limit = rateLimit(req, { name: "checkout", limit: 60, windowMs: 60_000 });
  if (!limit.ok) return json(res, 429, { error: "rate" });
  return json(res, 200, {
    configured: true,
    processor: "stripe",
    signup_url: checkoutUrl(),
    portal_url: portalUrl(),
  });
}
