// iSpry.ai — natural Spry voice (sweet triage nurse).
// Primary: Vercel AI Gateway (Google / OpenAI). Optional: Grok if XAI_API_KEY is set.
// Stateless: text is not stored; audio is returned to the client.

const XAI_TTS = "https://api.x.ai/v1/tts";
const GATEWAY_SPEECH = "https://ai-gateway.vercel.sh/v4/ai/speech-model";
const GATEWAY_OPENAI_SPEECH = "https://ai-gateway.vercel.sh/v1/audio/speech";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "6ae0262433442a2b78389b55685fcb4a";
// Optional Grok voice when XAI_API_KEY is present (luna = gentle / nurturing)
const GROK_VOICE = process.env.SPRY_VOICE_ID || "luna";
const OPENAI_VOICE = process.env.SPRY_OPENAI_VOICE || "nova";
const GOOGLE_VOICE = process.env.SPRY_GOOGLE_VOICE || "Aoede";
const SPEECH_SPEED = Math.min(1.5, Math.max(0.7, Number(process.env.SPRY_VOICE_SPEED || 1.2) || 1.2));
const NURSE_STYLE =
  process.env.SPRY_VOICE_STYLE ||
  "Speak like a sweet, caring triage nurse: soft smile in the voice, warm and reassuring, gently expressive — never robotic, never stern.";
const MAX_CHARS = 900;

