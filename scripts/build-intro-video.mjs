#!/usr/bin/env node
/**
 * Cut the homepage television spot.
 *
 * Serves public/ on 127.0.0.1. /api/spry is a fictional sore-throat reply.
 * /api/speak and /api/handoff are blocked. No account is created.
 * The chat is Alex Example, alex@example.com, age 34. No birthdate is entered.
 *
 * Picture is 1920x1080 at 30 fps. Closed captions are the VTT track only.
 * The spoken read stays at Kokoro speed 1.0 and the whole spot, end card
 * included, is 20 seconds or less.
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
const FRAMES = path.join(WORK, "frames");
const STAGE_TEMPLATE = path.join(ROOT, "scripts", "commercial-stage.html");

const FPS = 30;
const OUT_W = 1920;
const OUT_H = 1080;
const MAX_SECONDS = 20;

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
    "A physician reviews this before any treatment. Spry does not prescribe.",
    "[OPTIONS: Yes, that fits | Not quite]",
  ].join("\n"),
};

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
      ".woff2": "font/woff2",
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
      if (pathname.startsWith("/_film/")) {
        const rel = pathname.slice("/_film/".length);
        const file = path.normalize(path.join(WORK, rel));
        if (!file.startsWith(WORK)) {
          res.writeHead(403);
          res.end("no");
          return;
        }
        const body = await readFile(file);
        res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        res.end(body);
        return;
      }
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
  if (/^Fever\b/i.test(tail)) body = REPLIES.synopsis;
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
      if (pathname === "/api/speak" || pathname === "/api/handoff") return route.abort();
      if (pathname === "/api/auth-config") {
        return json(route, {
          configured: false,
          supabase_url: "",
          anon_key: "",
          auth_mode: "password",
          turnstile_site_key: "",
        });
      }
      if (pathname.startsWith("/api/")) return route.abort();
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
        reject(new Error(`${cmd} ${args.join(" ")}\n${err.slice(-2500)}`));
        return;
      }
      resolve({ code, out, err });
    });
  });
}

async function settle(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
    document.documentElement.style.scrollBehavior = "auto";
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function sanitize(page) {
  await page.evaluate(() => {
    for (const sel of [".intro-video", ".chips", ".chip-kicker", ".doc-strip", "#faq", "footer"]) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const bad = [];
    while (walker.nextNode()) {
      if (/6\s*pm|six\s*pm|older review cutoff/i.test(walker.currentNode.nodeValue || "")) {
        bad.push(walker.currentNode.parentElement);
      }
    }
    for (const el of bad) el?.remove();
  });
}

async function shot(page, name) {
  const file = path.join(PLATES, `${name}.png`);
  await page.screenshot({ path: file, type: "png" });
  console.log("plate", name);
  return file;
}

async function capture(page, origin) {
  await mkdir(PLATES, { recursive: true });

  await page.setViewportSize({ width: 1200, height: 1400 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => {
    const name = document.getElementById("acctChipName");
    return name && name.textContent === "Alex";
  });
  await page.evaluate(() => {
    window.IspryAccount.accessToken = async () => "demo-local-only";
    window.IspryAccount.turnstileEnabled = () => false;
  });
  await settle(page);
  await sanitize(page);
  await page.evaluate(() => {
    for (const sel of ["h1.brand-hero", ".ask-line", ".lede", ".hero-offer"]) {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    }
    const hero = document.querySelector(".hero");
    if (hero) {
      hero.style.minHeight = "0";
      hero.style.padding = "8px 0 12px";
      hero.style.justifyContent = "flex-start";
    }
    document.querySelector("header.top").style.position = "relative";
    const msgs = document.querySelector(".msgs");
    if (msgs) msgs.style.maxHeight = "none";
  });

  await page.locator("#qIdle").fill("Sore throat since yesterday.");
  await page.locator("#sendIdle").click();
  await page.waitForSelector(".qbtn", { timeout: 15000 });
  await page.waitForTimeout(150);
  await page.locator("#chatShell").screenshot({ path: path.join(PLATES, "chat.png"), type: "png" });
  console.log("plate chat");

  await page.getByRole("button", { name: "A couple of days", exact: true }).click();
  await page.waitForSelector("text=Tap all that apply");
  await page.getByRole("button", { name: "Fever", exact: true }).click();
  await page.locator(".qbtn.qsend").click();
  await page.waitForSelector("text=Most likely:");
  await page.evaluate(() => {
    const msgs = document.getElementById("msgs");
    const tag = [...msgs.querySelectorAll(".mono")].find((el) => /synopsis/i.test(el.textContent || ""));
    (tag || msgs).scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(150);
  await page.locator("#chatShell").screenshot({ path: path.join(PLATES, "synopsis.png"), type: "png" });
  console.log("plate synopsis");

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#pricing .price");
  await settle(page);
  await sanitize(page);
  await page.evaluate(() => {
    document.querySelector("header.top").style.display = "none";
    document.querySelector("#how").style.display = "none";
    document.querySelector("#doctor").style.display = "none";
    const heading = document.querySelector("#pricing h2");
    if (heading && heading.parentElement) heading.parentElement.style.display = "none";
    const rules = document.querySelector(".rules");
    if (rules) rules.style.display = "none";
    document.querySelector("#pricing").scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(150);
  await shot(page, "price");
}

async function renderFrames(origin, manifest) {
  await mkdir(FRAMES, { recursive: true });
  const template = await readFile(STAGE_TEMPLATE, "utf8");
  const film = {
    scenes: manifest.scenes,
    plates: {
      chat: "/_film/plates/chat.png",
      synopsis: "/_film/plates/synopsis.png",
      price: "/_film/plates/price.png",
    },
  };
  const html = template.replace("/*__FILM__*/", JSON.stringify(film));
  await writeFile(path.join(WORK, "stage.html"), html);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-dev-shm-usage", "--hide-scrollbars", "--font-render-hinting=medium"],
  });
  const context = await browser.newContext({
    viewport: { width: OUT_W, height: OUT_H },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto(`${origin}/_film/stage.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.fonts && document.fonts.status === "loaded");
  await page.evaluate(() => window.prepare());
  const frames = Math.round(manifest.total * FPS);
  if (frames / FPS > MAX_SECONDS) {
    throw new Error(`Frame count ${frames} runs past ${MAX_SECONDS}s`);
  }
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.renderFrame(t), i / FPS);
    await page.screenshot({
      path: path.join(FRAMES, `${String(i).padStart(4, "0")}.jpg`),
      type: "jpeg",
      quality: 92,
    });
    if (i % 30 === 0) console.log(`frame ${i}/${frames}`);
  }
  await browser.close();
  console.log(`frames ${frames}`);
  return frames;
}

async function loudnormTo(input, output, integrated, truePeak) {
  const pass = await run("ffmpeg", [
    "-i", input,
    "-af", `loudnorm=I=${integrated}:TP=${truePeak}:LRA=11:print_format=json`,
    "-f", "null", "-",
  ]);
  const match = pass.err.match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error(`loudnorm did not print measurements for ${output}`);
  const measured = JSON.parse(match[0]);
  await run("ffmpeg", [
    "-y", "-i", input,
    "-af",
    `loudnorm=I=${integrated}:TP=${truePeak}:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
    output,
  ]);
}

