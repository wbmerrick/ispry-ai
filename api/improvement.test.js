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
  assert.match(visit.text, /full refund of the iSpry visit fee as soon as the request is found ineligible/);
  assert.doesNotMatch(visit.text, /not stated in this email/i);
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
  assert.match(html, /poster="\/media\/how-ispry-works-poster\.webp\?v=20261130"/);
  assert.match(html, /src="\/media\/how-ispry-works\.webm\?v=20261130"/);
  assert.match(html, /src="\/media\/how-ispry-works\.mp4\?v=20261130"/);
  assert.match(html, /src="\/media\/how-ispry-works\.vtt\?v=20261130"/);
  assert.match(html, /width="960"/);
  assert.match(html, /<summary>Transcript<\/summary>/);
  const caption = html.match(/<figcaption>([\d.]+)-second spot · doctor-reviewed 24\/7<\/figcaption>/);
  assert.ok(caption, "figcaption missing duration");
  const seconds = Number(caption[1]);
  assert.ok(seconds > 10 && seconds <= 20, `spot is ${seconds}s`);
  assert.match(html, new RegExp(`aria-label="How iSpry works — ${caption[1]}-second television spot"`));
  const transcript = html.match(/<details class="transcript">[\s\S]*?<\/details>/)[0];
  for (const line of [
    "Skip the waiting room.",
    "Free Spry chat prepares a summary for your physician.",
    "Forty-nine dollars a visit, or one hundred a month.",
    "Your iSpry physician reviews every request, twenty-four seven.",
    "ispry.ai. In an emergency, call 9 1 1.",
  ]) {
    assert.ok(transcript.includes(line), line);
  }
  assert.doesNotMatch(transcript, /not a diagnosis/i);
  assert.doesNotMatch(transcript, /wilbur|merrick|william|1497231054|will\.jpg|hospitalist|\bpllc\b/i);
  const narration = await readFile(path.join(root, "scripts", "intro-narration.txt"), "utf8");
  const narrationBody = narration
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const vtt = await readFile(path.join(publicDir, "media", "how-ispry-works.vtt"), "utf8");
  assert.match(narration, /SAY: I Spry dot A\. I\. In an emergency, call 9 1 1\./);
  assert.match(vtt, /ispry\.ai\./);
  assert.match(vtt, /In an emergency, call 9 1 1\./);
  assert.doesNotMatch(`${narrationBody}\n${vtt}\n${transcript}`, /not a diagnosis/i);
  const stage = await readFile(path.join(root, "scripts", "commercial-stage.html"), "utf8");
  assert.match(stage, /\/media\/hero-1920\.jpg/);
  assert.match(stage, /#D7FF3F/);
  assert.match(stage, /Bricolage Grotesque/);
  assert.doesNotMatch(stage, /bg-peak/);
  const mp4 = await stat(path.join(publicDir, "media", "how-ispry-works.mp4"));
  const webm = await stat(path.join(publicDir, "media", "how-ispry-works.webm"));
  assert.ok(mp4.size > 100 * 1024 && mp4.size <= 5 * 1024 * 1024, mp4.size);
  assert.ok(webm.size < mp4.size, `webm ${webm.size} is not smaller than mp4 ${mp4.size}`);
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const pricing = vercel.redirects.find((r) => r.source === "/pricing");
  assert.equal(pricing.destination, "/pricing.html");
  assert.equal(vercel.redirects.find((r) => r.source === "/privacy").destination, "/privacy.html");
  const sitemap = await readFile(path.join(publicDir, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<lastmod>2026-11-27<\/lastmod>/);
  assert.match(sitemap, /pricing\.html/);
});

test("faq, about, membership, and weight-loss short urls redirect", async () => {
  const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  const dest = Object.fromEntries(vercel.redirects.map((r) => [r.source, r.destination]));
  assert.equal(dest["/faq"], "/faq.html");
  assert.equal(dest["/membership"], "/pricing.html");
  assert.equal(dest["/about"], "/about.html");
  assert.equal(dest["/weight-loss"], "/weight-loss-tennessee.html");
  assert.equal(dest["/glp-1"], "/weight-loss-tennessee.html");
  const sitemap = await readFile(path.join(publicDir, "sitemap.xml"), "utf8");
  assert.match(sitemap, /https:\/\/ispry\.ai\/faq\.html/);
  assert.match(sitemap, /https:\/\/ispry\.ai\/about\.html/);
});

