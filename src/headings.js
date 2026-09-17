// Likely headings across a whole document, found in the text layer without the AI looking at any
// page: short lines in larger type, numbered headings ("2.1", "Chapter 3", "第二章") and slide titles.
// The assistant turns this short list into a table of contents instead of viewing every page,
// which would cost far more tokens and can overflow the context on long PDFs. No DOM here.

const MAX_TEXT = 120;
const NUMBERED = /^(\d+(\.\d+){0,3}\.?\s|[IVXLC]+\.\s|(chapter|section|part|appendix|unit|lecture|topic|module|lesson)\s+[\dIVXLC]+\b|第\s*[\d一二三四五六七八九十百零]+\s*[章节篇部分讲课单元])/i;

function round(value) {
  return Math.round(value * 10) / 10;
}

// The body text size: the size carrying the most characters in the document.
export function bodyFontSize(pages) {
  const weights = new Map();
  for (const { blocks } of pages) {
    for (const block of blocks) {
      const size = round(block.fontSize);
      weights.set(size, (weights.get(size) || 0) + String(block.text ?? "").length);
    }
  }
  let body = 0;
  let best = -1;
  for (const [size, weight] of weights) {
    if (weight > best) {
      best = weight;
      body = size;
    }
  }
  return body;
}

// `pages` are [{ page, blocks: [{ text, fontSize, lineCount, box: { y } }] }]. Returns the body size,
// the candidates ({ page, size, text }), and whether the list was cut to fit `limit`.
export function headingCandidates(pages, { limit = 500 } = {}) {
  const body = bodyFontSize(pages);
  if (!body) {
    return { bodySize: 0, candidates: [], trimmed: false };
  }
  const candidates = [];
  for (const { page, blocks } of pages) {
    const top = blocks.reduce((min, block) => Math.min(min, block.box?.y ?? Infinity), Infinity);
    for (const block of blocks) {
      const text = String(block.text ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > MAX_TEXT || block.lineCount > 3 || /^\d+$/.test(text)) {
        continue;
      }
      const size = round(block.fontSize);
      const larger = size >= body * 1.15;
      const numbered = NUMBERED.test(text) && size >= body * 0.95 && text.length <= 80;
      // A slide or page title: the first block on the page, set a little larger than the body.
      const title = block.box?.y === top && size >= body * 1.05 && text.length <= 80;
      if (larger || numbered || title) {
        candidates.push({ page, size, text });
      }
    }
  }
  if (candidates.length <= limit) {
    return { bodySize: body, candidates, trimmed: false };
  }
  // Too many for one list: keep the largest type, in reading order.
  const cutoff = candidates.map(entry => entry.size).sort((a, b) => b - a)[limit - 1];
  let atCutoff = limit - candidates.filter(entry => entry.size > cutoff).length;
  const kept = candidates.filter(entry => entry.size > cutoff || (entry.size === cutoff && atCutoff-- > 0));
  return { bodySize: body, candidates: kept, trimmed: true };
}
