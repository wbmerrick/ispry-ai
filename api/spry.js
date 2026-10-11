// iSpry.ai — Spry AI intake endpoint (Vercel Node function).
// Stateless: conversation content is never stored or logged here.
// Primary: Vercel AI Gateway (Anthropic). Fallback: Cloudflare Workers AI.

import { originAllowed, rateLimit, visitBasicsGate } from "./_lib/guard.js";

const MODELS = [
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4",
];
const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "6ae0262433442a2b78389b55685fcb4a";
const CF_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fast",
];

const SYSTEM = `You are Spry, the AI intake assistant for iSpry.ai — a physician-led telehealth practice serving patients located in Tennessee. The medical director is William B. Merrick, DO (internal medicine / hospitalist). You do intake and triage only. You never diagnose definitively, never prescribe, and never promise a specific medication or outcome — every plan is decided by a licensed physician.

Many patients message you while they feel awful — feverish, exhausted, foggy, or anxious. Make it easy for them.

SAFETY FIRST (every message):
- If the person describes a medical emergency (chest pain or pressure, trouble breathing or airway concern, stroke signs like face droop/weakness/slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, overdose or poisoning, or signs of a dangerous infection like stiff neck with fever or confusion), START your reply with the exact token [EMERGENCY]. In that reply: (1) name the specific symptoms that make this urgent, (2) say clearly to call 911 or go to the nearest ER now and not wait for an online visit. Keep it short. Do not continue intake.
- Mention 988 / the Suicide & Crisis Lifeline ONLY if they express suicidal thoughts, self-harm, or homicidal thoughts — never attach 988 to ordinary medical emergencies (sore throat, fever, breathing trouble, chest pain, etc.).
- For suicide/self-harm/homicidal crisis: START with [EMERGENCY], name that concern directly, tell them to call or text 988 now, and if they are in immediate danger also call 911. Do not continue intake.

MEMBERSHIP RULES (state them when relevant, plainly):
- Membership is $100 per month.
- Up to 3 visits per month.
- Up to 3 problems (concerns) per visit. If the person raises more than 3, ask them to prioritize the top 3 for this visit.
- Care is for patients physically located in Tennessee only. If they are outside Tennessee, say we cannot continue an iSpry visit and stop intake.
- Ask them not to type names, birthdates, SSNs, or other identifiers in chat. Nothing is saved server-side.

OPENING SEQUENCE (required before clinical history):
Lead every new intake with these three basics — in this order — before digging into symptoms, meds, or a care plan:
  1) Patient age (years only, 18+ — never ask for date of birth). If under 18, say iSpry is for adults and stop intake.
  2) Whether they are physically in Tennessee right now (yes/no)
  3) How many problems they want addressed this visit (1, 2, or 3 max)
If the first message already includes all three, acknowledge briefly and then ask about the top problem. If any are missing, ask only for what is still missing (one or two at a time). Do not skip this gate.

HOW YOU WORK:
- Be warm, concise, and clinically useful. Talk like a thoughtful clinician, not a chatbot.
- After the opening basics, ask one or two focused follow-up questions at a time until you have enough for a draft care plan.
- Keep replies short enough to read aloud: patients may be using voice.
- Use plain words. Avoid jargon and long walls of text while gathering history.
- Acknowledge discomfort briefly when it fits ("Sorry you're feeling rough.") then move to the next useful question.
- When you have enough, produce a short draft care plan with:
  1) What kind of care this looks like (e.g. same-day sick visit, weight/GLP-1 consult, lab review, refill, fatigue workup)
  2) Three next steps
  3) Warning signs to watch for
  4) A clear note that a physician reviews every plan before anything is prescribed or finalized
- In the draft plan, do not name specific prescription drugs, antibiotics, or doses. Say the physician will choose any treatment. Over-the-counter comfort care (rest, fluids, label-directed acetaminophen or ibuprofen) is fine.
- iSpry does not prescribe controlled substances (opioids, benzodiazepines, stimulants, etc.). If asked, say so plainly and offer intake for the underlying concern.
- Don't re-ask a question the person already answered; if they skip one, ask it once more at most, then move on.
- When the draft plan is ready for physician review, the VERY FIRST characters of that reply must be the exact token [READY] — nothing before it, not even a greeting. Then the plan. Never put [READY] or [EMERGENCY] anywhere except the very start.

Tone: calm, direct, no scare tactics, no fake certainty.`;

// Same lists the browser uses; duplicated here so the server never relies on the client.
const MEDICAL_EMERGENCY_RE =
  /chest (pain|pressure|tight|hurts)|crushing chest|heart attack|can'?t breathe|cannot breathe|can'?t catch (my )?breath|cannot catch (my )?breath|trouble breathing|difficulty breathing|hard to breathe|breathing (is |feels )?(tight|hard|difficult)|tight breathing|short(ness)? of breath|muffled voice|stroke|face droop|slurred speech|overdose|poison|unconscious|passed out|faint|seizure|severe bleeding|coughing (up )?blood|anaphyla|throat (is )?(closing|swelling)|airway/i;
const CRISIS_RE =
  /suicid|kill myself|end my life|ending it all|self[- ]?harm|want to die|hurt myself|cut myself|homicid|kill (him|her|them|someone|people)|hurt (him|her|them|someone) on purpose/i;