async function mixAudio() {
  const voice = path.join(AUDIO, "voice.wav");
  const music = path.join(AUDIO, "music.wav");
  const mixed = path.join(AUDIO, "mixed.wav");
  await run("ffmpeg", [
    "-y", "-i", voice, "-i", music,
    "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo,highpass=f=80[v];[1:a]aformat=channel_layouts=stereo[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    mixed,
  ]);
  const web = path.join(AUDIO, "web.wav");
  const tv = path.join(AUDIO, "tv.wav");
  await loudnormTo(mixed, web, -16, -1.5);
  await loudnormTo(mixed, tv, -24, -2.0);
  return { web, tv };
}

async function encodeVideo(frames, audio, outFile, { copyVideoFrom = "" } = {}) {
  if (copyVideoFrom) {
    await run("ffmpeg", [
      "-y", "-i", copyVideoFrom, "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      "-movflags", "+faststart",
      "-shortest",
      outFile,
    ]);
    return outFile;
  }
  let crf = 20;
  let last = "";
  for (; crf <= 32; crf += 3) {
    last = path.join(WORK, `cut-${crf}.mp4`);
    await run("ffmpeg", [
      "-y",
      "-framerate", String(FPS),
      "-i", path.join(FRAMES, "%04d.jpg"),
      "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
      "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-af", "alimiter=limit=0.89:level=false",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
      "-shortest",
      last,
    ]);
    const size = (await stat(last)).size;
    console.log(`mp4 crf ${crf} ${(size / 1048576).toFixed(2)} MB`);
    if (size < 6 * 1024 * 1024) break;
  }
  await copyFile(last, outFile);
  return outFile;
}

