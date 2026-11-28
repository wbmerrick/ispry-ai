// Verify a Supabase access token with the Auth server. The browser never
// supplies an email or user id that this function trusts.

import { supabaseConfig } from "../auth-config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verified, email-confirmed Supabase user for a bearer token, or null. */
export async function sessionUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+([A-Za-z0-9._-]{20,4000})$/);
  if (!m) return null;
  const { url, anon } = supabaseConfig();
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${m[1]}`, apikey: anon },
    });
    if (!r.ok) return null;
    const u = await r.json();
    const email = String(u?.email || "").trim().toLowerCase();
    if (!u?.id || !email || !(u.email_confirmed_at || u.confirmed_at)) return null;
    // app_metadata is set in the Supabase dashboard. user_metadata is not a role.
    const metaRole = String(u?.app_metadata?.role || "").trim().toLowerCase();
    const role = metaRole === "physician" || metaRole === "admin" ? metaRole : "";
    return { id: String(u.id), email, role };
  } catch {
    return null;
  }
}

/**
 * Account row (age, sex, Tennessee) read with the service role.
 * available: false when the key is unset or the id is not a uuid — callers
 * keep the client basics line, but a session is still required.
 * error: true when the store was reachable in config but the read failed.
 */
export async function loadPatientProfile(userId, env = process.env) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!key || !UUID_RE.test(String(userId || ""))) return { available: false, profile: null, error: false };
  const { url } = supabaseConfig();
  try {
    const r = await fetch(
      `${url}/rest/v1/ispry_profiles?id=eq.${userId}&select=age,sex,in_tennessee`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" } },
    );
    if (!r.ok) return { available: true, profile: null, error: true };
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { available: true, profile: null, error: false };
    return {
      available: true,
      error: false,
      profile: {
        age: Number(row.age),
        sex: row.sex === "female" ? "female" : "male",
        in_tennessee: row.in_tennessee === true,
      },
    };
  } catch {
    return { available: true, profile: null, error: true };
  }
}
