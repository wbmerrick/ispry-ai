import test from "node:test";
import assert from "node:assert/strict";
import {
  applyServerBasics,
  GUEST_PREVIEW_TURNS,
  normalizeSpryMessages,
  originAllowed,
  SPRY_INPUT,
  visitBasicsGate,
} from "./_lib/guard.js";

const basics = "Visit basics — Age: 34. Sex: Female (F). In Tennessee now: Yes.";
const basicsLegacy = "Visit basics — Age: 34. Sex: Female (FM). In Tennessee now: Yes.";

test("guest preview turns are zero — account required first", () => {
  assert.equal(GUEST_PREVIEW_TURNS, 0);
});

test("a message without visit basics is refused", () => {
  const one = visitBasicsGate([{ role: "user", content: "My throat hurts." }]);
  assert.equal(one.ok, false);
  assert.match(one.reply, /account/i);
});

test("pathway kickoff without visit basics is refused", () => {
  const gate = visitBasicsGate([
    { role: "user", content: "[PATHWAY_INTAKE] Pathway: Sore throat. They have not created an account." },
  ]);
  assert.equal(gate.ok, false);
  assert.match(gate.reply, /account/i);
});

test("visit basics accept Female (F) and legacy Female (FM)", () => {
  const modern = visitBasicsGate([{ role: "user", content: basics + "\n\nSore throat." }]);
  assert.equal(modern.ok, true);
  assert.equal(modern.basics.sex, "female");
  const legacy = visitBasicsGate([{ role: "user", content: basicsLegacy + "\n\nSore throat." }]);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.basics.sex, "female");
});

test("a POST with no Origin is rejected and a GET probe is not", () => {
  assert.equal(originAllowed({ method: "POST", headers: {} }), false);
  assert.equal(originAllowed({ method: "POST", headers: { origin: "" } }), false);
  assert.equal(originAllowed({ method: "GET", headers: {} }), true);
  assert.equal(originAllowed({ method: "POST", headers: { origin: "https://ispry.ai" } }), true);
  assert.equal(originAllowed({ method: "POST", headers: { origin: "https://evil.example" } }), false);
});

test("spry messages are capped and a basics line is kept", () => {
  const long = "a".repeat(5000);
  const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `note ${i} ${long}` }));
  many.unshift({ role: "user", content: "Visit basics — Age: 34. Sex: Female (F). In Tennessee now: Yes.\n\nSore throat." });
  const out = normalizeSpryMessages(many);
  assert.equal(out.length, SPRY_INPUT.maxMessages);
  assert.equal(out[0].content.startsWith("Visit basics"), true);
  const user = out.find((m) => m.role === "user" && !m.content.startsWith("Visit basics"));
  assert.ok(user.content.length <= SPRY_INPUT.maxUserChars);
  assert.ok(SPRY_INPUT.maxTokens < 1200);
});

test("server basics replace a client-typed age", () => {
  const messages = applyServerBasics(
    [{ role: "user", content: "Visit basics — Age: 16. Sex: Male (M). In Tennessee now: No.\n\nSore throat." }],
    { age: 34, sex: "female", in_tennessee: true },
  );
  const gate = visitBasicsGate(messages);
  assert.equal(gate.ok, true);
  assert.equal(gate.basics.age, 34);
  assert.equal(gate.basics.sex, "female");
  assert.equal(gate.basics.inTennessee, true);
});

test("visit basics enforce age and Tennessee", () => {
  const young = visitBasicsGate([
    { role: "user", content: basics.replace("Age: 34", "Age: 16") + "\n\nSore throat." },
  ]);
  assert.equal(young.ok, false);
  const outOfState = visitBasicsGate([
    { role: "user", content: basics.replace("Yes.", "No.") + "\n\nSore throat." },
  ]);
  assert.equal(outOfState.ok, false);
  const ok = visitBasicsGate([
    { role: "user", content: basics + "\n\nSore throat." },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.basics.age, 34);
});
