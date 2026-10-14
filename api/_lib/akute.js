// Akute helpers shared by server routes (not a public endpoint).
// Membership events only ever create TASKS on the patient — never signed notes,
// never chart status changes — so nothing enters the chart until the physician acts.

const BASE = process.env.AKUTE_BASE_URL || "https://api.akutehealth.com/v1";

export function akuteConfigured() {
  return Boolean(process.env.AKUTE_API_KEY);
}

export async function akute(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      "X-API-Key": process.env.AKUTE_API_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const hint = data?.message || data?.error || text || "";
    throw new Error(`Akute ${opts.method || "GET"} ${path.split("?")[0]} -> ${r.status} ${String(hint).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  return data;
}

export const list = (d) => (Array.isArray(d) ? d : d?.data || d?.results || d?.items || []);
export const idOf = (o) => o?.id || o?.data?.id || o?.patient_id;

/** Exact-email patient lookup. Requires a single unambiguous match; otherwise null. */
export async function findPatientByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const found = list(await akute(`/patients?${new URLSearchParams({ email: e, limit: "10" })}`));
  const exact = found.filter((p) => String(p?.email || "").toLowerCase() === e);
  return exact.length === 1 ? idOf(exact[0]) : null;
}

/**
 * Create a task for the physician. Akute rejects some owner_id / field combos with
 * 500 "malformed data", so try the richest body first and strip optional fields.
 */
export async function createTask({ title, description, patientId, ownerId, priority = "p2", tags = [] }) {
  const today = new Date().toISOString().slice(0, 10);
  const base = { task: title, status: "not-started" };
  const bodies = [
    { ...base, description, due_date: today, owner_id: ownerId, patient_id: patientId, priority, tags },
    { ...base, description, due_date: today, owner_id: ownerId, patient_id: patientId, priority },
    { ...base, description, owner_id: ownerId, patient_id: patientId },
    { ...base, description, patient_id: patientId },
    { ...base, description: String(description || "").slice(0, 2000), patient_id: patientId },
    { task: title, patient_id: patientId },
    { task: title },
  ].map((b) => {
    const out = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined && v !== null && v !== "") out[k] = v;
    return out;
  });
  let lastErr = null;
  for (const body of bodies) {
    try {
      await akute("/tasks", { method: "POST", body: JSON.stringify(body) });
      return { ok: true, withOwner: Boolean(body.owner_id), withPatient: Boolean(body.patient_id) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("task_failed");
}
