// Picks a thinking effort for a question, using TypeSafe's Jev model.
//
// Jev is a "System One" model: instead of writing text it answers typed questions and returns a
// probability for every option, so there is nothing to parse and a hesitant answer is visible as a
// number rather than hidden in prose. The question here is a Choice over the same four levels the
// Thinking menu offers. When the probabilities come out flat, the answer is discarded rather than
// trusted — the effort dial is a convenience, and a wrong guess should never cost more than the
// default would have.
//
// Docs: https://docs.typesafe.ai/primitives/choice

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
// Jev answers in roughly 70–500 ms. Past this the wait costs more than picking well is worth.
const TIMEOUT_MS = 1500;
// Below this the distribution is too flat to act on. See https://docs.typesafe.ai/confidence.
const MIN_CONFIDENCE = 0.5;
// Where an unanswerable or unanswered question lands. Matches the effort the dial ships with.
export const AUTO_FALLBACK = "high";

// Option descriptions are what Jev matches the question against, so they describe the *question*
// that deserves each level, not the level itself.
const EFFORT_CRITERIA = {
  none: "Small talk, greetings, thanks, or a question about the reader's own position in the document (what page am I on). No reasoning required.",
  low: "A direct lookup or restatement: find a fact, define a term, translate a sentence, summarise a short passage, or fill in a form field. The answer is present in the text and needs no working out.",
  high: "Needs real reasoning: explain why something holds, compare or contrast several parts of the document, synthesise across pages, evaluate an argument, or plan a multi-step edit to the PDF.",
  max: "Hard analytical work: follow a mathematical derivation or proof, check a technical argument step by step, debug a contradiction in the source, or reason carefully over many pages at once."
};

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

// Asks Jev which effort level fits. Returns null whenever the answer can't be trusted — no key, a
// failed or slow request, an unknown level, or probabilities too spread out to mean anything — and
// the caller falls back. Never throws: routing must not be able to break sending a message.
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
          effort: { type: "choice", instructions: INSTRUCTIONS, criteria: EFFORT_CRITERIA }
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

  const effort = answer?.choice;
  const confidence = Number(answer?.confidence);
  if (!Object.hasOwn(EFFORT_CRITERIA, effort) || !(confidence >= MIN_CONFIDENCE)) {
    return null;
  }
  return { effort, confidence };
}
