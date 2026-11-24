import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const publicDir = path.join(root, "public");

test("every public page footer has the legal links and the emergency line", async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith(".html")).sort();
  assert.ok(files.includes("good-faith-estimate.html"));
  assert.ok(files.length >= 18);
  for (const name of files) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    const at = html.lastIndexOf("<footer");
    assert.ok(at > 0, name);
    const footer = html.slice(at);
    for (const href of [
      "/privacy.html",
      "/terms.html",
      "/npp.html",
      "/telehealth-consent.html",
      "/good-faith-estimate.html",
    ]) {
      assert.match(footer, new RegExp(`href="${href}"`), `${name} missing ${href}`);
    }
    assert.match(footer, /call 911/i, name);
    assert.match(footer, /988/, name);
  }
});

test("the Good Faith Estimate page carries the CMS notice substance", async () => {
  const html = await readFile(path.join(publicDir, "good-faith-estimate.html"), "utf8");
  assert.match(html, /Good Faith Estimate/);
  assert.match(html, /self-pay/i);
  assert.match(html, /\(731\) 415-0724/);
  assert.match(html, /\$400/);
  assert.match(html, /https:\/\/www\.cms\.gov\/nosurprises/);
  const sitemap = await readFile(path.join(publicDir, "sitemap.xml"), "utf8");
  assert.match(sitemap, /good-faith-estimate\.html/);
});

test("the Akute task no longer claims a screen was completed", async () => {
  const src = await readFile(path.join(root, "api", "handoff.js"), "utf8");
  assert.doesNotMatch(src, /contraindication screen completed/i);
  assert.doesNotMatch(src, /Education \+ contraindication/);
});
