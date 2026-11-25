#!/usr/bin/env node
/**
 * Capture real iSpry pages and cut them to the narration in
 * scripts/intro-narration.txt (timings from scripts/intro_tts.py).
 *
 * Serves public/ on 127.0.0.1 only. Every /api/spry, /api/speak, and
 * /api/handoff call is mocked or blocked. No account is created.
 * The chat uses a fictional Alex Example / alex@example.com and a
 * generic sore throat. No birthdate is entered.
 *
 * Run via scripts/build-intro-video.sh
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const TOOLS = process.env.ISPRY_TOOLS || "/tmp/ispry-tools";
const { chromium } = createRequire(path.join(TOOLS, "package.json"))("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const WORK = process.env.ISPRY_INTRO_WORK || "/tmp/ispry-intro-build";
const AUDIO = path.join(WORK, "audio");
const PLATES = path.join(WORK, "plates");
const SEGS = path.join(WORK, "segs");
const FONT_DIR = process.env.ISPRY_FONT_DIR || "/tmp/ispry-intro/fonts";
const FONT_SANS = path.join(FONT_DIR, "IBMPlexSans-SemiBold.ttf");
const FONT_MONO = path.join(FONT_DIR, "IBMPlexMono-Medium.ttf");

const VIEW_W = 1280;
const VIEW_H = 720;
const SCALE = 2;
const FPS = 30;
const OUT_W = 1280;
const OUT_H = 720;

const DEMO = {
  first_name: "Alex",
  last_name: "Example",
  email: "alex@example.com",
  age: 34,
  sex: "female",
  in_tennessee: true,
};

const REPLIES = {
  open: "Sorry you're feeling rough. How long has the sore throat been going on?\n[OPTIONS: Since today | A couple of days | Over a week]",
  days: "Any of these along with it?\n[CHECK: Fever | Pain when swallowing | Rash | Stiff neck]",
  synopsis: [
    "[SYNOPSIS]",
    "A sore throat for a couple of days, plus a fever.",
    "",
    "Most likely: a viral sore throat.",
    "",
    "Other possibilities: strep throat, or irritation from a cold.",
    "",
    "A physician reviews this before any treatment. This is not a diagnosis, and Spry does not prescribe.",
    "[OPTIONS: Yes, that fits | Not quite]",
  ].join("\n"),
  ready: [
    "[READY]",
    "Most likely: a viral sore throat.",
    "Other possibilities: strep throat, or irritation from a cold.",
    "A physician reviews every plan before anything is prescribed.",
  ].join("\n"),
};

let authConfigured = true;

function contentType(file) {
  const ext = path.extname(file);
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webp": "image/webp",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".xml": "application/xml",
      ".txt": "text/plain; charset=utf-8",
      ".vtt": "text/vtt; charset=utf-8",
    }[ext] || "application/octet-stream"
  );
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.normalize(path.join(PUBLIC, pathname));
      if (!file.startsWith(PUBLIC)) {
        res.writeHead(403);
        res.end("no");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

function spryReply(route) {
  let messages = [];
  try {
    messages = JSON.parse(route.request().postData() || "{}").messages || [];
  } catch {
    messages = [];
  }
  const last = [...messages].reverse().find((m) => m && m.role === "user");
  const text = String(last?.content || "");
  const tail = text.split("\n").pop();
  let body = REPLIES.open;
  if (/Yes, that fits/i.test(tail)) body = REPLIES.ready;
  else if (/^Fever\b/i.test(tail)) body = REPLIES.synopsis;
  else if (/A couple of days/i.test(tail)) body = REPLIES.days;
  else if (/sore throat/i.test(text)) body = REPLIES.open;
  return route.fulfill({
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body,
  });
}

async function installRoutes(page) {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    let pathname = "";
    try {
      const u = new URL(url);
      host = u.hostname;
      pathname = u.pathname;
    } catch {
      return route.abort();
    }
    if (host === "127.0.0.1" || host === "localhost") {
      if (pathname === "/api/spry") return spryReply(route);
      if (pathname === "/api/speak" || pathname === "/api/handoff") {
        console.error("blocked", pathname);
        return route.abort();
      }
      if (pathname === "/api/auth-config") {
        return json(route, {
          configured: authConfigured,
          supabase_url: "https://demo.supabase.co",
          anon_key: "demo-anon-key",
          auth_mode: "password",
          turnstile_site_key: "",
        });
      }
      if (pathname === "/api/checkout") {
        return json(route, {
          configured: true,
          processor: "stripe",
          signup_url: "https://buy.stripe.com/demo",
          portal_url: "https://billing.stripe.com/p/login/demo",
          visit_url: "https://buy.stripe.com/demo-visit",
          visit_price_usd: 49,
        });
      }
      if (pathname === "/api/bot-check") return json(route, { ok: true, skipped: true });
      if (pathname.startsWith("/api/")) return route.abort();
      return route.continue();
    }
    if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com" || host === "cdn.jsdelivr.net") {
      return route.continue();
    }
    return route.abort();
  });
}

function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    child.stderr.on("data", (b) => {
      err += b.toString();
    });
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} ${args.join(" ")}\n${err.slice(-2000)}`));
        return;
      }
      resolve({ code, out, err });
    });
  });
}

async function probeSize(file) {
  const { out } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    file,
  ]);
  const [w, h] = out.trim().split(",").map(Number);
  return { w, h };
}

async function shot(page, name) {
  const file = path.join(PLATES, `${name}.png`);
  await page.screenshot({ path: file, type: "png" });
  const size = await probeSize(file);
  console.log("plate", name, `${size.w}x${size.h}`);
  return { file, ...size, name };
}

async function settle(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
    document.documentElement.style.scrollBehavior = "auto";
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function gotoHome(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("h1.brand-hero");
  await page.waitForFunction(() => {
    const hero = document.querySelector("h1.brand-hero");
    if (!hero) return false;
    return parseFloat(getComputedStyle(hero).opacity) > 0.95;
  });
  await settle(page);
}

function btsCss() {
  return `
    #btsScrim{position:fixed;inset:0;z-index:86;background:rgba(7,8,12,.42)}
    #bts{position:fixed;z-index:90;left:50%;top:50%;transform:translate(-50%,-50%);
      width:min(520px,86vw);background:#12161F;color:#F4F2EB;border:1px solid #232938;
      border-radius:28px;padding:26px 26px 20px;box-shadow:0 16px 48px rgba(0,0,0,.45);
      font-family:"IBM Plex Sans",system-ui,sans-serif}
    #bts.dock{top:auto;bottom:118px;width:min(760px,94vw);transform:translateX(-50%)}
    #bts .k{margin:0 0 8px;font:500 12px/1 "IBM Plex Mono",ui-monospace,monospace;
      letter-spacing:.14em;text-transform:uppercase;color:#D7FF3F}
    #bts h3{margin:0 0 12px;font:800 30px/1.05 "Bricolage Grotesque",system-ui,sans-serif;
      letter-spacing:-.03em}
    #bts p{margin:0 0 8px;font-size:16px;line-height:1.4;color:#C9CEDA}
    #bts ul{list-style:none;margin:8px 0 0;padding:0}
    #bts li{display:flex;justify-content:space-between;gap:16px;padding:8px 0;
      border-top:1px solid #232938;font-size:16px;color:#F4F2EB}
    #bts li span{color:#D7FF3F;font-variant-numeric:tabular-nums}
    #btsBanner{position:sticky;top:0;z-index:5;margin:0 0 12px;padding:10px 14px;border-radius:14px;
      background:#12161F;border:1px solid #232938;color:#C9CEDA;font:15px/1.4 "IBM Plex Sans",system-ui,sans-serif}
    #btsBanner b{color:#D7FF3F;font-weight:600}
    #endCard{position:fixed;inset:0;z-index:200;background:#07080C;display:flex;flex-direction:column;
      align-items:center;justify-content:center;text-align:center;padding:48px;gap:18px}
    #endCard .k{margin:0;font:500 14px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.16em;
      text-transform:uppercase;color:#F4F2EB}
    #endCard .k span{color:#D7FF3F}
    #endCard h2{margin:8px 0 0;font:800 68px/1.02 "Bricolage Grotesque",system-ui,sans-serif;
      letter-spacing:-.04em;color:#F4F2EB}
    #endCard p{margin:0;font:500 32px/1.3 "IBM Plex Sans",system-ui,sans-serif;color:#F4F2EB}
    #endCard p strong{color:#FF6B5B;font-weight:600}
    #endRule{width:72px;height:3px;background:#D7FF3F;border:0;margin:0}
  `;
}

async function ensureFilm(page) {
  await page.evaluate((css) => {
    if (document.getElementById("filmCss")) return;
    const style = document.createElement("style");
    style.id = "filmCss";
    style.textContent = css;
    document.head.appendChild(style);
  }, btsCss());
}

async function showCard(page, html, place = "center") {
  await ensureFilm(page);
  await page.evaluate(({ inner, place }) => {
    document.getElementById("btsScrim")?.remove();
    document.getElementById("bts")?.remove();
    const scrim = document.createElement("div");
    scrim.id = "btsScrim";
    const card = document.createElement("div");
    card.id = "bts";
    if (place === "dock") card.className = "dock";
    card.innerHTML = inner;
    document.body.appendChild(scrim);
    document.body.appendChild(card);
  }, { inner: html, place });
}

async function hideCard(page) {
  await page.evaluate(() => {
    document.getElementById("btsScrim")?.remove();
    document.getElementById("bts")?.remove();
  });
}

async function focusThread(page) {
  await page.evaluate(() => {
    for (const sel of ["h1.brand-hero", ".ask-line", ".lede"]) {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    }
    const how = document.querySelector("#how");
    if (how) how.style.visibility = "hidden";
    const hero = document.querySelector(".hero");
    hero.style.minHeight = "0";
    hero.style.padding = "8px 0 12px";
    hero.style.justifyContent = "flex-start";
    const msgs = document.querySelector(".msgs");
    if (msgs) msgs.style.maxHeight = "500px";
  });
  await page.waitForTimeout(80);
}

async function frame(page, selector, { block = "start", hideVideo = false, height = VIEW_H } = {}) {
  await page.setViewportSize({ width: VIEW_W, height });
  await page.evaluate(
    ({ selector, block, hideVideo }) => {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      if (hideVideo) {
        const video = document.querySelector(".intro-video");
        if (video) video.style.display = "none";
      }
      const el = document.querySelector(selector);
      if (el) el.scrollIntoView({ block, inline: "nearest" });
    },
    { selector, block, hideVideo },
  );
  await page.waitForTimeout(150);
}

const TURNSTILE_CARD = `
  <p class="k">Behind the scenes</p>
  <h3>An invisible person check.</h3>
  <p>Cloudflare Turnstile runs only when it is switched on. There is no puzzle on screen.</p>
  <p>It confirms a person is here. Supabase Auth then creates the account with email and password.</p>
  <p>This is not membership, and nothing is charged.</p>
`;

const CAPS_CARD = `
  <p class="k">Behind the scenes</p>
  <h3>Daily limits, per account.</h3>
  <p>Counted on the Central-time day, so Spry stays available.</p>
  <ul>
    <li>Questions to Spry <span>40</span></li>
    <li>Spry speaking aloud <span>80</span></li>
    <li>Sending a chart <span>6</span></li>
  </ul>
  <p>Reach one, and the site tells you. An emergency is still 911.</p>
`;

async function capture(page, origin) {
  await mkdir(PLATES, { recursive: true });
  const plates = {};

  await gotoHome(page, origin);
  plates.open = await shot(page, "open");

  await page.waitForFunction(() => window.IspryAccount);
  let noteOk = false;
  for (let i = 0; i < 25 && !noteOk; i++) {
    await page.evaluate(() => window.IspryAccount.open({ mode: "create" }));
    noteOk = await page.evaluate(() =>
      /password signs you in/i.test(document.getElementById("acctNote")?.textContent || ""),
    );
    if (!noteOk) await page.waitForTimeout(200);
  }
  if (!noteOk) throw new Error("Account form never showed the Supabase sign-in note");
  await page.waitForSelector("text=Start your iSpry account");
  await page.evaluate(() => {
    const card = document.querySelector(".acct-card");
    card.style.maxHeight = "none";
    card.style.overflow = "visible";
    const modal = document.querySelector(".acct-modal");
    modal.style.alignItems = "flex-start";
    modal.style.paddingTop = "12px";
    document.documentElement.style.zoom = "1";
    const needed = card.getBoundingClientRect().height + 36;
    const z = Math.min(0.9, (window.innerHeight - 130) / needed);
    document.documentElement.style.zoom = String(Math.max(0.58, z));
  });
  await page.waitForTimeout(100);
  plates.accountEmpty = await shot(page, "account-empty");

  await page.locator('input[name="first_name"]').fill(DEMO.first_name);
  await page.locator('input[name="last_name"]').fill(DEMO.last_name);
  await page.locator('#acctForm input[name="email"]').fill(DEMO.email);
  // Masked placeholder only. The form is never submitted, and this is not a credential.
  await page.locator('input[name="password"]').fill("not-a-real-password");
  await page.locator('input[name="password_confirm"]').fill("not-a-real-password");
  await page.locator('input[name="age"]').fill(String(DEMO.age));
  await page.locator('select[name="sex"]').selectOption(DEMO.sex);
  await page.locator('select[name="in_tennessee"]').selectOption("yes");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  plates.accountFilled = await shot(page, "account-filled");

  await showCard(page, TURNSTILE_CARD, "dock");
  plates.turnstile = await shot(page, "turnstile");
  await hideCard(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
    window.IspryAccount.close();
  });

  authConfigured = false;
  await page.evaluate((demo) => {
    localStorage.setItem("ispry_account_v1", JSON.stringify(demo));
    localStorage.setItem("spry_voice", "0");
  }, DEMO);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const name = document.getElementById("acctChipName");
    return name && name.textContent === "Alex";
  });
  await page.evaluate(() => {
    window.IspryAccount.accessToken = async () => "demo-local-only";
    window.IspryAccount.turnstileEnabled = () => false;
  });
  await settle(page);

  await focusThread(page);
  await page.locator("#qIdle").fill("Sore throat since yesterday.");
  plates.chatType = await shot(page, "chat-type");
  await page.locator("#sendIdle").click();
  await page.waitForSelector(".qbtn", { timeout: 15000 });
  plates.chatQ = await shot(page, "chat-q");
  await page.getByRole("button", { name: "A couple of days", exact: true }).click();
  await page.waitForSelector("text=Tap all that apply");
  await focusThread(page);
  await page.evaluate(() => document.querySelector(".quick")?.scrollIntoView({ block: "center" }));
  plates.chatCheck = await shot(page, "chat-check");

  await showCard(page, CAPS_CARD);
  plates.caps = await shot(page, "caps");
  await hideCard(page);

  await page.getByRole("button", { name: "Fever", exact: true }).click();
  await page.locator(".qbtn.qsend").click();
  await page.waitForSelector("text=Most likely:");
  await focusThread(page);
  await page.evaluate(() => {
    const msgs = document.getElementById("msgs");
    const tag = [...msgs.querySelectorAll(".mono")].find((el) => /synopsis/i.test(el.textContent));
    tag?.scrollIntoView({ block: "start" });
  });
  plates.synopsis = await shot(page, "synopsis");

  await page.getByRole("button", { name: "Yes, that fits", exact: true }).click();
  await page.waitForSelector("#payVisitBtn");
  await page.locator("#payVisitBtn").click();
  await page.waitForSelector(".handoff");
  await page.evaluate(() => {
    document.querySelector("header.top").style.position = "relative";
    const how = document.querySelector("#how");
    if (how) how.style.visibility = "hidden";
    const hero = document.querySelector(".hero");
    hero.style.minHeight = "0";
    hero.style.justifyContent = "flex-start";
    hero.style.paddingTop = "16px";
    const msgs = document.querySelector(".msgs");
    msgs.style.maxHeight = "none";
    const form = document.querySelector(".handoff");
    const banner = document.createElement("div");
    banner.id = "btsBanner";
    banner.innerHTML = "<b>Behind the scenes.</b> The synopsis is filed to the chart in Akute, for Dr. Merrick. Stripe then charges the visit or membership. The symptom is not sent to Stripe.";
    form.prepend(banner);
  });
  await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  await page.evaluate(() => {
    const btn = document.querySelector(".handoff button[type=submit]");
    const y = btn.getBoundingClientRect().top + window.scrollY - (window.innerHeight - 200);
    window.scrollTo(0, Math.max(0, y));
  });
  await page.waitForTimeout(150);
  plates.chart = await shot(page, "chart");

  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await frame(page, "#pricing", { block: "start", height: 1680 });
  plates.price = await shot(page, "price");

  await frame(page, "#doctor", { block: "center", height: VIEW_H });
  await page.waitForFunction(() => {
    const img = document.querySelector("#doctor img");
    return img && img.complete && img.naturalWidth > 0;
  });
  plates.doctor = await shot(page, "doctor");

  await page.evaluate(() => {
    const how = document.querySelector("#how");
    if (how) how.style.visibility = "";
  });
  await frame(page, "#how .head-row", { block: "start", hideVideo: true, height: VIEW_H });
  plates.steps = await shot(page, "steps");

  await frame(page, "#limits", { block: "start", height: 980 });
  plates.limits = await shot(page, "limits");

  await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  await page.evaluate(() => {
    document.querySelector("header.top").style.position = "relative";
    document.documentElement.style.scrollPaddingTop = "0px";
    document.querySelector("#doctor").style.display = "none";
    document.querySelector("#faq").style.display = "none";
    const head = document.querySelector("#limits .step-t");
    const y = head.getBoundingClientRect().top + window.scrollY + 48;
    window.scrollTo(0, Math.max(0, y));
  });
  await page.waitForTimeout(100);
  plates.footer = await shot(page, "footer");

  await ensureFilm(page);
  await page.evaluate(() => {
    const card = document.createElement("div");
    card.id = "endCard";
    card.innerHTML = '<p class="k">iSpry<span>.ai</span></p><hr id="endRule"><h2>Start with Ask Spry.</h2><p>In an emergency, call <strong>911</strong>.</p>';
    document.body.appendChild(card);
  });
  await page.waitForTimeout(200);
  plates.end = await shot(page, "end");

  return plates;
}

function captionFilter(scene, textFile, kickerFile) {
  // Keep the picture full width, then give captions their own band so they
  // never sit on a button or a card. The end card is the caption.
  if (scene.id === "end") return "";
  const band = "crop=1280:624:0:0,pad=1280:720:0:0:0x07080C,drawbox=x=0:y=624:w=1280:h=3:color=0xD7FF3F:t=fill";
  return [
    band,
    `drawtext=fontfile=${FONT_MONO}:textfile=${kickerFile}:fontsize=15:fontcolor=0xD7FF3F:x=36:y=640`,
    `drawtext=fontfile=${FONT_SANS}:textfile=${textFile}:fontsize=30:fontcolor=0xF4F2EB:x=36:y=668`,
  ].join(",");
}

async function encodeSegment(plate, frames, motion, scene, outFile) {
  const textFile = path.join(SEGS, `${path.basename(outFile)}.cap.txt`);
  const kickerFile = path.join(SEGS, `${path.basename(outFile)}.kick.txt`);
  await writeFile(textFile, scene.caption || "");
  await writeFile(kickerFile, (scene.kicker || "").toUpperCase());
  const dur = frames / FPS;
  const winW = OUT_W * SCALE;
  const winH = OUT_H * SCALE;
  let geometry;
  if (motion === "pan" && plate.h > winH + 4) {
    geometry = [
      `crop=${winW}:${winH}:0:'(in_h-${winH})*(0.5-0.5*cos(PI*t/${dur.toFixed(3)}))'`,
      `scale=${OUT_W}:${OUT_H}:flags=lanczos`,
      `fps=${FPS}`,
    ].join(",");
  } else {
    const zoom = motion === "hold" ? 0.035 : 0.07;
    const start = motion === "hold" ? 1.015 : 1;
    geometry = `zoompan=z='${start}+${zoom}*on/${Math.max(1, frames - 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${OUT_W}x${OUT_H}:fps=${FPS}`;
  }
  const cap = captionFilter(scene, textFile, kickerFile);
  const vf = [geometry, cap, "format=yuv420p"].filter(Boolean).join(",");
  const loop = motion === "pan" && plate.h > OUT_H * SCALE + 4;
  const args = [
    "-y",
    ...(loop ? ["-loop", "1"] : []),
    "-i", plate.file,
    "-vf", vf,
    "-frames:v", String(frames),
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "16",
    "-pix_fmt", "yuv420p",
    "-an",
    outFile,
  ];
  await run("ffmpeg", args);
}

function splitFrames(duration, weights) {
  const target = Math.max(weights.length * 8, Math.round(duration * FPS));
  const sum = weights.reduce((a, b) => a + b, 0);
  const frames = weights.map((w) => Math.max(8, Math.round((target * w) / sum)));
  const drift = target - frames.reduce((a, b) => a + b, 0);
  frames[frames.length - 1] += drift;
  return frames;
}

async function buildVideo(manifest, plates) {
  await mkdir(SEGS, { recursive: true });
  const plan = {
    open: [{ plate: plates.open, motion: "push", weight: 1 }],
    account: [
      { plate: plates.accountEmpty, motion: "hold", weight: 0.7 },
      { plate: plates.accountFilled, motion: "push", weight: 1.3 },
    ],
    turnstile: [{ plate: plates.turnstile, motion: "hold", weight: 1 }],
    spry: [
      { plate: plates.chatType, motion: "hold", weight: 1 },
      { plate: plates.chatQ, motion: "push", weight: 1.15 },
      { plate: plates.chatCheck, motion: "push", weight: 1.15 },
    ],
    caps: [{ plate: plates.caps, motion: "hold", weight: 1 }],
    synopsis: [{ plate: plates.synopsis, motion: "push", weight: 1 }],
    chart: [{ plate: plates.chart, motion: "push", weight: 1 }],
    price: [{ plate: plates.price, motion: "pan", weight: 1 }],
    review: [{ plate: plates.doctor, motion: "push", weight: 1 }],
    pharmacy: [
      { plate: plates.steps, motion: "hold", weight: 1 },
      { plate: plates.limits, motion: "pan", weight: 1.15 },
      { plate: plates.footer, motion: "hold", weight: 0.7 },
    ],
    end: [{ plate: plates.end, motion: "hold", weight: 1 }],
  };

  const list = [];
  let index = 0;
  for (const scene of manifest.scenes) {
    const pieces = plan[scene.id];
    if (!pieces) throw new Error(`No visuals for scene ${scene.id}`);
    const frames = splitFrames(scene.duration, pieces.map((p) => p.weight));
    for (let i = 0; i < pieces.length; i++) {
      const out = path.join(SEGS, `seg-${String(index).padStart(2, "0")}.mp4`);
      console.log("encode", scene.id, pieces[i].plate.name, frames[i]);
      await encodeSegment(pieces[i].plate, frames[i], pieces[i].motion, scene, out);
      list.push(out);
      index += 1;
    }
  }
  const listFile = path.join(SEGS, "list.txt");
  await writeFile(listFile, list.map((f) => `file '${f}'`).join("\n") + "\n");
  const silent = path.join(WORK, "silent.mp4");
  await run("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c", "copy", "-movflags", "+faststart", silent,
  ]);
  return silent;
}

async function mixAudio() {
  const voice = path.join(AUDIO, "voice.wav");
  const music = path.join(AUDIO, "music.wav");
  const mixed = path.join(AUDIO, "mixed.wav");
  await run("ffmpeg", [
    "-y", "-i", voice, "-i", music,
    "-filter_complex",
    "[0:a]highpass=f=70[v];[1:a]lowpass=f=480,volume=0.055[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    mixed,
  ]);
  const pass = await run("ffmpeg", [
    "-i", mixed,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ]);
  const match = pass.err.match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error("loudnorm did not print measurements");
  const measured = JSON.parse(match[0]);
  const norm = path.join(AUDIO, "norm.wav");
  await run("ffmpeg", [
    "-y", "-i", mixed,
    "-af",
    `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
    norm,
  ]);
  return norm;
}

async function mux(silent, audio, crf) {
  const out = path.join(WORK, "cut.mp4");
  await run("ffmpeg", [
    "-y", "-i", silent, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "96k", "-ac", "1",
    "-shortest",
    out,
  ]);
  return out;
}

async function encodeWebm(mp4) {
  const out = path.join(PUBLIC, "media", "how-ispry-works.webm");
  await run("ffmpeg", [
    "-y", "-i", mp4,
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40",
    "-row-mt", "1", "-cpu-used", "4", "-deadline", "good",
    "-c:a", "libopus", "-b:a", "64k", "-ac", "1",
    out,
  ]);
  return out;
}

async function posterAndSheet(mp4) {
  const poster = path.join(PUBLIC, "media", "how-ispry-works-poster.png");
  await run("ffmpeg", ["-y", "-ss", "1.15", "-i", mp4, "-frames:v", "1", poster]);
  const { out } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4,
  ]);
  const dur = Number(out.trim());
  const framesDir = path.join(WORK, "sheet");
  await mkdir(framesDir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const t = (dur * (i + 0.5)) / 12;
    await run("ffmpeg", [
      "-y", "-ss", t.toFixed(3), "-i", mp4,
      "-frames:v", "1",
      "-vf",
      `drawtext=fontfile=${FONT_MONO}:text='${formatClock(t)}':fontsize=18:fontcolor=0x07080C:box=1:boxcolor=0xD7FF3F@0.92:boxborderw=6:x=12:y=12`,
      path.join(framesDir, `f${String(i).padStart(2, "0")}.png`),
    ]);
  }
  const sheet = path.join(WORK, "contact-sheet.png");
  await run("ffmpeg", [
    "-y", "-framerate", "1", "-i", path.join(framesDir, "f%02d.png"),
    "-vf", "scale=400:225,tile=4x3:padding=8:margin=8:color=0x07080C",
    "-frames:v", "1",
    sheet,
  ]);
  return { poster, sheet, dur };
}

function formatClock(t) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function checkFrames(mp4) {
  const probe = await run("ffmpeg", [
    "-i", mp4,
    "-vf", "blackframe=amount=99:threshold=12",
    "-an", "-f", "null", "-",
  ], { allowFail: true });
  const hits = (probe.err.match(/blackframe/g) || []).length;
  if (hits > 0) {
    console.warn(`blackframe detector flagged ${hits} frame(s)`);
  }
  const { out } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4,
  ]);
  const dur = Number(out.trim());
  let worst = Infinity;
  for (let i = 0; i < 8; i++) {
    const t = (dur * (i + 0.5)) / 8;
    const frame = path.join(WORK, `check-${i}.png`);
    await run("ffmpeg", ["-y", "-ss", t.toFixed(3), "-i", mp4, "-frames:v", "1", frame]);
    const stats = await run("ffmpeg", [
      "-i", frame, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-",
    ], { allowFail: true });
    const blob = stats.out + stats.err;
    const yavg = Number((blob.match(/lavfi.signalstats.YAVG=([0-9.]+)/) || [])[1]);
    const ydif = Number((blob.match(/lavfi.signalstats.YDIF=([0-9.]+)/) || [])[1]);
    if (!Number.isFinite(ydif)) {
      console.log(`check t=${t.toFixed(1)} no stats`);
      continue;
    }
    worst = Math.min(worst, ydif);
    console.log(`check t=${t.toFixed(1)} YAVG=${yavg} YDIF=${ydif}`);
    if (ydif < 1.5 && yavg < 4) throw new Error(`Frame at ${t.toFixed(1)}s looks blank`);
  }
  return worst;
}

async function patchHtml(seconds) {
  const file = path.join(PUBLIC, "index.html");
  let html = await readFile(file, "utf8");
  if (!html.includes("how-ispry-works.vtt")) {
    html = html.replace(
      '<source src="/media/how-ispry-works.mp4" type="video/mp4">',
      '<source src="/media/how-ispry-works.mp4" type="video/mp4">\n        <track kind="captions" src="/media/how-ispry-works.vtt" srclang="en" label="English" default>',
    );
  }
  html = html.replace(/\d+-second overview/g, `${seconds}-second overview`);
  await writeFile(file, html);
}

async function main() {
  for (const font of [FONT_SANS, FONT_MONO]) {
    if (!existsSync(font)) throw new Error(`Missing font ${font}`);
  }
  const manifest = JSON.parse(await readFile(path.join(AUDIO, "manifest.json"), "utf8"));
  console.log(`narration ${manifest.total}s`);
  if (manifest.total < 60 || manifest.total > 95) {
    console.warn(`duration ${manifest.total}s is outside 60–90; continuing`);
  }
  const { server, origin } = await startServer();
  console.log("serving", origin);
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-dev-shm-usage", "--font-render-hinting=medium"],
  });
  const context = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: SCALE,
    reducedMotion: "no-preference",
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    localStorage.setItem("spry_voice", "0");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (err) => console.warn("pageerror", err.message));
  await installRoutes(page);
  let plates;
  try {
    plates = await capture(page, origin);
  } catch (err) {
    const fail = path.join(WORK, "fail.png");
    try {
      await page.screenshot({ path: fail });
      console.error("saved", fail);
    } catch { /* page may be closed */ }
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
  if (process.env.SKIP_ENCODE === "1") {
    console.log("plates only");
    return;
  }
  const silent = await buildVideo(manifest, plates);
  const audio = await mixAudio();
  let crf = 28;
  let mp4 = "";
  const finalMp4 = path.join(PUBLIC, "media", "how-ispry-works.mp4");
  for (; crf <= 36; crf += 2) {
    mp4 = await mux(silent, audio, crf);
    const size = (await stat(mp4)).size;
    const probed = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4,
    ]);
    const got = Number(probed.out.trim());
    console.log(`mp4 crf ${crf} ${(size / 1048576).toFixed(2)} MB  ${got.toFixed(2)}s`);
    if (Math.abs(got - manifest.total) > 1.5) {
      throw new Error(`Video is ${got.toFixed(2)}s but narration is ${manifest.total}s`);
    }
    if (size < 8 * 1024 * 1024) break;
  }
  await copyFile(mp4, finalMp4);
  await copyFile(path.join(AUDIO, "captions.vtt"), path.join(PUBLIC, "media", "how-ispry-works.vtt"));
  const webm = await encodeWebm(finalMp4);
  const { poster, sheet, dur } = await posterAndSheet(finalMp4);
  const seconds = Math.round(dur);
  await patchHtml(seconds);
  await checkFrames(finalMp4);
  const mp4Size = (await stat(finalMp4)).size;
  const webmSize = (await stat(webm)).size;
  const posterSize = (await stat(poster)).size;
  console.log(JSON.stringify({
    seconds,
    mp4: mp4Size,
    webm: webmSize,
    poster: posterSize,
    sheet,
    posterPath: poster,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
