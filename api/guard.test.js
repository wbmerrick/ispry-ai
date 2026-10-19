import test from "node:test";
import assert from "node:assert/strict";
import { visitBasicsGate, GUEST_PREVIEW_TURNS } from "./_lib/guard.js";

const basics = "Visit basics — Age: 34. Sex: Female (FM). In Tennessee now: Yes.";

test("two guest messages are allowed without visit basics", () => {
  assert.equal(GUEST_PREVIEW_TURNS, 2);
  const one = visitBasicsGate([{ role: "user", content: "My throat hurts." }]);
  assert.equal(one.ok, true);
  assert.equal(one.preview, true);
  const two = visitBasicsGate([
    { role: "user", content: "My throat hurts." },
    { role: "assistant", content: "How long?" },
    { role: "user", content: "Since last night." },
  ]);
  assert.equal(two.ok, true);
});

test("a third guest message stops even if assistant replies are in the transcript", () => {
  const gate = visitBasicsGate([
    { role: "user", content: "My throat hurts." },
    { role: "assistant", content: "How long?" },
    { role: "user", content: "Since last night." },
    { role: "assistant", content: "Any fever?" },
    { role: "user", content: "A little." },
  ]);
  assert.equal(gate.ok, false);
  assert.match(gate.reply, /account/i);
});

test("a fast-track kickoff does not use up the two guest messages", () => {
  const gate = visitBasicsGate([
    { role: "user", content: "[PATHWAY_INTAKE] Pathway: Sore throat. They have not created an account." },
    { role: "assistant", content: "How long has it hurt?" },
    { role: "user", content: "Since last night." },
    { role: "assistant", content: "Any fever?" },
    { role: "user", content: "No." },
  ]);
  assert.equal(gate.ok, true);
  const third = visitBasicsGate([
    { role: "user", content: "[PATHWAY_INTAKE] Pathway: Sore throat." },
    { role: "user", content: "Since last night." },
    { role: "user", content: "No fever." },
    { role: "user", content: "It hurts to swallow." },
  ]);
  assert.equal(third.ok, false);
});

test("visit basics anywhere in the transcript still enforce age and Tennessee", () => {
  const young = visitBasicsGate([
    { role: "user", content: "Hi" },
    { role: "user", content: "Visit basics — Age: 16. Sex: Male (M). In Tennessee now: Yes." },
  ]);
  assert.equal(young.ok, false);
  const ok = visitBasicsGate([
    { role: "user", content: "Hi" },
    { role: "user", content: basics + "\n\nSore throat." },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.basics.age, 34);
});
