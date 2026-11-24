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
  if (!origin) {
    // Browsers send Origin on POST. Missing Origin used to skip this check, so a
    // script could call the paid and chart routes with no Origin at all.
    // GET config probes (the uptime check) and CORS preflight do not send one.
    // The Stripe webhook does not use this helper; it checks Stripe's signature.
    const method = String(req.method || "GET").toUpperCase();
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
  }
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
    /Visit basics\s*[—\-]\s*Age:\s*(\d{1,3})\.\s*Sex:\s*(Male(?:\s*\(M\))?|Female(?:\s*\(F(?:M)?\))?)\.\s*In Tennessee now:\s*(Yes|No)\./i,
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

/** Guest preview turns before an account. Always 0 — account is required before Spry. */
export const GUEST_PREVIEW_TURNS = 0;

/**
 * Spry input budget. A visit is a handful of short answers plus one synopsis,
 * so the old 24 × 4,000 window was far larger than a real intake.
 */
export const SPRY_INPUT = {
  maxMessages: 16,
  maxUserChars: 1500,
  maxAssistantChars: 3500,
  maxTokens: 900,
};

/** Keep a visit-basics line if the tail slice would drop it. Truncate each message. */
export function normalizeSpryMessages(incoming) {
  const all = (Array.isArray(incoming) ? incoming : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(
        0,
        m.role === "assistant" ? SPRY_INPUT.maxAssistantChars : SPRY_INPUT.maxUserChars,
      ),
    }));
  const basics = all.find((m) => m.role === "user" && parseVisitBasics(m.content));
  let tail = all.slice(-SPRY_INPUT.maxMessages);
  if (basics && !tail.includes(basics)) {
    tail = [basics, ...tail.slice(-(SPRY_INPUT.maxMessages - 1))];
  }
  return tail;
}

/** Visit-basics line taken from the account row, not from the browser. */
export function serverBasicsLine(profile) {
  const age = Number(profile?.age);
  const sex = profile?.sex === "female" ? "Female (F)" : "Male (M)";
  const tn = profile?.in_tennessee ? "Yes" : "No";
  return `Visit basics — Age: ${age}. Sex: ${sex}. In Tennessee now: ${tn}.`;
}

const BASICS_RE =
  /Visit basics\s*[—\-]\s*Age:\s*\d{1,3}\.\s*Sex:\s*(?:Male(?:\s*\(M\))?|Female(?:\s*\(F(?:M)?\))?)\.\s*In Tennessee now:\s*(?:Yes|No)\./i;

/** Replace a client-typed basics line with the account row. Prepends one if the client sent none. */
export function applyServerBasics(messages, profile) {
  const line = serverBasicsLine(profile);
  let replaced = false;
  const out = (messages || []).map((m) => {
    if (replaced || !m || m.role !== "user" || !parseVisitBasics(m.content)) return m;
    replaced = true;
    const rest = String(m.content).replace(BASICS_RE, "").trim();
    return { role: "user", content: rest ? `${line}\n\n${rest}` : line };
  });
  if (!replaced) return [{ role: "user", content: line }, ...out];
  return out;
}

/**
 * Enforce age 18+ / sex / Tennessee. Visit basics come from the iSpry account
 * (client prepends them). Without basics, refuse — no guest preview chat.
 */
export function visitBasicsGate(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const first = users[0];
  if (!first) {
    return { ok: false, reply: `Please start with your age, M/F, and Tennessee yes/no. ${GATE_STOP}` };
  }
  const basicsMsg = users.find((m) => parseVisitBasics(m.content));
  const basics = basicsMsg ? parseVisitBasics(basicsMsg.content) : null;
  if (!basics) {
    return {
      ok: false,
      reply:
        `Create an iSpry account — age, sex, and Tennessee — before talking with Spry. ${GATE_STOP}`,
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
      reply: `Please choose M or F. ${GATE_STOP}`,
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

/** Valid https URL for Akute patient follow-through (forms bundle or self-scheduling). */
export function safeBookingUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
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
