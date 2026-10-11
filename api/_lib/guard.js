// Shared request guards for iSpry API routes (not a public endpoint).

const ALLOWED_ORIGINS = new Set([
  "https://ispry.ai",
  "https://www.ispry.ai",
  "https://ispry-ai.vercel.app",
]);

const store = globalThis.__ispryRateBuckets || (globalThis.__ispryRateBuckets = new Map());

export function clientIp(req) {
  // Prefer platform-provided client IP; fall back to first X-Forwarded-For hop.
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const xf = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return xf || "unknown";
}

function memoryRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  if (store.size > 2000) {
    for (const [k, v] of store) {
      if (now >= v.resetAt) store.delete(k);
    }
  }
  return {
    ok: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
    backend: "memory",
  };
}

/**
 * Fixed-window rate limit.
 * Uses Upstash Redis REST when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * are set (durable across isolates). Otherwise memory (warm-isolate best-effort).
 */
export async function rateLimit(req, { name, limit, windowMs }) {
  const key = `ispry:rl:${name}:${clientIp(req)}`;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const sec = Math.max(1, Math.ceil(windowMs / 1000));
      const r = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          ["INCR", key],
          ["EXPIRE", key, sec],
        ]),
      });
      if (r.ok) {
        const data = await r.json();
        const count = Number(data?.[0]?.result ?? data?.[0] ?? 0);
        if (Number.isFinite(count) && count > 0) {
          return {
            ok: count <= limit,
            remaining: Math.max(0, limit - count),
            resetAt: Date.now() + windowMs,
            backend: "upstash",
          };
        }
      }
    } catch {
      /* fall through to memory */
    }
  }
  return memoryRateLimit(key, limit, windowMs);
}

/** Sync helper for unit tests / callers that cannot await. */
export function rateLimitSync(req, opts) {
  return memoryRateLimit(`ispry:rl:${opts.name}:${clientIp(req)}`, opts.limit, opts.windowMs);
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

/**
 * Enforce age 18+ / TN / 1–3 problems when the client sends Visit basics.
 * If the first user message has no basics line, refuse (bypass protection).
 * Mid-conversation (assistant already replied) is allowed without re-parsing.
 */
export function visitBasicsGate(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const assistants = (messages || []).filter((m) => m && m.role === "assistant");
  const first = users[0];
  if (!first) {
    return { ok: false, reply: "Please start with your age, Tennessee yes/no, and how many problems (1–3)." };
  }
  const basics = parseVisitBasics(first.content);
  if (!basics) {
    if (assistants.length > 0) return { ok: true };
    return {
      ok: false,
      reply:
        "Please complete age (18+), Tennessee yes/no, and how many problems (1–3) before continuing with Spry.",
    };
  }
  if (!(basics.age >= 18 && basics.age < 120)) {
    return { ok: false, reply: "iSpry membership is for adults 18 and older. We cannot continue this intake." };
  }
  if (!basics.inTennessee) {
    return {
      ok: false,
      reply: "iSpry care is for patients physically in Tennessee. We cannot continue this intake.",
    };
  }
  if (!(basics.problems >= 1 && basics.problems <= 3)) {
    return {
      ok: false,
      reply: "iSpry visits cover up to 3 problems. Please choose 1, 2, or 3 to continue.",
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
