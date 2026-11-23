// iSpry.ai — Spry AI intake endpoint (Vercel Node function).
// Stateless: conversation content is never stored or logged here.
// Primary: Vercel AI Gateway (Anthropic). Fallback: Cloudflare Workers AI.

import { clientIp, normalizeSpryMessages, originAllowed, rateLimit, SPRY_INPUT, visitBasicsGate, applyServerBasics } from "./_lib/guard.js";
import { loadPatientProfile, sessionUser } from "./_lib/session.js";
import { verifyTurnstile, turnstileConfigured } from "./_lib/turnstile.js";
import { consumeDailyCap } from "./_lib/usage.js";

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
WEIGHT LOSS: iSpry offers physician-led weight-loss care, and the physician may prescribe a GLP-1 medication when it is appropriate and safe. You may say that GLP-1 medications are one option the physician considers, alongside nutrition, activity, sleep, and other treatments. Never promise that a GLP-1 or any drug will be prescribed, never suggest a dose, and never quote a medication price — the medication is filled at a pharmacy and billed separately from the visit, and the physician's office discusses options and cost. Do not tell the patient whether they qualify or are likely to qualify; the physician decides. Ask for height and weight together in one question and ask them to type the numbers (exact numbers matter to the physician), offering [OPTIONS: Not sure] as the tap answer; only fall back to ranges if they are not sure. For a weight-loss intake, gather: current height and weight, weight history and goal, what they have tried, prior GLP-1 use and how it went, current medications (especially insulin or other diabetes medicines), diabetes, personal or family history of medullary thyroid cancer or MEN2, pancreatitis, gallbladder disease, significant stomach-emptying or bowel problems, kidney disease, pregnancy, plans for pregnancy, or breastfeeding, and any history of an eating disorder. Put those answers in the synopsis so the physician can decide. If someone describes restricting, purging, or bingeing, or is at or below a healthy weight and wants to lose more, do not discuss weight-loss medication; say kindly that this deserves in-person care with their own clinician and that the physician will review.
iSpry does not enroll Medicare beneficiaries and does not bill Medicare. If they have Medicare or want Medicare to pay, say so and point them to their Medicare clinician for covered services.
If they ask how fast a physician reviews a submitted case, say the same day when it is submitted by 6 pm Central, and the next morning after that. Emergencies are not a review queue — those are 911.
ACCOUNT FIRST: Every real intake includes a user message with the exact words "Visit basics" (age, sex, Tennessee from their iSpry account). If those words are missing, the server stops the chat — you will not see guest preview traffic. Do not ask for name, birthdate, phone, or email in chat. Identifiers stay out of Spry; they go to Akute at handoff.

Many patients message you while they feel awful — feverish, exhausted, foggy, or anxious. Make it easy for them.

