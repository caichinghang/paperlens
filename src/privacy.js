// Private profile details (the closed eye) never reach the AI. The assistant gets a token such as
// {{profile:idNumber}} in their place and passes it back to fill a form; the viewer swaps the real
// value in locally. Everything on its way to the AI is masked the other way: a private value that
// shows up in a tool result or a message becomes its token again. No DOM here.

const TOKEN = /\{\{profile:([A-Za-z0-9_-]+)\}\}/g;
// Values this short are matched exactly; longer ones also match with spacing and punctuation changed.
const MIN_LOOSE_LENGTH = 4;
const SEPARATORS = "[\\s\\-–—_.·/()（）]*";

export function profileToken(id) {
  return `{{profile:${id}}}`;
}

export function hasToken(text) {
  TOKEN.lastIndex = 0;
  return TOKEN.test(String(text ?? ""));
}

// Replaces tokens with their values. `lookup(id)` returns { label, value } for a profile field.
// Returns the text, the labels that were filled, and the ids with nothing to fill.
export function fillTokens(text, lookup) {
  const used = [];
  const missing = [];
  const filled = String(text ?? "").replace(TOKEN, (token, id) => {
    const field = lookup(id);
    const value = String(field?.value ?? "").trim();
    if (!value) {
      missing.push(id);
      return token;
    }
    used.push(field.label || id);
    return value;
  });
  return { text: filled, used, missing };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One pattern per private value: the exact text, and for longer values the same letters and digits
// with any spacing, dashes, dots or brackets between them ("A123456(7)" also catches "A 123 456 7").
// Latin letters and digits only count when they stand alone, so a private "Li" doesn't mask "Link";
// Chinese text has no spaces between words, so it matches anywhere.
function secretPattern(value) {
  const exact = escapeRegExp(value);
  const chars = Array.from(value).filter(character => /[\p{L}\p{N}]/u.test(character));
  const body = chars.length < MIN_LOOSE_LENGTH ? exact : `${exact}|${chars.map(escapeRegExp).join(SEPARATORS)}(?:\\s*[)）])?`;
  const before = /[A-Za-z0-9]/.test(chars[0] ?? "") ? "(?<![A-Za-z0-9])" : "";
  const after = /[A-Za-z0-9]/.test(chars.at(-1) ?? "") ? "(?![A-Za-z0-9])" : "";
  return `${before}(?:${body})${after}`;
}

export function compileSecrets(secrets) {
  return (Array.isArray(secrets) ? secrets : [])
    .map(secret => ({ ...secret, value: String(secret?.value ?? "").trim() }))
    .filter(secret => secret.id && secret.value)
    .sort((a, b) => b.value.length - a.value.length)
    .map(secret => ({ ...secret, pattern: new RegExp(secretPattern(secret.value), "giu") }));
}

// `secrets` are [{ id, label, value }] or already compiled; `replace` decides what stands in.
export function maskText(text, secrets, replace = secret => profileToken(secret.id)) {
  let masked = String(text ?? "");
  for (const secret of secrets[0]?.pattern ? secrets : compileSecrets(secrets)) {
    masked = masked.replace(secret.pattern, () => replace(secret));
  }
  return masked;
}

// Masks every string inside a tool result or a request. Image data URLs are left alone: the page
// images are masked when they are drawn.
export function maskDeep(value, secrets) {
  const compiled = secrets[0]?.pattern ? secrets : compileSecrets(secrets);
  if (!compiled.length) {
    return value;
  }
  const visit = item => {
    if (typeof item === "string") {
      return item.startsWith("data:") ? item : maskText(item, compiled);
    }
    if (Array.isArray(item)) {
      return item.map(visit);
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    }
    return item;
  };
  return visit(value);
}
