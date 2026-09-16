// Blank lines drawn on a page (signature lines, "Date: ______", table rules) and snapping to them.
// Forms print these as vector strokes rather than text, so the assistant can't find them in the
// text layer; the viewer collects them from the drawing commands and these helpers line text and
// signatures up so they sit on the line instead of floating above it or crossing it.
// Everything is in page units with y growing downwards. No DOM here.

const MIN_RULE_LENGTH = 24;
const MAX_RULE_THICKNESS = 3;
// How far below a text box's top its glyphs end, in font sizes, when the viewer can't measure it
// (markup draws text from a "top" baseline with a little leading above the glyphs).
const GLYPH_DEPTH = 0.96;

// Flat or nearly flat boxes (stroked lines, hairline rectangles) become rules; pieces on the same
// line that touch are merged, so a line drawn in segments counts once.
export function collectRules(boxes) {
  const flat = (Array.isArray(boxes) ? boxes : [])
    .filter(box => box && box.x2 - box.x1 >= MIN_RULE_LENGTH && Math.abs(box.y2 - box.y1) <= MAX_RULE_THICKNESS)
    .map(box => ({ x1: Math.min(box.x1, box.x2), x2: Math.max(box.x1, box.x2), y: (box.y1 + box.y2) / 2 }))
    .sort((a, b) => a.y - b.y || a.x1 - b.x1);
  const rules = [];
  for (const rule of flat) {
    const last = rules.at(-1);
    if (last && Math.abs(last.y - rule.y) <= 1 && rule.x1 <= last.x2 + 2) {
      last.x2 = Math.max(last.x2, rule.x2);
    } else {
      rules.push({ ...rule });
    }
  }
  return rules;
}

// A single line of text placed on or near a blank line: returns the top y that leaves its glyphs a
// small gap above the line, or null when no line is close enough to mean "write on this line".
// `depth` is how far below the top the glyphs end, in page units.
export function snapTextToRule(rules, { x, y, fontSize, lineCount = 1, depth = fontSize * GLYPH_DEPTH }) {
  if (lineCount !== 1 || !(fontSize > 0)) {
    return null;
  }
  const baseline = y + depth;
  let best = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const startsOnLine = x >= rule.x1 - fontSize && x <= rule.x2 - fontSize;
    const near = rule.y >= y + fontSize * 0.2 && rule.y <= baseline + fontSize * 1.1;
    if (startsOnLine && near && (!best || Math.abs(rule.y - baseline) < Math.abs(best.y - baseline))) {
      best = rule;
    }
  }
  if (!best) {
    return null;
  }
  const gap = Math.max(2, fontSize * 0.3);
  return Math.round((best.y - gap - depth) * 100) / 100;
}

// A signature box over (or just above) a signature line: moved so its bottom rests on the line.
// Returns the box unchanged when no line runs under it.
export function snapBoxToRule(rules, box) {
  const centerX = box.x + box.width / 2;
  let best = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const under = centerX >= rule.x1 && centerX <= rule.x2 && rule.x2 - rule.x1 >= box.width * 0.4;
    const near = rule.y >= box.y + box.height * 0.2 && rule.y <= box.y + box.height * 1.6;
    if (under && near && (!best || Math.abs(rule.y - (box.y + box.height)) < Math.abs(best.y - (box.y + box.height)))) {
      best = rule;
    }
  }
  return best ? { ...box, y: Math.round((best.y - 1 - box.height) * 100) / 100 } : box;
}