async function encodeWebm(mp4) {
  const out = path.join(PUBLIC, "media", "how-ispry-works.webm");
  await run("ffmpeg", [
    "-y", "-i", mp4,
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36",
    "-row-mt", "1", "-cpu-used", "3", "-deadline", "good",
    "-c:a", "libopus", "-b:a", "96k", "-ac", "2",
    out,
  ]);
  return out;
}

function formatClock(t) {
  const s = Math.floor(t);
  const frac = Math.floor((t - s) * 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${frac}`;
}

async function posterAndSheet(mp4) {
  const poster = path.join(PUBLIC, "media", "how-ispry-works-poster.webp");
  let quality = 68;
  for (; quality >= 36; quality -= 8) {
    await run("ffmpeg", [
      "-y", "-ss", "1.45", "-i", mp4,
      "-frames:v", "1",
      "-c:v", "libwebp", "-quality", String(quality),
      poster,
    ]);
    const size = (await stat(poster)).size;
    console.log(`poster q ${quality} ${(size / 1024).toFixed(1)} KB`);
    if (size < 60 * 1024) break;
  }
  const { out } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4,
  ]);
  const dur = Number(out.trim());
  const sheetDir = path.join(WORK, "sheet");
  await mkdir(sheetDir, { recursive: true });
  const count = Math.max(1, Math.round(dur * 2));
  for (let i = 0; i < count; i++) {
    const t = Math.min(dur - 0.05, i / 2);
    const stamp = path.join(sheetDir, `t${String(i).padStart(2, "0")}.txt`);
    await writeFile(stamp, formatClock(t));
    await run("ffmpeg", [
      "-y", "-ss", t.toFixed(3), "-i", mp4,
      "-frames:v", "1",
      "-vf", `scale=320:180,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=${stamp}:fontsize=14:fontcolor=0x07080C:box=1:boxcolor=0xD7FF3F@0.92:boxborderw=4:x=8:y=8`,
      path.join(sheetDir, `f${String(i).padStart(2, "0")}.png`),
    ]);
  }
  const cols = 8;
  const rows = Math.ceil(count / cols);
  const sheet = path.join(WORK, "contact-sheet.png");
  await run("ffmpeg", [
    "-y", "-framerate", "1", "-i", path.join(sheetDir, "f%02d.png"),
    "-vf", `scale=320:180,tile=${cols}x${rows}:padding=6:margin=6:color=0x07080C`,
    "-frames:v", "1",
    sheet,
  ]);
  return { poster, sheet, dur };
}

async function measureLoudness(file) {
  const probe = await run("ffmpeg", ["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { allowFail: true });
  const blob = probe.err;
  const summary = blob.slice(blob.lastIndexOf("Summary"));
  const integrated = Number((summary.match(/I:\s+(-?[\d.]+)\s+LUFS/) || [])[1]);
  const peak = Number((summary.match(/Peak:\s+(-?[\d.]+)\s+dBFS/) || [])[1]);
  if (!Number.isFinite(integrated)) throw new Error(`No loudness reading for ${file}\n${summary.slice(-800)}`);
  return { integrated, peak };
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function durationLabel(seconds) {
  const hundredths = Math.round(seconds * 100) / 100;
  return hundredths.toFixed(2).replace(/(\.\d)0$/, "$1").replace(/\.0$/, "");
}

async function patchHtml(manifest, seconds) {
  const file = path.join(PUBLIC, "index.html");
  let html = await readFile(file, "utf8");
  const paragraphs = manifest.scenes.map((scene) => `        <p>${escapeHtml(scene.text)}</p>`).join("\n");
  const block = `<details class="transcript">\n        <summary>Transcript</summary>\n${paragraphs}\n      </details>`;
  if (!/<details class="transcript">[\s\S]*?<\/details>/.test(html)) {
    throw new Error("Homepage transcript block is missing");
  }
  html = html.replace(/<details class="transcript">[\s\S]*?<\/details>/, block);
  html = html.replace(/\n\s*<p class="note">The recording still describes an older review cutoff\.[\s\S]*?<\/p>/, "");
  const label = durationLabel(seconds);
  html = html.replace(
    /aria-label="How iSpry works — [^"]*"/,
    `aria-label="How iSpry works — ${label}-second television spot"`,
  );
  html = html.replace(
    /<figcaption>[\s\S]*?<\/figcaption>/,
    `<figcaption>${label}-second spot · doctor-reviewed 24/7</figcaption>`,
  );
  if (!html.includes('width="960"') || !html.includes('height="540"') || !html.includes('preload="none"')) {
    throw new Error("Video element lost width, height, or preload");
  }
  await writeFile(file, html);
}

function spokenText(manifest) {
  return manifest.scenes.map((scene) => scene.text).join(" ");
}

async function validate(manifest, mp4, vttPath) {
  const vtt = await readFile(vttPath, "utf8");
  if (!vtt.startsWith("WEBVTT")) throw new Error("VTT missing header");
  const cues = [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)\n([^\n]+)/g)];
  if (!cues.length) throw new Error("VTT has no cues");
  let prev = 0;
  const lines = [];
  for (const cue of cues) {
    const start = Number(cue[1]) * 3600 + Number(cue[2]) * 60 + Number(cue[3]) + Number(cue[4]) / 1000;
    const end = Number(cue[5]) * 3600 + Number(cue[6]) * 60 + Number(cue[7]) + Number(cue[8]) / 1000;
    if (!(end > start)) throw new Error(`VTT cue does not advance: ${cue[0]}`);
    if (start < prev - 0.001) throw new Error(`VTT cues overlap at ${start}`);
    prev = end;
    lines.push(cue[9].trim());
  }
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  const expected = spokenText(manifest).replace(/\s+/g, " ").trim();
  if (joined !== expected) {
    throw new Error(`VTT does not match narration.\nVTT: ${joined}\nSAY: ${expected}`);
  }
  const { out } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=width,height,avg_frame_rate,codec_name",
    "-of", "json", mp4,
  ]);
  const probed = JSON.parse(out);
  const dur = Number(probed.format.duration);
  if (!(dur > 0) || dur > MAX_SECONDS) throw new Error(`Duration ${dur}s is outside 0–${MAX_SECONDS}s`);
  const video = probed.streams.find((s) => s.codec_name === "h264") || probed.streams[0];
  if (Number(video.width) !== OUT_W || Number(video.height) !== OUT_H) {
    throw new Error(`Expected ${OUT_W}x${OUT_H}, got ${video.width}x${video.height}`);
  }
  const narration = await readFile(path.join(ROOT, "scripts", "intro-narration.txt"), "utf8");
  const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
  const transcript = (html.match(/<details class="transcript">[\s\S]*?<\/details>/) || [""])[0];
  for (const [name, text] of [["narration", narration], ["vtt", vtt], ["transcript", transcript]]) {
    if (/6\s*pm|six\s*pm/i.test(text)) throw new Error(`${name} still mentions 6 pm`);
  }
  if (/older review cutoff/i.test(html)) throw new Error("Older-cutoff note is still on the homepage");
  if (!transcript.includes(manifest.scenes[0].text)) throw new Error("Transcript does not include the narration");
  const loud = await measureLoudness(mp4);
  console.log(`loudness I=${loud.integrated} LUFS peak=${loud.peak} dBFS duration=${dur}`);
  if (loud.integrated < -17.4 || loud.integrated > -14.6) {
    throw new Error(`Web loudness ${loud.integrated} LUFS is outside about -16`);
  }
  if (loud.peak > -1.0) throw new Error(`True peak ${loud.peak} dBFS is hotter than -1 dBTP`);
  return { dur, loud };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(AUDIO, "manifest.json"), "utf8"));
  console.log(`narration ${manifest.total}s speed ${manifest.speed}`);
  if (manifest.speed > 1) throw new Error("Voice speed is above 1.0");
  if (manifest.total > MAX_SECONDS) {
    throw new Error(`Narration is ${manifest.total}s. Cut words. Do not raise the voice speed.`);
  }
  for (const id of ["hook", "spry", "price", "doctor", "end"]) {
    if (!manifest.scenes.some((scene) => scene.id === id)) throw new Error(`Missing scene ${id}`);
  }

  const { server, origin } = await startServer();
  console.log("serving", origin);
  try {
    if (process.env.SKIP_CAPTURE === "1" && existsSync(path.join(PLATES, "chat.png"))) {
      console.log("reusing plates");
    } else {
      const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--disable-dev-shm-usage", "--hide-scrollbars", "--font-render-hinting=medium"],
      });
      const context = await browser.newContext({
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      await context.addInitScript((demo) => {
        localStorage.setItem("ispry_account_v1", JSON.stringify(demo));
        localStorage.setItem("spry_voice", "0");
      }, DEMO);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (err) => console.warn("pageerror", err.message));
      await installRoutes(page);
      try {
        await capture(page, origin);
      } catch (err) {
        const fail = path.join(WORK, "fail.png");
        try {
          await page.screenshot({ path: fail });
          console.error("saved", fail);
        } catch { /* page may be closed */ }
        throw err;
      } finally {
        await browser.close();
      }
    }
    if (process.env.SKIP_ENCODE === "1") {
      console.log("plates only");
      return;
    }
    const audio = await mixAudio();
    const frames = await renderFrames(origin, manifest);
    const mp4 = path.join(PUBLIC, "media", "how-ispry-works.mp4");
    await encodeVideo(frames, audio.web, mp4);
    const tv = path.join(WORK, "how-ispry-works-tv.mp4");
    await encodeVideo(frames, audio.tv, tv, { copyVideoFrom: mp4 });
    await copyFile(path.join(AUDIO, "captions.vtt"), path.join(PUBLIC, "media", "how-ispry-works.vtt"));
    const webm = await encodeWebm(mp4);
    const { poster, sheet, dur } = await posterAndSheet(mp4);
    await patchHtml(manifest, dur);
    const checked = await validate(manifest, mp4, path.join(PUBLIC, "media", "how-ispry-works.vtt"));
    const tvLoud = await measureLoudness(tv);
    const artifactDir = "/opt/cursor/artifacts";
    await mkdir(artifactDir, { recursive: true });
    const sheetOut = path.join(artifactDir, "ispry-tv-contact-sheet.png");
    const mp4Out = path.join(artifactDir, "how-ispry-works.mp4");
    const tvOut = path.join(artifactDir, "how-ispry-works-tv-24lufs.mp4");
    await copyFile(sheet, sheetOut);
    await copyFile(mp4, mp4Out);
    await copyFile(tv, tvOut);
    const report = {
      seconds: checked.dur,
      label: durationLabel(checked.dur),
      frames,
      mp4: (await stat(mp4)).size,
      webm: (await stat(webm)).size,
      poster: (await stat(poster)).size,
      loudness: checked.loud,
      tvLoudness: tvLoud,
      sheet: sheetOut,
      mp4Artifact: mp4Out,
      tvArtifact: tvOut,
      narration: spokenText(manifest),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
