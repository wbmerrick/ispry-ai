#!/usr/bin/env node
/**
 * Cut the homepage television spot.
 *
 * Serves public/ on 127.0.0.1. The picture is the homepage dusk hero
 * (public/media/hero-1920.jpg) with the site's ink wash, type, and one
 * card per beat. No account is created and no clinical page is captured.
 *
 * Picture is 1920x1080 at 30 fps. Closed captions are the VTT track only.
 * The spoken read stays at Kokoro speed 1.0 and the whole spot, end card
 * included, is 20 seconds or less. Aim near 15. The web mp4 stays at or
 * under about 5 MB.
 *
 * Run via scripts/build-intro-video.sh
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const TOOLS = process.env.ISPRY_TOOLS || "/tmp/ispry-tools";
const { chromium } = createRequire(path.join(TOOLS, "package.json"))("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const WORK = process.env.ISPRY_INTRO_WORK || "/tmp/ispry-intro-build";
const AUDIO = path.join(WORK, "audio");
const FRAMES = path.join(WORK, "frames");
const STAGE_TEMPLATE = path.join(ROOT, "scripts", "commercial-stage.html");

const FPS = 30;
const OUT_W = 1920;
const OUT_H = 1080;
const MAX_SECONDS = 20;

function contentType(file) {
  const ext = path.extname(file);
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webp": "image/webp",
      ".avif": "image/avif",
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

async function renderFrames(origin, manifest) {
  await mkdir(FRAMES, { recursive: true });
  const template = await readFile(STAGE_TEMPLATE, "utf8");
  const film = { scenes: manifest.scenes, total: manifest.total };
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
  page.on("pageerror", (err) => console.error("pageerror", err.message));
  await page.goto(`${origin}/_film/stage.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const img = document.querySelector("#hero-photo");
    return img && img.complete && img.naturalWidth >= 1600 && document.fonts && document.fonts.status === "loaded";
  });
  await page.evaluate(() => window.prepare());
  const frames = Math.round(manifest.total * FPS);
  if (frames / FPS > MAX_SECONDS) {
    throw new Error(`Frame count ${frames} runs past ${MAX_SECONDS}s`);
  }
  const preview = process.env.SPOT_PREVIEW === "1";
  const jobs = preview
    ? manifest.scenes.map((scene) => ({
        index: Math.min(frames - 1, Math.max(0, Math.round((scene.start + Math.min(0.62, scene.duration * 0.45)) * FPS))),
        file: path.join(WORK, "preview", `${scene.id}.jpg`),
      }))
    : Array.from({ length: frames }, (_, index) => ({
        index,
        file: path.join(FRAMES, `${String(index).padStart(4, "0")}.jpg`),
      }));
  if (preview) await mkdir(path.join(WORK, "preview"), { recursive: true });
  for (const job of jobs) {
    await page.evaluate((t) => window.renderFrame(t), job.index / FPS);
    await page.screenshot({ path: job.file, type: "jpeg", quality: 93 });
    if (!preview && job.index % 30 === 0) console.log(`frame ${job.index}/${frames}`);
    if (preview) console.log("preview", path.basename(job.file));
  }
  await browser.close();
  console.log(`frames ${preview ? jobs.length : frames}`);
  return preview ? 0 : frames;
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
  await loudnormTo(mixed, web, -16, -2.5);
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
      "-af", "alimiter=limit=0.76:level=false",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
      "-shortest",
      last,
    ]);
    const size = (await stat(last)).size;
    console.log(`mp4 crf ${crf} ${(size / 1048576).toFixed(2)} MB`);
    if (size <= 5 * 1024 * 1024) break;
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
      "-y", "-ss", "0.90", "-i", mp4,
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
  const end = manifest.scenes.find((scene) => scene.id === "end");
  if (!end || !/I Spry dot A\. I\./.test(end.say || "")) {
    throw new Error('The URL must be spoken as "I Spry dot A. I."');
  }
  const stage = await readFile(STAGE_TEMPLATE, "utf8");
  const narrationBody = narration
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const spotCopy = [narrationBody, vtt, transcript, stage].join("\n");
  if (/not a diagnosis/i.test(spotCopy)) throw new Error('The spot says "not a diagnosis"');
  if (/wilbur|merrick|william|\blicen[sc]e\b|\bnpi\b|1497231054|will\.jpg|hospitalist|\bpllc\b/i.test(spotCopy)) {
    throw new Error("The spot includes physician personal information");
  }
  if (!stage.includes("/media/hero-1920.jpg")) throw new Error("Stage is not using the homepage hero");
  if (/bg-peak/.test(stage)) throw new Error("Stage still uses the old peak background");
  const mp4Size = (await stat(mp4)).size;
  if (mp4Size > 5 * 1024 * 1024) throw new Error(`mp4 is ${(mp4Size / 1048576).toFixed(2)} MB, over 5 MB`);
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
    if (process.env.SPOT_PREVIEW === "1") {
      await renderFrames(origin, manifest);
      const artifactDir = "/opt/cursor/artifacts";
      await mkdir(artifactDir, { recursive: true });
      for (const scene of manifest.scenes) {
        const from = path.join(WORK, "preview", `${scene.id}.jpg`);
        const to = path.join(artifactDir, `preview-${scene.id}.jpg`);
        await copyFile(from, to);
        console.log("preview", to);
      }
      return;
    }
    const audio = await mixAudio();
    const frames = process.env.SKIP_FRAMES === "1"
      ? Math.round(manifest.total * FPS)
      : await renderFrames(origin, manifest);
    if (process.env.SKIP_FRAMES === "1") console.log(`reusing ${frames} frames`);
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
    const stills = [];
    for (const scene of manifest.scenes) {
      const t = Math.min(scene.start + scene.duration - 0.12, scene.start + Math.min(0.72, scene.duration * 0.5));
      const still = path.join(artifactDir, `spot-${scene.id}.jpg`);
      await run("ffmpeg", ["-y", "-ss", Math.max(0, t).toFixed(3), "-i", mp4, "-frames:v", "1", "-q:v", "2", still]);
      stills.push(still);
    }
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
      stills,
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
