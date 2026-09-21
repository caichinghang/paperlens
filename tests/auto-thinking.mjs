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

const ask = () => chooseThinkingEffort({ key: "ts-test", question: "Why does the proof hold?" });

// The score is a position on the levels, so the nearest level is the one to send.
{
  for (const [score, effort] of [[0, "none"], [0.4, "none"], [0.6, "low"], [1, "low"], [2.4, "high"], [2.6, "max"], [3, "max"]]) {
    stubFetch(reply({ type: "score", score, confidence: 0.8 }));
    assert.equal((await ask()).effort, effort, `score ${score}`);
  }
}

// A score spread across two neighbouring levels is an answer, not a failure. Under a Choice this
// read as low confidence and was thrown away; under a Score it is the position between them.
{
  stubFetch(reply({ type: "score", score: 1.45, confidence: 0.18, probabilities: { 1: 0.45, 2: 0.4 } }));
  const answer = await ask();
  assert.equal(answer.effort, "low");
  assert.equal(answer.score, 1.45);
  assert.equal(answer.confidence, 0.18);
}

// A confused answer needs no threshold: a flat distribution averages to the middle of the scale,
// and the middle of these four levels rounds to exactly the level a failed request falls back to.
// Acting on a low-confidence score therefore costs nothing that discarding it would have saved.
{
  stubFetch(reply({ type: "score", score: 1.5, confidence: 0.02 }));
  assert.equal((await ask()).effort, AUTO_FALLBACK);
}

// The request carries the question, the model and an ordered Score, and never any page text.
{
  calls.length = 0;
  stubFetch(reply({ type: "score", score: 1, confidence: 0.8 }));
  await chooseThinkingEffort({
    key: "ts-test",
    question: "Define the term on page 3",
    context: { documentName: "paper.pdf", attachedPages: 2, followUp: true, allowEdits: false }
  });
  const [call] = calls;
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.options.headers.Authorization, "Bearer ts-test");
  assert.equal(call.body.model, "jev-latest");

  const question = call.body.questions.effort;
  assert.equal(question.type, "score");
  // Criteria are an ordered array for a Score, lowest level first, within the 2–10 the API allows.
  assert.ok(Array.isArray(question.criteria));
  assert.equal(question.criteria.length, 4);
  assert.ok(question.criteria.length >= 2 && question.criteria.length <= 10);
  assert.ok(question.criteria.every(level => typeof level === "string" && level.length > 0));
  // Each level stands on its own, so none of them points at its neighbours.
  assert.ok(!question.criteria.some(level => /\b(previous|next|above|below|harder than|easier than)\b/i.test(level)));

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

// A score outside the levels is clamped rather than dropped; a missing or unreadable one falls back.
{
  stubFetch(reply({ type: "score", score: 9, confidence: 0.9 }));
  assert.equal((await ask()).effort, "max");

  stubFetch(reply({ type: "score", score: -2, confidence: 0.9 }));
  assert.equal((await ask()).effort, "none");

  stubFetch(reply({ type: "score", confidence: 0.9 }));
  assert.equal(await ask(), null);

  stubFetch(reply({ type: "score", score: "not a number", confidence: 0.9 }));
  assert.equal(await ask(), null);
}

// Transport and server failures fall through quietly; they must never break sending a message.
{
  stubFetch(() => { throw new Error("offline"); });
  assert.equal(await ask(), null);

  stubFetch(reply({ type: "score", score: 2, confidence: 0.9 }, { ok: false, status: 429 }));
  assert.equal(await ask(), null);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
  assert.equal(await ask(), null);
}

// No key and no question mean no request at all.
{
  calls.length = 0;
  stubFetch(reply({ type: "score", score: 2, confidence: 0.9 }));
  assert.equal(await chooseThinkingEffort({ key: "", question: "Why?" }), null);
  assert.equal(await chooseThinkingEffort({ key: "ts-test", question: "   " }), null);
  assert.equal(calls.length, 0);
}

// The fallback is one of the levels the slider offers.
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
  // Every level the score can round to has a word for the label, including the one the slider dropped.
  assert.match(source, /const EFFORT_LABELS = \{ none: t\("Instant"\), \.\.\.Object\.fromEntries\(THINKING_LEVELS\) \};/);
}

console.log("auto thinking effort checks passed");