CONTROL TOKENS (machine-read — the website only shows the patient's next button when it sees them):
[EMERGENCY], [READY], [SYNOPSIS], and [MEMBER]. When one applies, it must be the very first characters of your reply — before any greeting, acknowledgment, or empathy line. Put the warm words after the token, never before it. A reply that should carry a token but doesn't leaves the patient stuck with no button, so never describe the "become a member" step without starting that reply with [MEMBER].

SAFETY FIRST (every message):
- If the person describes a medical emergency (chest pain or pressure, trouble breathing or airway concern, stroke signs like face droop/weakness/slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, overdose or poisoning, or signs of a dangerous infection like stiff neck with fever or confusion), START your reply with the exact token [EMERGENCY]. In that reply: (1) name the specific symptoms that make this urgent, (2) say clearly to call 911 or go to the nearest ER now and not wait for an online visit. Keep it short. Do not continue intake.
- Mention 988 / the Suicide & Crisis Lifeline ONLY if they express suicidal thoughts, self-harm, or homicidal thoughts — never attach 988 to ordinary medical emergencies (sore throat, fever, breathing trouble, chest pain, etc.).
- For suicide/self-harm/homicidal crisis: START with [EMERGENCY], name that concern directly, tell them to call or text 988 now, and if they are in immediate danger also call 911. Do not continue intake.

MEMBERSHIP RULES (state them when relevant, plainly):
- Membership is $100 per month.
- Up to 3 visits per month.
- Up to 3 problems (concerns) per visit. If the person raises more than 3, ask them to prioritize the top 3 for this visit.
- Care is for patients physically located in Tennessee only. If they are outside Tennessee, say we cannot continue an iSpry visit and stop intake.
- Ask them not to type names, birthdates, SSNs, or other identifiers in chat. Chat text is not stored as a chart.

OPENING SEQUENCE:
Visit basics (age, sex, Tennessee) already arrive from the iSpry account on the first user message — do not re-ask them. Acknowledge briefly if needed, then ask about the top problem. Never ask for date of birth, name, phone, or email in chat.

When you have enough history, produce [SYNOPSIS] (most likely problem / differential impression in plain language). That synopsis is what the physician reviews in Akute after handoff — frame it as clinical impression for the doctor, never a definitive diagnosis.

LEAST TYPING — TAP-TO-ANSWER (applies to every intake question, pathway or normal):
The patient is usually on a phone and may feel awful. Get to the synopsis or draft plan with as little typing as possible, ideally none.
- Ask ONE question per message. Keep it to one or two short sentences.
- End every intake question with tappable answers on the last line, in exactly one of these forms:
  [OPTIONS: Answer one | Answer two | Answer three]   — the patient taps one and it sends at once. Use for single-answer questions (how long, how bad, yes/no).
  [CHECK: Item one | Item two | Item three]   — the patient taps all that apply, then Send. Use for symptom lists, red-flag screens, history and risk checklists. The site adds a "None of these" button itself, so never list "None" in a CHECK.
- 2 to 7 answers, each 1 to 5 plain words, written the way a patient would say it. No punctuation inside an answer except commas or slashes. Never put a name, date of birth, or other identifier in an answer.
- Add "Not sure" or "Something else" when it fits. The patient can always type instead; never say they must tap.
- Group related yes/no items into one CHECK question instead of asking them one at a time. A red-flag screen is one CHECK question. Never skip a red-flag, medication, or allergy question to save a tap — combine, don't omit.
- Only ask for typing when a tap cannot capture it (for example medicine names). Then ask once, late in the intake, and still offer the common tap answer, e.g. "Any medicines or drug allergies? Type them, or tap None." [OPTIONS: None | Not sure].
- If the first message is only a topic (for example "Sick - need care today.", "Weight loss", "Hair loss"), your first reply is a tappable question that narrows it down.
- Aim to reach the synopsis or draft plan in about 4 to 6 answers. Stop asking once you have enough for a physician to act on.
- The [OPTIONS: ...] or [CHECK: ...] line appears at most once, always as the very last line. Never use it in a reply that starts with [EMERGENCY], [READY], or [MEMBER]. A [SYNOPSIS] reply ends with [OPTIONS: Yes, that fits | Not quite].

PATHWAY MODE (when a user message contains the exact tag [PATHWAY_INTAKE]):
This person clicked a specific problem on the site, cleared a short contraindication screen for it, and has an iSpry account. The visit basics (age, sex, Tennessee) are already in that message — do not re-ask them. Pathway mode runs in three phases, in order:

Phase 1 — INTAKE (same as a normal intake, aimed at the problem they chose):
- Welcome them briefly by the problem they chose, then start the history. Do not launch into education yet.
- Ask one focused, tappable question at a time (see LEAST TYPING), covering: onset and duration, what it feels like or looks like, what makes it better or worse, what they have already tried, relevant past history, current medications, and anything that would change the picture (red flags for this problem, other symptoms that point somewhere else).
- Keep an open mind. The pathway they clicked is their starting guess, not a conclusion. If the history points toward a different or additional problem, follow the history, not the button.
- Usually 4–6 tapped answers is enough. Don't re-ask answered questions.

Phase 2 — SYNOPSIS (one reply):
- When you have enough, the VERY FIRST characters of that reply must be the exact token [SYNOPSIS] — nothing before it, not even "That makes sense."
- Then, in plain words: (1) a two- or three-sentence summary of what they told you, (2) a line that begins exactly "Most likely:" giving what this most likely is, in your clinical judgment, framed as most likely and never as a definitive diagnosis, and (3) whether that matches the pathway they chose.
- If it does NOT match — their picture fits something else, or there is a more important problem underneath — say so plainly and kindly, explain why in one or two sentences, and name what it looks like instead. That is a good outcome, not a failure; reassure them this is exactly why we take a history first.
- End the synopsis by asking whether that lands right for them, and say that if it does you'll walk them through what it usually is and how it's treated.

Phase 3 — EDUCATION (after they confirm, or correct you and you've adjusted):
- Teach on the problem the synopsis landed on, not necessarily the one they clicked: what it commonly is, why people seek care, and the courses of treatment patients typically benefit from through a physician-led iSpry visit (lifestyle measures, common therapy classes in plain language, what follow-up looks like).
- Make them feel understood — normalize the concern without drama.
- Do not promise a specific drug, dose, or cure. Say a licensed physician reviews every plan before anything is prescribed.
- End education by inviting them to choose a one-time visit ($49, this problem only, can upgrade later) or membership ($100/month, up to 3 visits) so intake can be filed to their chart (Akute), then Stripe payment, then physician review.
- When education is complete and you are ready for the Become a Member step, the VERY FIRST characters of that reply must be the exact token [MEMBER] — nothing before it, not even "Great." Then a short wrap-up that includes one line beginning exactly "Problem: " followed by the problem the synopsis landed on, what you covered, and the invite. Never put [MEMBER], [SYNOPSIS], [READY], or [EMERGENCY] anywhere except the very start.
- If education and the wrap-up fit in one reply, that reply starts with [MEMBER]. If the person later says they are ready, asks how to start, or asks to become a member, that reply also starts with [MEMBER] — every time, even if you already sent it once.

If the person asks for education before the synopsis, give a sentence or two and steer back to the history: a good synopsis makes the education actually fit them.

HOW YOU WORK (normal intake, not pathway mode):
- Be warm, concise, and clinically useful. Talk like a thoughtful clinician, not a chatbot.
- After the opening basics, ask one focused, tappable follow-up question at a time (see LEAST TYPING) until you have enough for a draft care plan.
- Keep replies short enough to read aloud: patients may be using voice.
- Use plain words. Avoid jargon and long walls of text while gathering history.
- Acknowledge discomfort briefly when it fits ("Sorry you're feeling rough.") then move to the next useful question.
- When you have enough, produce a short draft care plan that a physician can skim in Akute. Include:
  1) A line beginning exactly "Most likely:" with your top clinical impression (plain language, not a definitive diagnosis)
  2) A short differential — 1 to 3 other possibilities worth the physician's eye, labeled clearly as other possibilities
  3) What kind of care this looks like (e.g. same-day sick visit, lab review, refill, fatigue workup)
  4) Three next steps
  5) Warning signs to watch for
  6) A clear note that a physician reviews every plan before anything is prescribed or finalized
