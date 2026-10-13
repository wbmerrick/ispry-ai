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
    /Visit basics\s*[—\-]\s*Age:\s*(\d{1,3})\.\s*In Tennessee now:\s*(Yes|No)\.\s*Problems this visit:\s*([123])\s+problems?/i,
  );
  if (!m) return null;
  return {
    age: Number(m[1]),
    inTennessee: m[2].toLowerCase() === "yes",
    problems: Number(m[3]),
  };
}

const GATE_STOP = "We cannot continue this intake.";

/**
 * Enforce age 18+ / TN / 1–3 problems when the client sends Visit basics.
 * A refusal does not count as progress: the next turn is still refused until
 * the first user message carries valid basics. A later window that already
 * contains a real assistant reply (the basics line scrolled off) may continue.
 */
export function visitBasicsGate(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const assistants = (messages || []).filter((m) => m && m.role === "assistant");
  const first = users[0];
  if (!first) {
    return { ok: false, reply: `Please start with your age, Tennessee yes/no, and how many problems (1–3). ${GATE_STOP}` };
  }
  const basics = parseVisitBasics(first.content);
  if (!basics) {
    const continued = assistants.some((a) => a.content && !String(a.content).includes(GATE_STOP));
    if (continued) return { ok: true };
    return {
      ok: false,
      reply:
        `Please complete age (18+), Tennessee yes/no, and how many problems (1–3) before continuing with Spry. ${GATE_STOP}`,
    };
  }
  if (!(basics.age >= 18 && basics.age <= 120)) {
    const reply = basics.age > 120
      ? `Enter an age from 18 to 120. ${GATE_STOP}`
      : `iSpry membership is for adults 18 and older. ${GATE_STOP}`;
    return { ok: false, reply };
  }
  if (!basics.inTennessee) {
    return {
      ok: false,
      reply: `iSpry care is for patients physically in Tennessee. ${GATE_STOP}`,
    };
  }
  if (!(basics.problems >= 1 && basics.problems <= 3)) {
    return {
      ok: false,
      reply: `iSpry visits cover up to 3 problems. Please choose 1, 2, or 3. ${GATE_STOP}`,
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

/** Public Hint enrollment link only. Rejects other hosts so a bad env cannot retarget Join. */
export function safeHintSignupUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== "hint.com" && !host.endsWith(".hint.com")) return null;
    return u.href;
  } catch {
    return null;
  }
}