function cors(res) {
  // Same-origin browser calls only — do not open TTS spend to any site.
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function gatewayAuth() {
  const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || "";
  return key ? `Bearer ${key}` : "";
}

function xaiKey() {
  return process.env.XAI_API_KEY || process.env.GROK_API_KEY || "";
}

function cfToken() {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
}

function sanitize(text) {
  return String(text || "")
    .replace(/\s*\[(EMERGENCY|READY)\]\s*/gi, " ")
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

async function bufferFromAudioField(audio) {
  if (!audio) throw new Error("empty_audio");
  if (typeof audio !== "string") throw new Error("bad_audio");
  if (audio.startsWith("http://") || audio.startsWith("https://")) {
    const r = await fetch(audio);
    if (!r.ok) throw new Error(`audio_url: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (audio.startsWith("data:")) {
    const i = audio.indexOf("base64,");
    if (i === -1) throw new Error("bad_data_url");
    return b64ToBuffer(audio.slice(i + 7));
  }
  return b64ToBuffer(audio);
}

function gatewaySpeechHeaders(model) {
  return {
    "Content-Type": "application/json",
    Authorization: gatewayAuth(),
    "ai-gateway-protocol-version": "0.0.1",
    "ai-speech-model-specification-version": "4",
    "ai-model-id": model,
  };
}

async function synthesizeGatewaySpeech(text, model, opts) {
  const auth = gatewayAuth();
  if (!auth) throw new Error("gateway_missing");
  const r = await fetch(GATEWAY_SPEECH, {
    method: "POST",
    headers: gatewaySpeechHeaders(model),
    body: JSON.stringify({
      text,
      voice: opts.voice,
      outputFormat: opts.outputFormat || "mp3",
      ...(opts.speed != null ? { speed: opts.speed } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
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
  const buf = await bufferFromAudioField(j?.audio || j?.data?.audio || "");
  return { buf, contentType: opts.outputFormat === "wav" ? "audio/wav" : "audio/mpeg" };
}

async function synthesizeOpenAiCompat(text) {
  const auth = gatewayAuth();
  if (!auth) throw new Error("gateway_missing");
  const r = await fetch(GATEWAY_OPENAI_SPEECH, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/tts-1-hd",
      input: text,
      voice: OPENAI_VOICE,
      response_format: "mp3",
      speed: SPEECH_SPEED,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`openai/audio/speech: ${r.status} ${err.slice(0, 240)}`);
  }
  const ctype = r.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const j = JSON.parse(await r.text());
    const buf = await bufferFromAudioField(j.audio || j.data?.[0]?.b64_json || "");
    return { buf, contentType: "audio/mpeg" };
  }
  return { buf: Buffer.from(await r.arrayBuffer()), contentType: "audio/mpeg" };
}

async function synthesizeGrokXai(text) {
  const key = xaiKey();
  if (!key) throw new Error("xai_key_missing");
  const r = await fetch(XAI_TTS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: GROK_VOICE,
      language: "en",
      text_normalization: true,
      speed: SPEECH_SPEED,
      output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 192000 },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`xai/grok-tts: ${r.status} ${err.slice(0, 240)}`);
  }
  const ctype = r.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const j = JSON.parse(await r.text());
    const buf = await bufferFromAudioField(j.audio || j.data?.audio || j.result?.audio || "");
    return { buf, contentType: "audio/mpeg" };
  }
  return { buf: Buffer.from(await r.arrayBuffer()), contentType: "audio/mpeg" };
}

async function synthesizeGrokCloudflare(text) {
  const token = cfToken();
  if (!token) throw new Error("cf_token_missing");
  const payload = {
    text,
    voice_id: GROK_VOICE,
    language: "en",
    text_normalization: true,
    speed: SPEECH_SPEED,
    output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 192000 },
  };
  const urls = [
    { url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/xai/grok-tts`, body: payload },
    { url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run`, body: { model: "xai/grok-tts", input: payload } },
  ];
  let lastErr = "cf_failed";
  for (const attempt of urls) {
    const r = await fetch(attempt.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(attempt.body),
    });
    const raw = await r.text();
    if (!r.ok) {
      lastErr = `cf/xai/grok-tts: ${r.status} ${raw.slice(0, 240)}`;
      continue;
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      lastErr = "cf/xai/grok-tts: bad_json";
      continue;
    }
    const audio = j?.result?.audio || j?.result?.response?.audio || j?.audio || j?.result || "";
    if (typeof audio === "string" && audio) {
      return { buf: await bufferFromAudioField(audio), contentType: "audio/mpeg" };
    }
    if (audio && typeof audio === "object" && audio.url) {
      return { buf: await bufferFromAudioField(audio.url), contentType: "audio/mpeg" };
    }
    lastErr = "cf/xai/grok-tts: empty_audio";
  }
  throw new Error(lastErr);
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

  // Prefer AI Gateway paths that work with AI_GATEWAY_API_KEY (already on the project).
  // Grok only runs when XAI_API_KEY / GROK_API_KEY is configured.
  const attempts = [
    {
      name: `google/gemini-3.8-flash-tts:${GOOGLE_VOICE}`,
      voiceLabel: GOOGLE_VOICE,
      run: () =>
        synthesizeGatewaySpeech(text, "google/gemini-3.8-flash-tts", {
          voice: GOOGLE_VOICE,
          outputFormat: "wav",
          instructions: NURSE_STYLE,
        }),
    },
    {
      name: `google/gemini-3.8-flash-lite-tts:${GOOGLE_VOICE}`,
      voiceLabel: GOOGLE_VOICE,
      run: () =>
        synthesizeGatewaySpeech(text, "google/gemini-3.8-flash-lite-tts", {
          voice: GOOGLE_VOICE,
          outputFormat: "wav",
          instructions: NURSE_STYLE,
        }),
    },
    {
      name: `openai/tts-1-hd:${OPENAI_VOICE}@${SPEECH_SPEED}`,
      voiceLabel: OPENAI_VOICE,
      run: () =>
        synthesizeGatewaySpeech(text, "openai/tts-1-hd", {
          voice: OPENAI_VOICE,
          outputFormat: "mp3",
          speed: SPEECH_SPEED,
          language: "en",
          instructions: NURSE_STYLE,
        }),
    },
    {
      name: `openai/tts-1:${OPENAI_VOICE}@${SPEECH_SPEED}`,
      voiceLabel: OPENAI_VOICE,
      run: () =>
        synthesizeGatewaySpeech(text, "openai/tts-1", {
          voice: OPENAI_VOICE,
          outputFormat: "mp3",
          speed: SPEECH_SPEED,
          language: "en",
          instructions: NURSE_STYLE,
        }),
    },
    {
      name: `openai/audio/speech:${OPENAI_VOICE}`,
      voiceLabel: OPENAI_VOICE,
      run: () => synthesizeOpenAiCompat(text),
    },
    {
      name: `xai/grok-tts:${GROK_VOICE}@${SPEECH_SPEED}`,
      voiceLabel: GROK_VOICE,
      run: () => synthesizeGrokXai(text),
    },
    {
      name: `cf/xai/grok-tts:${GROK_VOICE}@${SPEECH_SPEED}`,
      voiceLabel: GROK_VOICE,
      run: () => synthesizeGrokCloudflare(text),
    },
  ];

  const errors = [];
  for (const a of attempts) {
    try {
      const out = await a.run();
      const buf = out?.buf;
      if (!buf?.length) throw new Error("empty_buffer");
      res.statusCode = 200;
      res.setHeader("Content-Type", out.contentType || "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Spry-Voice", a.voiceLabel);
      res.setHeader("X-Spry-Voice-Speed", String(SPEECH_SPEED));
      res.setHeader("X-Spry-TTS-Model", a.name);
      return res.end(buf);
    } catch (e) {
      errors.push(String(e?.message || e));
    }
  }

  return json(res, 502, {
    error: "Spry voice is unavailable right now.",
    detail: errors[errors.length - 1] || "tts_failed",
  });
}