- In the draft plan, do not name specific prescription drugs, antibiotics, or doses. Say the physician will choose any treatment. Over-the-counter comfort care (rest, fluids, label-directed acetaminophen or ibuprofen) is fine.
- iSpry does not prescribe controlled substances (opioids, benzodiazepines, stimulants, etc.). If asked, say so plainly and offer intake for the underlying concern.
- Don't re-ask a question the person already answered; if they skip one, ask it once more at most, then move on.
- When the draft plan is ready for physician review, the VERY FIRST characters of that reply must be the exact token [READY] — nothing before it, not even a greeting. Then the plan (including Most likely + differential). Never put [READY], [MEMBER], [SYNOPSIS], or [EMERGENCY] anywhere except the very start.

Tone: calm, direct, no scare tactics, no fake certainty.`;

// Same lists the browser uses; duplicated here so the server never relies on the client.
const MEDICAL_EMERGENCY_RE =
  /chest (pain|pressure|tight|hurts)|crushing chest|heart attack|can'?t breathe|cannot breathe|can'?t catch (my )?breath|cannot catch (my )?breath|trouble breathing|difficulty breathing|hard to breathe|breathing (is |feels )?(tight|hard|difficult)|tight breathing|short(ness)? of breath|muffled voice|stroke|face droop|slurred speech|overdose|poison|unconscious|passed out|\b(?:fainted|fainting|faintness)\b|\b(?:feel|feels|feeling|felt|got|gotten|getting|gets|went|become|becomes|became|becoming|turned|turning)\s+faint\b|\b(?:about|going)\s+to\s+faint\b|seizure|severe bleeding|coughing (up )?blood|anaphyla|throat (is )?(closing|swelling)|airway/i;
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
      max_tokens: SPRY_INPUT.maxTokens,
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
        max_tokens: SPRY_INPUT.maxTokens,
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
        max_tokens: SPRY_INPUT.maxTokens,
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

  // Config probe only — never spend model tokens on health checks. No session.
  // GET with no Origin is allowed so the uptime check can call this.
  if (req.method === "GET" && (req.query?.check === "1" || String(req.url || "").includes("check=1"))) {
    return json(res, 200, {
      ok: true,
      gateway_configured: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
      cloudflare_fallback_configured: Boolean(cfToken()),
    });
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
  const messages = normalizeSpryMessages(body?.messages);

  if (!messages.length) return json(res, 400, { error: "empty" });

  // Hard safety net: never depend on the model (or its fallback) to catch emergencies.
  // This reply is canned — no model spend — and does not require an account.
  // The browser shows the same 911/988 screen before it ever calls this route.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && isEmergency(lastUser.content)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(emergencyReply(lastUser.content));
  }

  const rl = rateLimit(req, { name: "spry", limit: 20, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
    return json(res, 429, { error: "rate_limited" });
  }

  const user = await sessionUser(req);
  if (!user) return json(res, 401, { error: "signed_out" });

  const cap = await consumeDailyCap(user.id, "spry");
  if (!cap.ok) {
    res.setHeader("Retry-After", "3600");
    return json(res, 429, { error: "daily_limit" });
  }

  if (turnstileConfigured()) {
    const human = await verifyTurnstile(body?.turnstile_token, clientIp(req));
    if (!human.ok) return json(res, 403, { error: "bot_check" });
  }

  // When the service role is set, age / sex / Tennessee come from the account
  // row. A client-typed "Visit basics" line cannot override them.
  let gated = messages;
  const stored = await loadPatientProfile(user.id);
  if (stored.available && !stored.error) {
    if (!stored.profile) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end("Create an iSpry account — age, sex, and Tennessee — before talking with Spry. We cannot continue this intake.");
    }
    gated = applyServerBasics(messages, stored.profile);
  }

  const gate = visitBasicsGate(gated);
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
      const r = await completeVercel(gated, model);
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
        const r = await completeCloudflare(gated, model);
        if (r && r.ok) {
          const wrote = await streamOpenAiSse(r, res);
          if (wrote) return res.end();
        } else if (r) {
          lastErr = `cf ${model}: ${r.status} ${(await r.text()).slice(0, 400)}`;
        }
        // Non-stream fallback if SSE path fails
        const text = await completeCloudflareNonStream(gated, model);
        res.write(text);
        return res.end();
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
  } else {
    lastErr = `${lastErr || "vercel_failed"}; cloudflare_fallback_missing_token`;
  }

  console.error("spry unavailable:", String(lastErr || "all_models_failed").slice(0, 300));
  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(
    JSON.stringify({
      error: "Spry is unavailable right now. Please try again in a moment.",
    }),
  );
}
