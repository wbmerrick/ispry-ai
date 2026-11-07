import test from "node:test";
import assert from "node:assert/strict";
import { visitBasicsGate, GUEST_PREVIEW_TURNS } from "./_lib/guard.js";

const basics = "Visit basics — Age: 34. Sex: Female (FM). In Tennessee now: Yes.";

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
