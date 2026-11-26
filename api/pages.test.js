import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("the 404 page is branded, noindex, and linked home", async () => {
  const html = await readFile(path.join(publicDir, "404.html"), "utf8");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="\/"/);
  assert.match(html, /Back to iSpry/);
  assert.match(html, /legal\.css/);
  const sitemap = await readFile(path.join(publicDir, "sitemap.xml"), "utf8");
  assert.doesNotMatch(sitemap, /404\.html/);
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  assert.equal(vercel.outputDirectory, "public");
  assert.equal(vercel.cleanUrls, false);
  const robots = await readFile(path.join(publicDir, "robots.txt"), "utf8");
  assert.match(robots, /Disallow:\s*\/404\.html/);
});

test("pages keep executable scripts in files and the CSP hashes every JSON-LD block", async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith(".html")).sort();
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const csp = vercel.headers.find((h) => h.source === "/(.*)").headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  const names = ["Referrer-Policy", "X-Content-Type-Options", "Permissions-Policy", "X-Frame-Options"];
  const keys = vercel.headers.find((h) => h.source === "/(.*)").headers.map((h) => h.key);
  for (const name of names) assert.ok(keys.includes(name), name);
  for (const name of files) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (/\bsrc\s*=/.test(m[1])) continue;
      const type = (m[1].match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
      assert.equal(type, "application/ld+json", `${name} has an inline script`);
      const hash = createHash("sha256").update(m[2], "utf8").digest("base64");
      assert.ok(csp.includes(`'sha256-${hash}'`), `${name} JSON-LD hash missing`);
    }
  }
});

test("the Akute task no longer claims a screen was completed", async () => {
  const src = await readFile(path.join(root, "api", "handoff.js"), "utf8");
  assert.doesNotMatch(src, /contraindication screen completed/i);
  assert.doesNotMatch(src, /Education \+ contraindication/);
});
