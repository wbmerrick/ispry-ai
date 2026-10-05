// iSpry.ai — Spry AI intake endpoint (Vercel Node function).
// Stateless: conversation content is never stored or logged here.
// Primary: Vercel AI Gateway (Anthropic). Fallback: Cloudflare Workers AI.

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
- If the person describes anything that could be an emergency (chest pain or pressure, trouble breathing, stroke signs like face droop/weakness/slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, overdose or poisoning, thoughts of suicide or self-harm, or signs of a dangerous infection like stiff neck with fever or confusion), START your reply with the exact token [EMERGENCY] and tell them clearly to call 911 or go to the nearest ER now (and call or text 988 for suicidal thoughts). Keep that reply short. Do not continue intake.

MEMBERSHIP RULES (state them when relevant, plainly):
- Membership is $100 per month.
- Up to 3 visits per month.
- Up to 3 problems (concerns) per visit. If the person raises more than 3, ask them to prioritize the top 3 for this visit.
- Care is for patients physically located in Tennessee only. Confirm they are in Tennessee early if unclear.
- Ask them not to type names, birthdates, SSNs, or other identifiers in chat. Nothing is saved server-side.

HOW YOU WORK:
- Be warm, concise, and clinically useful. Talk like a thoughtful clinician, not a chatbot.
- Ask one or two focused follow-up questions at a time until you have enough for a draft care plan.
- Keep replies short enough to read aloud: patients may be using voice.
- Use plain words. Avoid jargon and long walls of text while gathering history.
- Acknowledge discomfort briefly when it fits ("Sorry you're feeling rough.") then move to the next useful question.
- When you have enough, produce a short draft care plan with:
  1) What kind of care this looks like (e.g. same-day sick visit, weight/GLP-1 consult, lab review, refill, fatigue workup)
  2) Three next steps
  3) Warning signs to watch for
  4) A clear note that a physician reviews every plan before anything is prescribed or finalized
- When the draft plan is ready for physician review, START that reply with the exact token [READY] (then the plan).

Tone: calm, direct, no scare tactics, no fake certainty.`;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

  // Health / credit check — does not store anything
  if (req.method === "GET" && (req.query?.check === "1" || String(req.url || "").includes("check=1"))) {
    try {
      const r = await fetch(GATEWAY, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || ""}`,
        },
        body: JSON.stringify({
          model: MODELS[0],
          stream: false,
          max_tokens: 8,
          messages: [
            { role: "system", content: "Reply with the single word: ok" },
            { role: "user", content: "ping" },
          ],
        }),
      });
      const text = await r.text();
      if (r.ok) return json(res, 200, { ok: true, backend: "vercel-ai-gateway", model: MODELS[0] });

      // Probe Cloudflare Workers AI fallback
      if (cfToken()) {
        try {
          const reply = await completeCloudflareNonStream(
            [{ role: "user", content: "ping" }],
            CF_MODELS[1],
          );
          if (reply) {
            return json(res, 200, {
              ok: true,
              backend: "cloudflare-workers-ai",
              model: CF_MODELS[1],
              vercel_error: `${MODELS[0]}: ${r.status}`,
            });
          }
        } catch (cfErr) {
          return json(res, 502, {
            error: `vercel: ${r.status} ${text.slice(0, 200)}; cloudflare: ${String(cfErr?.message || cfErr)}`,
          });
        }
      }

      return json(res, r.status >= 500 ? 502 : r.status, {
        error: `${MODELS[0]}: ${r.status} ${text.slice(0, 400)}`,
        cloudflare_fallback_configured: Boolean(cfToken()),
      });
    } catch (e) {
      return json(res, 502, { error: String(e?.message || e) });
    }
  }

  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

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
