// Per-user daily caps for the paid and chart routes.
// Durable counts live in public.ispry_usage_daily (service role only).
// Without SUPABASE_SERVICE_ROLE_KEY the cap is not enforced here; the
// in-memory per-IP limit in guard.js still applies.
// If the key is set but the table is missing, fall back to a per-instance
// counter so one warm isolate still has a ceiling.

import { supabaseConfig } from "../auth-config.js";

/** Must match the caps hardcoded in supabase/migrations/20261123120000_ispry_usage_daily.sql. */
export const DAILY_CAPS = {
  spry: 40,
  speak: 80,
  handoff: 6,
};

const memory = globalThis.__ispryDailyMem || (globalThis.__ispryDailyMem = new Map());

function centralDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

function memoryDaily(userId, endpoint) {
  const key = `${userId}:${endpoint}:${centralDay()}`;
  const count = (memory.get(key) || 0) + 1;
  memory.set(key, count);
  if (memory.size > 5000) {
    const today = centralDay();
    for (const k of memory.keys()) if (!k.endsWith(today)) memory.delete(k);
  }
  const cap = DAILY_CAPS[endpoint] || 0;
  return { ok: count <= cap, enforced: false, fallback: true, count };
}

/**
 * Count one call and say whether it is still under the daily cap.
 * ok: true means the caller may proceed.
 */
export async function consumeDailyCap(userId, endpoint, env = process.env) {
  const cap = DAILY_CAPS[endpoint];
  if (!cap || !userId) return { ok: false, enforced: false, count: 0 };
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!key) return { ok: true, enforced: false, count: 0 };

  const { url } = supabaseConfig();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/ispry_bump_daily_usage`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_user_id: userId, p_endpoint: endpoint }),
    });
    if (!r.ok) {
      console.warn("usage cap store", endpoint, r.status);
      return memoryDaily(userId, endpoint);
    }
    const data = await r.json();
    const row = Array.isArray(data) ? data[0] : data;
    const count = Number(row?.count || 0);
    return { ok: row?.allowed === true, enforced: true, count };
  } catch {
    console.warn("usage cap store", endpoint, "unreachable");
    return memoryDaily(userId, endpoint);
  }
}
