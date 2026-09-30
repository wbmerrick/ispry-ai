// iSpry.ai — calm TTS for Spry voice replies (Vercel AI Gateway).
// Stateless: text is not stored; audio is streamed back to the client.

const GATEWAY_SPEECH = "https://ai-gateway.vercel.sh/v4/ai/speech-model";
const MODELS = ["openai/tts-1-hd", "openai/tts-1"];
const VOICE = "nova";
const MAX_CHARS = 700;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function authHeader() {
  const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || "";
  return key ? `Bearer ${key}` : "";
}

function sanitize(text) {
  return String(text || "")
    .replace(/^\s*\[(EMERGENCY|READY)\]\s*/i, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[_`#]/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

function b64ToBuffer(b64) {
  return Buffer.from(String(b64 || ""), "base64");
}

async function synthesize(text, model) {
  const r = await fetch(GATEWAY_SPEECH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      "ai-model-id": model,
    },
    body: JSON.stringify({
      text,
      voice: VOICE,
      outputFormat: "mp3",
      speed: 0.95,
      language: "en",
      instructions:
        "Speak calmly and warmly, like a gentle triage nurse. Clear, unhurried, and reassuring. No theatrical emotion.",
    }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`${model}: ${r.status} ${raw.slice(0, 240)}`);
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`${model}: bad_json`);
  }
  const audio = j?.audio || j?.data?.audio || "";
  if (!audio) throw new Error(`${model}: empty_audio`);
  return b64ToBuffer(audio);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
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

  const text = sanitize(body?.text);
  if (!text) return json(res, 400, { error: "empty" });
  if (!authHeader()) return json(res, 503, { error: "tts_unconfigured" });

  let lastErr = "";
  for (const model of MODELS) {
    try {
      const buf = await synthesize(text, model);
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Spry-Voice", VOICE);
      res.setHeader("X-Spry-TTS-Model", model);
      return res.end(buf);
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  return json(res, 502, {
    error: "Spry voice is unavailable right now.",
    detail: lastErr || "tts_failed",
  });
}
