import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
const mobileBudget = 250 * 1024;

test("the homepage hero image is self-hosted and under the mobile size budget", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  const widths = [768, 1280, 1920];
  const types = ["avif", "webp", "jpg"];
  for (const width of widths) {
    for (const type of types) {
      const file = `hero-${width}.${type}`;
      assert.match(html, new RegExp(`/media/${file.replace(".", "\\.")}`), file);
      const info = await stat(path.join(publicDir, "media", file));
      assert.ok(info.size > 1024, `${file} looks empty`);
      if (width === 768) {
        assert.ok(info.size < mobileBudget, `${file} is ${info.size} bytes`);
      }
    }
  }
  const mobileAvif = await stat(path.join(publicDir, "media", "hero-768.avif"));
  const mobileWebp = await stat(path.join(publicDir, "media", "hero-768.webp"));
  assert.ok(mobileAvif.size + mobileWebp.size < mobileBudget, "mobile hero candidates together exceed 250KB");
  assert.match(html, /class="hero-bg"/);
  assert.match(html, /type="image\/avif"/);
  assert.match(html, /sizes="100vw"/);
  assert.doesNotMatch(html, /bg-peak/);
  assert.doesNotMatch(html, /hero-\d+\.(avif|webp|jpe?g)[^"'\\s]*https?:/i);
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const csp = vercel.headers.find((h) => h.source === "/(.*)").headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /img-src 'self'/);
  assert.doesNotMatch(csp, /img-src[^;]*https?:/);
});
