import {
  parseVisitBasics,
  visitBasicsGate,
  rateLimitSync,
  originAllowed,
  safeBookingUrl,
  rateLimit,
} from "../api/_lib/guard.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const parsed = parseVisitBasics(
  "Visit basics — Age: 35. In Tennessee now: Yes. Problems this visit: 1 problem.\n\nsore throat",
);
assert(parsed?.age === 35 && parsed.inTennessee && parsed.problems === 1, "parse");

assert(
  !visitBasicsGate([
    {
      role: "user",
      content: "Visit basics — Age: 16. In Tennessee now: Yes. Problems this visit: 1 problem.\n\nx",
    },
  ]).ok,
  "under18",
);
assert(
  !visitBasicsGate([
    {
      role: "user",
      content: "Visit basics — Age: 40. In Tennessee now: No. Problems this visit: 2 problems.\n\nx",
    },
  ]).ok,
  "tn",
);
assert(!visitBasicsGate([{ role: "user", content: "sore throat only" }]).ok, "bypass");
assert(
  visitBasicsGate([
    { role: "user", content: "hi" },
    { role: "assistant", content: "age?" },
    { role: "user", content: "40" },
  ]).ok,
  "mid",
);

assert(!originAllowed({ headers: { origin: "https://evil.example" } }), "evil");
assert(originAllowed({ headers: { origin: "https://ispry.ai" } }), "ispry");
assert(safeBookingUrl("https://forms.example.com/x")?.startsWith("https:"), "book");
assert(safeBookingUrl("javascript:alert(1)") === null, "js");

const req = { headers: { "x-real-ip": "9.9.9.9" } };
let hits = 0;
for (let i = 0; i < 25; i++) {
  if (rateLimitSync(req, { name: "t", limit: 20, windowMs: 60_000 }).ok) hits += 1;
}
assert(hits === 20, `rate sync ${hits}`);

const asyncRl = await rateLimit(req, { name: "t2", limit: 5, windowMs: 60_000 });
assert(asyncRl.ok && asyncRl.backend === "memory", "async memory");

console.log("guard-test: ok");
