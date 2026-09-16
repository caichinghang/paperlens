// To-dos live on a notebook page as ordinary to-do blocks, one line per action with the page it
// came from as a [p. 3] citation. These helpers add to and read that page. No DOM here.

import { createBlock, inlineToPlain } from "./blocks.js";

const CITATION = /\s*\[pp?\.\s*(\d+)(?:\s*[-–]\s*\d+)?\]\s*$/i;
const MAX_TEXT = 300;

function isBlank(block) {
  return block.type === "paragraph" && !String(block.text ?? "").trim();
}

function textKey(text) {
  return inlineToPlain(String(text ?? "").replace(CITATION, "")).trim().replace(/\s+/g, " ").toLowerCase();
}

// Appends new to-do blocks after the page's last to-do (or at the end). An item already on the page
// and not yet ticked is skipped, so the assistant can repeat itself without doubling the list.
export function mergeTodos(blocks, items) {
  const next = (Array.isArray(blocks) ? blocks : []).filter(block => !isBlank(block));
  const open = new Set(next.filter(block => block.type === "todo" && !block.checked).map(block => textKey(block.text)));
  const added = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.text ?? "").replace(/\s*\n\s*/g, " ").trim().slice(0, MAX_TEXT);
    const key = textKey(text);
    if (!key || (open.has(key) && !item.done)) {
      continue;
    }
    const page = Number(item.page);
    const citation = Number.isInteger(page) && page > 0 && !CITATION.test(text) ? ` [p. ${page}]` : "";
    added.push(createBlock("todo", { text: `${text}${citation}`, checked: Boolean(item.done) }));
    if (!item.done) {
      open.add(key);
    }
  }
  if (added.length) {
    let last = -1;
    next.forEach((block, index) => {
      if (block.type === "todo") last = index;
    });
    next.splice(last < 0 ? next.length : last + 1, 0, ...added);
  }
  return { blocks: next, added };
}

// The to-dos on a page, for the assistant: plain text, linked page and whether it's ticked.
export function readTodos(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter(block => block.type === "todo" && String(block.text ?? "").trim())
    .map(block => {
      const match = String(block.text).match(CITATION);
      return {
        text: inlineToPlain(String(block.text).replace(CITATION, "")).trim(),
        page: match ? Number(match[1]) : null,
        done: Boolean(block.checked)
      };
    });
}
