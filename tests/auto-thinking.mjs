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

// The score is a position on the levels, and it rounds up: between two levels, take the more
// thorough one. Only a score of exactly 0 asks for no thinking at all, which is why greetings are
// short-circuited in ai.js rather than left to the model.
{
  for (const [score, effort] of [[0, "none"], [0.01, "low"], [0.4, "low"], [1, "low"], [1.01, "high"], [2, "high"], [2.4, "max"], [3, "max"]]) {
    stubFetch(reply({ type: "score", score, confidence: 0.8 }));
    assert.equal((await ask()).effort, effort, `score ${score}`);
  }
}

// A score spread across two neighbouring levels is an answer, not a failure. Under a Choice this
// read as low confidence and was thrown away; under a Score it is the position between them, and
// rounding up sends the more thorough of the two.
{
  stubFetch(reply({ type: "score", score: 1.45, confidence: 0.18, probabilities: { 1: 0.45, 2: 0.4 } }));
  const answer = await ask();
  assert.equal(answer.effort, "high");
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

// Checks against the assistant's source. These use assert.ok rather than assert.match so a failure
// prints the rule that broke instead of the whole file.
{
  const source = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");
  const has = (pattern, what) => assert.ok(pattern.test(source), what);

  // Auto is resolved once per message, not once per agent step.
  has(/const effort = await resolveEffort\(signal\);\s+for \(let step = 0/, "effort resolved before the agent loop");
  has(/requestTurn\(messages, reply, signal, \{ thinking: effort \}\)/, "resolved effort passed to every turn");

  // Auto needs a key: the stored flag alone never turns it on...
  has(/function autoOn\(\) \{\s+return Boolean\(settings\.autoThinking && settings\.typesafeKey\);/, "autoOn requires a key");
  // ...and without a key its row is not rendered at all.
  has(/settings\.typesafeKey\s*\?\s*`<button type="button" class="effort-auto"/, "Auto pill only rendered with a key");
  // Auto is a switch to assistive tech even though it reads as one word.
  has(/class="effort-auto" role="switch" aria-checked="\$\{auto\}"/, "Auto pill reports its state");
  // It sits at the end of the effort line rather than on a row of its own.
  has(/<span class="effort-title">\$\{escapeHtml\(THINKING_LEVELS\[index\]\[1\]\)\}<\/span>\s*\$\{autoButton\}/, "Auto pill follows the effort on one line");

  // While Auto drives the slider, the slider does not take input.
  has(/event\.button !== 0 \|\| autoOn\(\)/, "pointer input ignored while Auto is on");
  has(/if \(!slider \|\| autoOn\(\) \|\|/, "keyboard input ignored while Auto is on");

  // Instant is a step on the slider again, so every level the score can reach has a word of its own.
  has(/\["none", t\("Instant"\)\], \["low", t\("Low"\)\], \["high", t\("Medium"\)\], \["max", t\("High"\)\]/, "four steps, Instant first");
  // An unrecognised stored level lands on the shipping default, not on the first step.
  has(/settings\.thinking = DEFAULT_SETTINGS\.thinking;/, "unknown stored level falls back to the default");

  // The slider reads faster-to-smarter at its ends rather than leaving the dots unexplained.
  has(/class="effort-ends"/, "slider ends are labelled");
}

console.log("auto thinking effort checks passed");
