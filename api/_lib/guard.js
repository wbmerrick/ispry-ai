// Shared request guards for iSpry API routes (not a public endpoint).

const ALLOWED_ORIGINS = new Set([
  "https://ispry.ai",
  "https://www.ispry.ai",
  "https://ispry-ai.vercel.app",
]);

const store = globalThis.__ispryRateBuckets || (globalThis.__ispryRateBuckets = new Map());

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return xf || String(req.headers["x-real-ip"] || "").trim() || "unknown";
}

/** Best-effort fixed window. Survives warm isolates only — pair with Vercel Firewall. */
export function rateLimit(req, { name, limit, windowMs }) {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  // Opportunistic prune
  if (store.size > 2000) {
    for (const [k, v] of store) {
      if (now >= v.resetAt) store.delete(k);
    }
  }
  return {
    ok: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

export function originAllowed(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true; // non-browser / same-origin edge cases
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    if (
      u.protocol === "https:" &&
      u.hostname.endsWith(".vercel.app") &&
      /ispry/i.test(u.hostname)
    ) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Parse the client "Visit basics — Age: …" line from the first user message. */
export function parseVisitBasics(text) {
  const s = String(text || "");
  const m = s.match(
    /Visit basics\s*[—\-]\s*Age:\s*(\d{1,3})\.\s*Sex:\s*(Male(?:\s*\(M\))?|Female(?:\s*\(FM\))?)\.\s*In Tennessee now:\s*(Yes|No)\./i,
  );
  if (!m) return null;
  const sexRaw = m[2].toLowerCase();
  return {
    age: Number(m[1]),
    sex: sexRaw.startsWith("female") ? "female" : "male",
    inTennessee: m[3].toLowerCase() === "yes",
  };
}

const GATE_STOP = "We cannot continue this intake.";

/** Messages a visitor may send before an account. The cap is on one transcript, not a cross-visit identity. */
export const GUEST_PREVIEW_TURNS = 2;

/**
 * Enforce age 18+ / sex / Tennessee once a transcript includes Visit basics.
 * Without basics, the first two user messages are a preview. A longer transcript
 * without basics stops, so a guest chat cannot continue by stuffing assistant replies.
 * The client keeps the Visit basics line in the payload after an account exists.
 */
export function visitBasicsGate(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const first = users[0];
  if (!first) {
    return { ok: false, reply: `Please start with your age, M/FM, and Tennessee yes/no. ${GATE_STOP}` };
  }
  const basicsMsg = users.find((m) => parseVisitBasics(m.content));
  const basics = basicsMsg ? parseVisitBasics(basicsMsg.content) : null;
  if (!basics) {
    if (users.length <= GUEST_PREVIEW_TURNS) return { ok: true, preview: true };
    return {
      ok: false,
      reply:
        `You've had two messages with Spry. Create an iSpry account — age, sex, and Tennessee — to keep going. ${GATE_STOP}`,
    };
  }
  if (!(basics.age >= 18 && basics.age <= 120)) {
    const reply = basics.age > 120
      ? `Enter an age from 18 to 120. ${GATE_STOP}`
      : `iSpry membership is for adults 18 and older. ${GATE_STOP}`;
    return { ok: false, reply };
  }
  if (basics.sex !== "male" && basics.sex !== "female") {
    return {
      ok: false,
      reply: `Please choose M or FM. ${GATE_STOP}`,
    };
  }
  if (!basics.inTennessee) {
    return {
      ok: false,
      reply: `iSpry care is for patients physically in Tennessee. ${GATE_STOP}`,
    };
  }
  return { ok: true, basics };
}

export function safeBookingUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Stripe-hosted checkout or customer-portal link only. Rejects other hosts so a bad env cannot retarget Join. */
export function safeStripeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!["buy.stripe.com", "checkout.stripe.com", "billing.stripe.com"].includes(host)) return null;
    return u.href;
  } catch {
    return null;
  }
}
