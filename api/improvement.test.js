import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { patientPaymentCopy } from "./_lib/notify.js";

const root = path.join(import.meta.dirname, "..");
const publicDir = path.join(root, "public");

test("the public membership button does not skip to Stripe", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  assert.match(html, /class="btn btn-dark js-membership-offer" href="#ask"/);
  assert.doesNotMatch(html, /js-join" href="https:\/\/buy\.stripe\.com/);
  const home = await readFile(path.join(publicDir, "home.js"), "utf8");
  assert.match(home, /js-membership-offer/);
  assert.match(home, /ispry_consent_ok/);
  assert.match(home, /js-join-direct/);
});

test("patient payment email is a receipt with next steps and no symptoms", () => {
  const visit = patientPaymentCopy({ plan: "visit", amount: "$49.00 USD" });
  assert.match(visit.subject, /visit/);
  assert.match(visit.text, /24\/7/);
  assert.doesNotMatch(visit.text, /6\s+pm/i);
  assert.match(visit.text, /https:\/\/ispry\.ai\/member\.html/);
  assert.match(visit.text, /good-faith-estimate\.html/);
  assert.match(visit.text, /\$49\.00 USD/);
  assert.doesNotMatch(visit.text, /UTI|sore throat|semaglutide|diagnosis:/i);
  const member = patientPaymentCopy({ plan: "membership", amount: "$100.00 USD" });
  assert.match(member.text, /\$100 a month/);
  assert.match(member.text, /no partial-month refund/i);
});

test("sign-in dialog source traps keyboard focus", async () => {
  const src = await readFile(path.join(publicDir, "account.js"), "utf8");
  assert.match(src, /e\.key === "Escape"/);
  assert.match(src, /e\.key !== "Tab"/);
  assert.match(src, /acctTitle/);
  assert.match(src, /restoreOpener/);
  assert.match(src, /acctPwShow/);
  assert.doesNotMatch(src, /password_confirm/);
});

test("pages share analytics, fonts, and open graph tags without the old claims", async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith(".html"));
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const csp = vercel.headers.find((h) => h.source === "/(.*)").headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.doesNotMatch(csp, /jsdelivr/);
  assert.doesNotMatch(csp, /fonts\.googleapis/);
  assert.doesNotMatch(csp, /fonts\.gstatic/);
  for (const name of files) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    assert.match(html, /\/_vercel\/insights\/script\.js/, name);
    assert.match(html, /\/fonts\.css/, name);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, name);
    assert.doesNotMatch(html, /fonts\.googleapis\.com/, name);
    assert.doesNotMatch(html, /HIPAA-compliant/, name);
    if (!html.includes('content="noindex"')) {
      assert.match(html, /property="og:image"/, name);
      assert.match(html, /rel="canonical"/, name);
    }
  }
  for (const name of ["contact.html", "privacy.html", "terms.html", "npp.html"]) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    assert.match(html, new RegExp(`rel="canonical" href="https://ispry.ai/${name}"`));
  }
});

test("the video poster is a small webp and clean paths redirect", async () => {
  const poster = await stat(path.join(publicDir, "media", "how-ispry-works-poster.webp"));
  assert.ok(poster.size < 60 * 1024, poster.size);
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  assert.match(html, /poster="\/media\/how-ispry-works-poster\.webp"/);
  assert.match(html, /width="960"/);
  assert.match(html, /<summary>Transcript<\/summary>/);
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const pricing = vercel.redirects.find((r) => r.source === "/pricing");
  assert.equal(pricing.destination, "/pricing.html");
  assert.equal(vercel.redirects.find((r) => r.source === "/privacy").destination, "/privacy.html");
  const sitemap = await readFile(path.join(publicDir, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<lastmod>2026-11-27<\/lastmod>/);
  assert.match(sitemap, /pricing\.html/);
});
