import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTO_FALLBACK, chooseThinkingEffort } from "../src/typesafe.js";

const calls = [];

function stubFetch(handler) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return handler();
  };
}

function reply(answer, { ok = true, status = 200 } = {}) {
  return () => ({ ok, status, json: async () => ({ answers: { effort: answer } }) });
}

const ask = extra => chooseThinkingEffort({ key: "ts-test", question: "Why does the proof hold?", ...extra });

// A confident answer is used as-is.
{
  stubFetch(reply({ type: "choice", choice: "max", confidence: 0.93 }));
  assert.deepEqual(await ask(), { effort: "max", confidence: 0.93 });
}

// The request carries the question, the model and the Choice, and never any page text.
{
  calls.length = 0;
  stubFetch(reply({ choice: "low", confidence: 0.8 }));
  await chooseThinkingEffort({
    key: "ts-test",
    question: "Define the term on page 3",
    context: { documentName: "paper.pdf", attachedPages: 2, followUp: true, allowEdits: false }
  });
  const [call] = calls;
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.options.headers.Authorization, "Bearer ts-test");
  assert.equal(call.body.model, "jev-latest");
  assert.equal(call.body.questions.effort.type, "choice");
  assert.deepEqual(Object.keys(call.body.questions.effort.criteria), ["none", "low", "high", "max"]);
  assert.equal(call.body.state.question, "Define the term on page 3");
  assert.equal(call.body.state.document, "paper.pdf");
  assert.equal(call.body.state.attached_pages, 2);
  assert.equal(call.body.state.follow_up, true);
  // The state is the question and its framing only.
  assert.deepEqual(
    Object.keys(call.body.state).sort(),
    ["attached_pages", "can_edit_pdf", "document", "follow_up", "question"]
  );
}

// A spread-out distribution is not worth acting on.
{
  stubFetch(reply({ choice: "high", confidence: 0.31 }));
  assert.equal(await ask(), null);
}

// Neither is a level the Thinking menu doesn't have.
{
  stubFetch(reply({ choice: "extreme", confidence: 0.99 }));
  assert.equal(await ask(), null);
}

// A missing confidence is treated as no answer rather than as zero-risk.
{
  stubFetch(reply({ choice: "high" }));
  assert.equal(await ask(), null);
}

// Transport and server failures fall through quietly; they must never break sending a message.
{
  stubFetch(() => { throw new Error("offline"); });
  assert.equal(await ask(), null);

  stubFetch(reply({ choice: "high", confidence: 0.9 }, { ok: false, status: 429 }));
  assert.equal(await ask(), null);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
  assert.equal(await ask(), null);
}

// No key and no question mean no request at all.
{
  calls.length = 0;
  stubFetch(reply({ choice: "high", confidence: 0.9 }));
  assert.equal(await chooseThinkingEffort({ key: "", question: "Why?" }), null);
  assert.equal(await chooseThinkingEffort({ key: "ts-test", question: "   " }), null);
  assert.equal(calls.length, 0);
}

// The fallback is one of the levels the menu offers.
assert.equal(AUTO_FALLBACK, "high");

// Auto is resolved once per message, not once per agent step.
{
  const source = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");
  assert.match(source, /const effort = await resolveEffort\(signal\);\s+for \(let step = 0/);
  assert.match(source, /requestTurn\(messages, reply, signal, \{ thinking: effort \}\)/);

  // Auto needs a key: the stored flag alone never turns it on.
  assert.match(source, /function autoOn\(\) \{\s+return Boolean\(settings\.autoThinking && settings\.typesafeKey\);/);
  // ...and without a key the switch is not even rendered.
  assert.match(source, /settings\.typesafeKey\s*\?\s*`<div class="effort-head">/);
  // While Auto drives the slider, the slider does not take input.
  assert.match(source, /event\.button !== 0 \|\| autoOn\(\)/);
  assert.match(source, /if \(!slider \|\| autoOn\(\) \|\|/);
  // "none" is off the slider, so it rests at the lowest step rather than breaking the index.
  assert.match(source, /Math\.max\(0, THINKING_LEVELS\.findIndex/);
}

// Every level Auto can return has a word for the label, including the one the slider dropped.
{
  const source = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");
  assert.match(source, /const EFFORT_LABELS = \{ none: t\("Instant"\), \.\.\.Object\.fromEntries\(THINKING_LEVELS\) \};/);
}

console.log("auto thinking effort checks passed");