test("faq reuses the home answers and new pages do not invent credentials", async () => {
  const home = await readFile(path.join(publicDir, "index.html"), "utf8");
  const faq = await readFile(path.join(publicDir, "faq.html"), "utf8");
  const homeAnswers = [...home.matchAll(/<div class="a">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  const faqAnswers = [...faq.matchAll(/<div class="a">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(faqAnswers.length, 9);
  assert.deepEqual(faqAnswers, homeAnswers);
  assert.match(home, /href="\/faq\.html"/);
  const about = await readFile(path.join(publicDir, "about.html"), "utf8");
  const visible = about.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(about, /About iSpry/);
  assert.match(about, /Tennessee-licensed physician/);
  assert.match(about, /\(731\) 415-0724/);
  assert.doesNotMatch(about, /wilbur|merrick|4267|1497231054|will\.jpg|hospitalist/i);
  assert.doesNotMatch(visible, /board certif/i);
  assert.doesNotMatch(visible, /years in practice/i);
  assert.doesNotMatch(visible, /LegitScript/);
  assert.doesNotMatch(visible, /starting at/i);
  const physicians = await readFile(path.join(publicDir, "physicians.html"), "utf8");
  assert.match(physicians, /This page is for clinicians/);
  assert.match(physicians, /For physicians/);
  assert.doesNotMatch(physicians, /content="noindex"/);
});

test("trust, two charges, async visits, and same-doctor copy are on the right pages", async () => {
  const home = await readFile(path.join(publicDir, "index.html"), "utf8");
  const care = await readFile(path.join(publicDir, "care.html"), "utf8");
  const pricing = await readFile(path.join(publicDir, "pricing.html"), "utf8");
  const weight = await readFile(path.join(publicDir, "weight-loss-tennessee.html"), "utf8");
  for (const html of [home, care]) {
    assert.match(html, /Tennessee-licensed physician/);
    assert.match(html, /\(731\) 415-0724/);
    assert.doesNotMatch(html, /1497231054/);
    assert.match(html, /No controlled substances/);
    assert.match(html, /Notice of Privacy Practices/);
    assert.match(html, /Good Faith Estimate/);
    assert.match(html, /\$49 visit or \$100\/month/);
  }
  assert.match(home, /not a live waiting room/);
  assert.match(care, /not a live waiting room/);
  for (const name of [
    "uti-treatment-tennessee.html",
    "sore-throat-treatment-tennessee.html",
    "sinus-infection-treatment-tennessee.html",
    "erectile-dysfunction-treatment-tennessee.html",
    "hair-loss-treatment-tennessee.html",
    "medication-refill-tennessee.html",
    "weight-loss-tennessee.html",
  ]) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    assert.match(html, /not a live waiting room/, name);
    assert.equal(html.split("not a live waiting room").length - 1, 1, name);
  }
  assert.match(home, /anonymous network clinicians/);
  assert.match(pricing, /anonymous network clinicians/);
  assert.match(home, /Billed separately/);
  assert.match(pricing, /Billed separately/);
  assert.match(weight, /Billed separately/);
  assert.match(weight, /priced and paid at whichever pharmacy you choose/);
  assert.doesNotMatch(weight, /not listed yet/);
  assert.doesNotMatch(weight, /starting at \$/i);
  const shared = [
    "Spry AI intake, any time of day",
    "Every plan reviewed by your physician",
    "Built with HIPAA safeguards. See the Notice of Privacy Practices",
  ];
  const visitCard = home.slice(home.indexOf('class="price visit"'), home.indexOf('class="price"'));
  const memberCard = home.slice(home.indexOf('iSpry Membership'), home.indexOf('class="charge-two"'));
  for (const item of shared) {
    assert.equal(visitCard.split(item).length - 1, 1, item);
    assert.equal(memberCard.split(item).length - 1, 1, item);
  }
  assert.match(visitCard, /A single problem/);
  assert.doesNotMatch(visitCard, /Up to 3 visits every month/);
  assert.match(memberCard, /Up to 3 visits every month/);
  assert.match(memberCard, /Up to 3 problems addressed per visit/);
  assert.match(pricing, /The \$49 visit and the \$100 membership both include/);
  for (const item of shared) assert.match(pricing, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(home, /full refund of the iSpry visit fee as soon as the request is found ineligible/);
  assert.match(pricing, /full refund of the iSpry visit fee as soon as the request is found ineligible/);
  assert.doesNotMatch(home, /not published here yet/);
  assert.doesNotMatch(pricing, /not published/);
  const faq = await readFile(path.join(publicDir, "faq.html"), "utf8");
  const estimate = await readFile(path.join(publicDir, "good-faith-estimate.html"), "utf8");
  for (const html of [home, faq, pricing, estimate]) {
    assert.match(html, /full refund of the iSpry visit fee as soon as the request is found ineligible/);
    assert.match(html, /priced and paid at whichever pharmacy you choose/);
  }
  const files = (await readdir(publicDir)).filter((name) => name.endsWith(".html"));
  for (const name of files) {
    const html = await readFile(path.join(publicDir, name), "utf8");
    assert.match(html, /href="\/faq\.html"/, name);
    if (name !== "contact.html") assert.equal(html.toLowerCase().includes("not listed yet"), false, name);
  }
});
