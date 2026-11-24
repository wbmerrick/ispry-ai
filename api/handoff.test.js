import test from "node:test";
import assert from "node:assert/strict";
import { formsKind, formsFollowUrl, FORMS_BUNDLES, DEFAULT_FORMS_URL, pathwayChartLine } from "./handoff.js";

test("forms bundle follows where Spry landed, not other text in the summary", () => {
  assert.equal(formsKind("Synopsis:\nMost likely: obesity, interested in a GLP-1\n\nProblem: Weight loss"), "weight-loss");
  assert.equal(formsKind("- **Problem:** Erectile dysfunction."), "ed");
  assert.equal(formsKind("Problem: Medication refill - lisinopril 10 mg"), "refill");
  assert.equal(formsKind("Problem: Sinus infection\nTried sildenafil once, wants a refill of nothing"), "");
  assert.equal(formsKind("Most likely: viral sore throat"), "");
  assert.equal(formsKind(""), "");
});

test("a refill of a GLP-1 or ED medicine still gets that medicine's consent", () => {
  assert.equal(formsKind("Problem: Refill of semaglutide"), "weight-loss");
  assert.equal(formsKind("Problem: tadalafil refill"), "ed");
});

test("each visit type maps to its own iSpry-subdomain bundle; anything else gets the default", () => {
  const urls = Object.keys(FORMS_BUNDLES).map((k) => formsFollowUrl(k));
  assert.equal(new Set(urls).size, 3);
  for (const u of urls) assert.match(u, /^https:\/\/ispry\.akutehealth\.com\/forms\/[0-9a-f]{24}$/);
  assert.equal(formsFollowUrl(""), DEFAULT_FORMS_URL);
  assert.equal(formsFollowUrl("constructor"), DEFAULT_FORMS_URL);
  assert.equal(formsFollowUrl("hair-loss"), DEFAULT_FORMS_URL);
});

test("a pathway label does not claim the education screen was completed", () => {
  const line = pathwayChartLine("sore-throat");
  assert.match(line, /sore-throat/);
  assert.match(line, /patient-reported/i);
  assert.doesNotMatch(line, /completed|contraindication|education/i);
  assert.equal(pathwayChartLine(""), "");
  assert.equal(pathwayChartLine("   "), "");
});

test("a corrected synopsis does not pick the earlier condition's bundle", () => {
  assert.equal(formsKind("Synopsis:\nMost likely: erectile dysfunction\n\nProblem: Low back strain"), "");
  assert.equal(formsKind("Synopsis:\nMost likely: sinus infection\n\nProblem: Weight loss"), "weight-loss");
  assert.equal(formsKind("Most likely: obesity, interested in a GLP-1"), "weight-loss");
});
