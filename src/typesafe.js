// Picks a reasoning effort for a question, using TypeSafe's Jev model.
//
// Jev is a "System One" model: instead of writing text it answers typed questions and returns
// probabilities, so there is nothing to parse. The question here is a Score, not a Choice, because
// effort is ordered — a Choice would treat "Instant" and "High" as unrelated categories and have to
// commit to one box, while a Score returns a probability-weighted position along the levels. That
// matters for the common case: when Jev spreads its answer across two neighbouring levels, a Choice
// reads as low confidence, but a Score reads as "between these two", which is the useful answer.
//
// Because the answer is a position, a confused answer degrades on its own: a flat distribution
// averages to the middle of the scale, which is where an unanswerable question should land anyway.
// So there is no confidence threshold here. Only a failed request falls back.
//
// Docs: https://docs.typesafe.ai/primitives/score

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
// Jev answers in roughly 70–500 ms. Past this the wait costs more than picking well is worth.
const TIMEOUT_MS = 1500;
// Where an unanswered question lands. Matches the effort the slider ships with.
export const AUTO_FALLBACK = "high";

// The levels in order, low to high, as the API values the assistant sends on. The reader sees these
// as Instant, Low, Medium and High.
const EFFORT_LEVELS = ["none", "low", "high", "max"];

// One description per level, in the same order. Each describes the *question* that deserves that
// level, not the level itself, and stands on its own: Jev reads them independently, so none of them
// refers to the ones around it.
const EFFORT_CRITERIA = [
  "Small talk, greetings, thanks, or a question about the reader's own position in the document (what page am I on). No reasoning required.",
  "A direct lookup or restatement: find a fact, define a term, translate a sentence, summarise a short passage, or fill in a form field. The answer is present in the text and needs no working out.",
  "Needs real reasoning: explain why something holds, compare or contrast several parts of the document, synthesise across pages, evaluate an argument, or plan a multi-step edit to the PDF.",
  "Hard analytical work: follow a mathematical derivation or proof, check a technical argument step by step, debug a contradiction in the source, or reason carefully over many pages at once."
];

const INSTRUCTIONS = [
  "A reader is asking an AI assistant a question about a PDF they have open.",
  "How much reasoning effort should the assistant spend before answering?",
  "Judge the difficulty of the question itself, not how politely or briefly it is phrased."
].join(" ");

// Combines the caller's abort signal with our own deadline, so a cancelled message stops the
// routing call too. AbortSignal.any landed in Chrome 116; older builds just use the timeout.
function deadline(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) {
    return timeout;
  }
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout;
}

// Asks Jev how much reasoning the question deserves. Returns null whenever there is no answer to
// act on — no key, or a request that failed, timed out or came back unreadable — and the caller
// falls back. Never throws: routing must not be able to break sending a message.
export async function chooseThinkingEffort({ key, question, context = {}, signal } = {}) {
  if (!key || !question?.trim()) {
    return null;
  }

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      signal: deadline(signal),
      body: JSON.stringify({
        model: MODEL,
        // Only the question and a little framing — never page text. It keeps the call fast and
        // cheap, and keeps the document itself out of a service that isn't answering about it.
        state: {
          question: question.trim().slice(0, 2000),
          document: context.documentName || "",
          attached_pages: context.attachedPages || 0,
          follow_up: Boolean(context.followUp),
          can_edit_pdf: Boolean(context.allowEdits)
        },
        questions: {
          effort: { type: "score", instructions: INSTRUCTIONS, criteria: EFFORT_CRITERIA }
        }
      })
    });
  } catch {
    // Aborted, timed out, or offline.
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let answer;
  try {
    answer = (await response.json())?.answers?.effort;
  } catch {
    return null;
  }

  // `score` is the probability-weighted position on the levels, so it usually falls between them.
  // The nearest level is the one to send.
  const score = Number(answer?.score);
  if (!Number.isFinite(score)) {
    return null;
  }
  const index = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(score)));
  return { effort: EFFORT_LEVELS[index], score, confidence: Number(answer?.confidence) };
}