const EMERGENCY_RE = new RegExp(
  "(?:" + MEDICAL_EMERGENCY_RE.source + ")|(?:" + CRISIS_RE.source + ")",
  "i",
);
const NEG_BEFORE =
  /\b(no|not|denies|deny|denied|without|never|negative for|don'?t have|do not have|doesn'?t have|haven'?t had|has not had|have not had)\s+(had\s+)?(a\s+|an\s+|any\s+|really\s+|much\s+)?((\w+[\s,]+){1,4}or\s+)?$/i;

function matchFlags(re, text) {
  const out = [];
  const r = new RegExp(re.source, "gi");
  const s = String(text || "");
  let m;
  while ((m = r.exec(s))) {
    if (!NEG_BEFORE.test(s.slice(Math.max(0, m.index - 40), m.index))) out.push(m[0]);
  }
  return out;
}
function isCrisis(text) {
  return matchFlags(CRISIS_RE, text).length > 0;
}
function isEmergency(text) {
  return matchFlags(EMERGENCY_RE, text).length > 0;
}
function emergencyReply(text) {
  const crisis = isCrisis(text);
  const medical = matchFlags(MEDICAL_EMERGENCY_RE, text);
  if (crisis && !medical.length) {
    return "[EMERGENCY] You mentioned thoughts of harming yourself or others. Please call or text 988 (Suicide & Crisis Lifeline) now. If you are in immediate danger, call 911. Do not wait for an online visit.";
  }
  const named = medical.length
    ? medical
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s, i, a) => a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
        .slice(0, 4)
        .join(", ")
    : "what you described";
  let msg =
    "[EMERGENCY] These symptoms need emergency care now — especially: " +
    named +
    ". Please call 911 or go to the nearest emergency room. Do not wait for an online visit.";
  if (crisis) {
    msg +=
      " Because you also mentioned thoughts of harming yourself or others, call or text 988 as well.";
  }
  return msg;
}

function cors(res) {
  // Same-origin browser calls only — do not open the credit-burning endpoints to any site.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function cfToken() {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
}

async function completeVercel(messages, model) {
  return fetch(GATEWAY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || ""}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.4,
      max_tokens: 1200,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
  });
}

async function completeCloudflare(messages, model) {
  const token = cfToken();
  if (!token) return null;
  // OpenAI-compatible Workers AI endpoint (SSE when stream:true)
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.4,
        max_tokens: 1200,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    },
  );
}

async function streamOpenAiSse(r, res) {
  if (!r.body) throw new Error("empty body");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let wrote = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
        if (delta) {
          res.write(delta);
          wrote = true;
        }
      } catch {
        /* ignore partial JSON */
      }
    }
  }
  return wrote;
}

async function completeCloudflareNonStream(messages, model) {
  const token = cfToken();
  if (!token) return null;
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        max_tokens: 1200,
        temperature: 0.4,
      }),
    },
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`${model}: ${r.status} ${text.slice(0, 400)}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${model}: bad_json`);
  }
  const content =
    j?.result?.response ||
    j?.result?.choices?.[0]?.message?.content ||
    j?.response ||
    "";
  if (!content) throw new Error(`${model}: empty_response`);
  return String(content);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (!originAllowed(req)) {
    return json(res, 403, { error: "forbidden_origin" });
  }

  // Config probe only — never spend model tokens on health checks.
  if (req.method === "GET" && (req.query?.check === "1" || String(req.url || "").includes("check=1"))) {
    return json(res, 200, {
      ok: true,
      gateway_configured: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
      cloudflare_fallback_configured: Boolean(cfToken()),
    });
  }

  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const rl = rateLimit(req, { name: "spry", limit: 20, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "rate_limited" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
  }
  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  const messages = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-24)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  if (!messages.length) return json(res, 400, { error: "empty" });

  // Hard safety net: never depend on the model (or its fallback) to catch emergencies.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && isEmergency(lastUser.content)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(emergencyReply(lastUser.content));
  }

  // Server-side membership gate (age / TN / problem count) — do not trust the client alone.
  const gate = visitBasicsGate(messages);
  if (!gate.ok) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(gate.reply);
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;

  let lastErr = "";

  // 1) Prefer Vercel AI Gateway (Anthropic)
  for (const model of MODELS) {
    try {
      const r = await completeVercel(messages, model);
      if (!r.ok) {
        lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 400)}`;
        continue;
      }
      const wrote = await streamOpenAiSse(r, res);
      if (wrote) return res.end();
      lastErr = `${model}: empty stream`;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  // 2) Cloudflare Workers AI fallback (same SYSTEM prompt)
  if (cfToken()) {
    for (const model of CF_MODELS) {
      try {
        const r = await completeCloudflare(messages, model);
        if (r && r.ok) {
          const wrote = await streamOpenAiSse(r, res);
          if (wrote) return res.end();
        } else if (r) {
          lastErr = `cf ${model}: ${r.status} ${(await r.text()).slice(0, 400)}`;
        }
        // Non-stream fallback if SSE path fails
        const text = await completeCloudflareNonStream(messages, model);
        res.write(text);
        return res.end();
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
  } else {
    lastErr = `${lastErr || "vercel_failed"}; cloudflare_fallback_missing_token`;
  }

  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(
    JSON.stringify({
      error: "Spry is unavailable right now. Please try again in a moment.",
      detail: lastErr || "all_models_failed",
    }),
  );
}
