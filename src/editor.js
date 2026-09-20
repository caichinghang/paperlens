// A Notion-style block editor for notebook pages. Every block edits in place: "/" picks a block
// type, Markdown shortcuts ("# ", "- ", "[] ") convert as you type, selected text gets a format bar,
// and the handle beside a block drags it or opens its options. Blocks keep inline Markdown as text.

import { createBlock, escapeInline, inlineToHtml, inlineToPlain, LIST_TYPES, listNumbers, markdownToBlocks, matchMath, MAX_INDENT, TEXT_TYPES } from "./blocks.js";
import { renderTex } from "./math.js";
import { t, tn } from "./i18n.js";
import { popupNearCaret } from "./popup-position.js";

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const EDITOR_ICONS = {
  plus: svg('<path d="M12 5v14M5 12h14"></path>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"></circle><circle cx="15" cy="6" r="1.2"></circle><circle cx="9" cy="12" r="1.2"></circle><circle cx="15" cy="12" r="1.2"></circle><circle cx="9" cy="18" r="1.2"></circle><circle cx="15" cy="18" r="1.2"></circle>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"></path>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path>'),
  trash: svg('<path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"></path>'),
  chevron: svg('<path d="m6 9 6 6 6-6"></path>'),
  text: svg('<path d="M5 6h14M12 6v13"></path>'),
  h1: svg('<path d="M4 6v12M12 6v12M4 12h8"></path><path d="M17 10l2.5-2V18"></path>'),
  h2: svg('<path d="M4 6v12M12 6v12M4 12h8"></path><path d="M16 10a2.5 2.5 0 0 1 5 .5c0 2-5 4.5-5 7.5h5"></path>'),
  h3: svg('<path d="M4 6v12M12 6v12M4 12h8"></path><path d="M16 8h4.5l-2.5 3.5a2.6 2.6 0 1 1-2.2 4.3"></path>'),
  bullet: svg('<circle cx="5" cy="7" r="1"></circle><circle cx="5" cy="12" r="1"></circle><circle cx="5" cy="17" r="1"></circle><path d="M10 7h10M10 12h10M10 17h10"></path>'),
  numbered: svg('<path d="M10 7h10M10 12h10M10 17h10"></path><path d="M4 5.5 5.5 5v4M4 14.5a1.5 1.5 0 0 1 3 0c0 1-3 2-3 3.5h3"></path>'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m8.5 12 2.5 2.5 5-5"></path>'),
  quote: svg('<path d="M5 5v14"></path><path d="M10 8h9M10 12h9M10 16h6"></path>'),
  callout: svg('<path d="M9 18h6M10 21h4"></path><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"></path>'),
  divider: svg('<path d="M4 12h16"></path><path d="M8 6h8M8 18h8" opacity=".45"></path>'),
  code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"></path>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M3 15h18M9 4v16"></path>'),
  flashcards: svg('<rect x="3" y="7" width="14" height="14" rx="2"></rect><path d="M7 3h12a2 2 0 0 1 2 2v12"></path>'),
  bold: svg('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"></path>'),
  italic: svg('<path d="M14 5h-4M14 19h-4M14 5l-4 14"></path>'),
  strike: svg('<path d="M5 12h14"></path><path d="M16 7.5C15.4 6 14 5 12 5c-2.5 0-4 1.3-4 3 0 1.4 1 2.3 2.5 2.8M8 16.5c.6 1.5 2 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.6-.2-1.2-.5-1.6"></path>'),
  inlineCode: svg('<path d="m9 8-4 4 4 4M15 8l4 4-4 4"></path>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path>'),
  page: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M9 13h6M9 17h4"></path>')
};

const BLOCK_TYPES = [
  { type: "paragraph", label: "Text", hint: "Plain writing", icon: "text", keys: "text paragraph plain 正文 文本 段落" },
  { type: "heading1", label: "Heading 1", hint: "Large section heading", icon: "h1", keys: "h1 heading title 标题 一级" },
  { type: "heading2", label: "Heading 2", hint: "Medium section heading", icon: "h2", keys: "h2 heading subtitle 标题 副标题 二级" },
  { type: "heading3", label: "Heading 3", hint: "Small section heading", icon: "h3", keys: "h3 heading 标题 三级 小标题" },
  { type: "bullet", label: "Bulleted list", hint: "A simple list", icon: "bullet", keys: "ul bullet list 列表 无序" },
  { type: "numbered", label: "Numbered list", hint: "A list with numbers", icon: "numbered", keys: "ol numbered ordered list 有序 编号 列表" },
  { type: "todo", label: "To-do list", hint: "Items you can tick off", icon: "todo", keys: "todo task check checkbox 待办 勾选 复选" },
  { type: "quote", label: "Quote", hint: "A quotation", icon: "quote", keys: "quote blockquote 引用 引述" },
  { type: "callout", label: "Callout", hint: "Make something stand out", icon: "callout", keys: "callout note tip highlight 提示 标注 重点" },
  { type: "divider", label: "Divider", hint: "Separate sections", icon: "divider", keys: "hr divider line rule 分割线 分隔" },
  { type: "table", label: "Table", hint: "Rows and columns", icon: "table", keys: "table grid 表格" },
  { type: "code", label: "Code", hint: "Code or preformatted text", icon: "code", keys: "code pre snippet 代码" },
  { type: "flashcards", label: "Flashcards", hint: "Questions and answers", icon: "flashcards", keys: "flashcards cards anki quiz 抽认卡 卡片 问答" }
];

const PLACEHOLDERS = {
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bullet: "List",
  numbered: "List",
  todo: "To-do",
  quote: "Quote",
  callout: "Callout"
};

const SHORTCUTS = [
  [/^#\s$/, "heading1"],
  [/^##\s$/, "heading2"],
  [/^###\s$/, "heading3"],
  [/^[-*+•]\s$/, "bullet"],
  [/^1[.)]\s$/, "numbered"],
  [/^\[\s?\]\s$/, "todo"],
  [/^\[x\]\s$/i, "todo"],
  [/^>\s$/, "quote"],
  [/^```$/, "code"]
];

const EDITABLE = ".be-text, .be-code, [data-cell], [data-card], .be-divider";
const INLINE_EDITABLE = ".be-text, [data-cell], [data-card]";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function citeLabel(inner, page) {
  return /^(?:p\.|page)\s*\d+$/i.test(inner) ? t("p. {page}", { page }) : inner;
}

function textHtml(markdown) {
  const html = inlineToHtml(markdown, { citeLabel, renderMath: ({ tex, display }) => renderTex(tex, display) });
  // A trailing line break needs a second <br> to show as an empty line.
  return markdown.endsWith("\n") ? `${html}<br>` : html;
}

// ---------- DOM ↔ inline Markdown ----------

function isAtom(node) {
  return node.nodeType === 1 && (node.tagName === "BR" || node.classList.contains("be-cite") || node.classList.contains("be-math"));
}

function nodeLength(node) {
  if (node.nodeType === 3) {
    return node.nodeValue.length;
  }
  if (isAtom(node)) {
    return 1;
  }
  let length = 0;
  for (const child of node.childNodes || []) {
    length += nodeLength(child);
  }
  return length;
}

function textLength(element) {
  return Math.max(0, nodeLength(element) - (element.lastChild?.tagName === "BR" ? 1 : 0));
}

function wrap(inner, mark) {
  const match = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : inner;
}

// Typed text is escaped as Markdown, except TeX typed between math delimiters, which keeps its backslashes.
function escapeText(text) {
  let markdown = "";
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const math = (text[index] === "$" || text[index] === "\\") && matchMath(text, index);
    if (math) {
      markdown += escapeInline(text.slice(from, index)) + math.raw;
      from = math.end;
      index = math.end - 1;
    }
  }
  return markdown + escapeInline(text.slice(from));
}

function serializeNode(node) {
  if (node.nodeType === 3) {
    return escapeText(node.nodeValue.replace(/​/g, "").replace(/ /g, " "));
  }
  if (node.nodeType !== 1) {
    return "";
  }
  if (node.tagName === "BR") {
    return "\n";
  }
  if (node.classList.contains("be-cite") || node.classList.contains("be-math")) {
    return node.dataset.md || "";
  }
  const inner = serializeChildren(node);
  const tag = node.tagName;
  if (tag === "B" || tag === "STRONG" || /^(bold|[6-9]00)$/.test(node.style?.fontWeight || "")) {
    return wrap(inner, "**");
  }
  if (tag === "I" || tag === "EM" || node.style?.fontStyle === "italic") {
    return wrap(inner, "*");
  }
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") {
    return wrap(inner, "~~");
  }
  if (tag === "CODE") {
    const code = node.textContent.replace(/`/g, "");
    return code ? `\`${code}\`` : "";
  }
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    return /^https?:\/\//i.test(href) && inner.trim() ? `[${inner}](${href})` : inner;
  }
  if ((tag === "DIV" || tag === "P") && node.previousSibling) {
    return `\n${inner}`;
  }
  return inner;
}

function serializeChildren(parent) {
  let markdown = "";
  for (const child of parent.childNodes) {
    markdown += serializeNode(child);
  }
  return markdown;
}

function serializeEditable(element) {
  const markdown = serializeChildren(element);
  return element.lastChild?.tagName === "BR" ? markdown.replace(/\n$/, "") : markdown;
}

function plainLength(markdown) {
  const holder = document.createElement("div");
  holder.innerHTML = inlineToHtml(markdown);
  return nodeLength(holder);
}

// ---------- Caret ----------

function caretOffset(element) {
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    return 0;
  }
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return 0;
  }
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return nodeLength(before.cloneContents());
}

function positionAt(element, offset) {
  let remaining = Math.max(0, offset);
  let position = null;
  const walk = node => {
    for (const child of node.childNodes) {
      if (position) {
        return;
      }
      if (child.nodeType === 3) {
        if (remaining <= child.nodeValue.length) {
          position = { node: child, offset: remaining };
          return;
        }
        remaining -= child.nodeValue.length;
      } else if (isAtom(child)) {
        if (remaining === 0) {
          position = { node: child.parentNode, offset: [...child.parentNode.childNodes].indexOf(child) };
          return;
        }
        remaining -= 1;
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(element);
  if (!position) {
    const count = element.childNodes.length;
    position = { node: element, offset: element.lastChild?.tagName === "BR" ? count - 1 : count };
  }
  return position;
}

function setCaret(element, offset) {
  const { node, offset: at } = positionAt(element, offset);
  const range = document.createRange();
  range.setStart(node, Math.max(0, at));
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretRect() {
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    return null;
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length && rects[0].height > 0 && rects[0].bottom > 0) return rects[0];
  const node = range.startContainer;
  const offset = range.startOffset;
  if (node.nodeType === 3 && node.nodeValue?.length) {
    const start = offset > 0 ? offset - 1 : 0;
    const end = Math.min(node.nodeValue.length, start + 1);
    range.setStart(node, start);
    range.setEnd(node, end);
    const character = range.getClientRects();
    if (character.length) {
      const box = character[character.length - 1];
      const x = offset > 0 ? box.right : box.left;
      return { left: x, right: x, top: box.top, bottom: box.bottom, width: 0, height: box.height };
    }
  }
  return null;
}

function lineCheck(element, edge) {
  const length = textLength(element);
  const offset = caretOffset(element);
  if (!length || (edge === "top" && offset === 0) || (edge === "bottom" && offset >= length)) {
    return true;
  }
  const rect = caretRect();
  if (!rect) {
    return false;
  }
  const box = element.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 22;
  return edge === "top" ? rect.top - box.top < lineHeight * 0.75 : box.bottom - rect.bottom < lineHeight * 0.75;
}

function selectionIsCollapsed() {
  const selection = window.getSelection();
  return !selection.rangeCount || selection.isCollapsed;
}

// ---------- Drag to reorder (shared with the to-do list) ----------

export function attachSortable(container, { items, handle, onMove, onClick }) {
  const onPointerDown = event => {
    const grip = event.target.closest?.(handle);
    if (!grip || event.button !== 0 || !container.contains(grip)) {
      return;
    }
    const item = grip.closest(items);
    if (!item) {
      return;
    }
    event.preventDefault();
    const list = item.parentElement;
    const startY = event.clientY;
    const scroller = container.closest(".nb-main, .workspace-body") || container;
    const indicator = document.createElement("div");
    indicator.className = "be-drop";
    let dragging = false;
    let before = undefined;

    const move = moveEvent => {
      if (!dragging && Math.abs(moveEvent.clientY - startY) > 4) {
        dragging = true;
        item.classList.add("is-dragging");
        document.body.classList.add("is-block-sorting");
        list.append(indicator);
      }
      if (!dragging) {
        return;
      }
      const siblings = [...list.children].filter(child => child.matches(items));
      before = siblings.find(sibling => moveEvent.clientY < sibling.getBoundingClientRect().top + sibling.offsetHeight / 2) || null;
      const listBox = list.getBoundingClientRect();
      const y = before ? before.getBoundingClientRect().top : siblings.at(-1).getBoundingClientRect().bottom;
      indicator.style.top = `${y - listBox.top - 1}px`;
      const box = scroller.getBoundingClientRect();
      if (moveEvent.clientY < box.top + 40) {
        scroller.scrollTop -= 12;
      } else if (moveEvent.clientY > box.bottom - 40) {
        scroller.scrollTop += 12;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      indicator.remove();
      item.classList.remove("is-dragging");
      document.body.classList.remove("is-block-sorting");
      if (!dragging) {
        onClick?.(item, grip);
      } else if (before !== undefined && before !== item && before !== item.nextElementSibling) {
        onMove(item, before);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  container.addEventListener("pointerdown", onPointerDown);
  return () => container.removeEventListener("pointerdown", onPointerDown);
}

// ---------- Editor ----------

export function createBlockEditor({ root, blocks: initialBlocks, onChange, onCite, onExitTop, toast, getCurrentPage }) {
  let blocks = Array.isArray(initialBlocks) && initialBlocks.length ? initialBlocks : [createBlock()];
  const undoStack = [];
  const redoStack = [];
  let lastInputAt = 0;
  let menu = null;
  let toolbar = null;
  let pagePicker = null;
  let selecting = false;
  let selectionFrame = 0;
  let lastCell = null;

  root.classList.add("be");

  const indexOf = id => blocks.findIndex(block => block.id === id);
  const blockFor = element => {
    const id = element?.closest?.("[data-id]")?.dataset.id;
    const index = indexOf(id);
    return index < 0 ? null : { block: blocks[index], index };
  };

  function emit() {
    root.classList.toggle("is-blank", blocks.length === 1 && blocks[0].type === "paragraph" && !blocks[0].text);
    onChange?.(blocks);
  }

  // ---------- History ----------

  function snapshot() {
    const active = document.activeElement;
    let focus = null;
    if (active && root.contains(active)) {
      const id = active.closest("[data-id]")?.dataset.id;
      focus = id ? { id, offset: active.isContentEditable ? caretOffset(active) : "end" } : null;
    }
    return { blocks: JSON.stringify(blocks), focus };
  }

  function record() {
    const state = snapshot();
    if (undoStack.at(-1)?.blocks !== state.blocks) {
      undoStack.push(state);
      if (undoStack.length > 200) {
        undoStack.shift();
      }
    }
    redoStack.length = 0;
    lastInputAt = 0;
  }

  function travel(from, to) {
    const state = from.pop();
    if (!state) {
      return;
    }
    to.push(snapshot());
    blocks = JSON.parse(state.blocks);
    render(state.focus);
    emit();
  }

  // ---------- Rendering ----------

  function gutter() {
    return `<div class="be-gutter">
      <button type="button" class="be-gutter-button" data-be="add" tabindex="-1" title="${escapeHtml(t("Click to add a block below"))}">${EDITOR_ICONS.plus}</button>
      <button type="button" class="be-gutter-button be-grip" data-be="handle" tabindex="-1" title="${escapeHtml(t("Drag to move · click for options"))}">${EDITOR_ICONS.grip}</button>
    </div>`;
  }

  function editableText(block, attributes = "") {
    const placeholder = t(PLACEHOLDERS[block.type] || "Type “/” for blocks");
    return `<div class="be-text" contenteditable="true" data-placeholder="${escapeHtml(placeholder)}"${attributes}>${textHtml(block.text || "")}</div>`;
  }

  function tableHtml(block) {
    const rows = block.rows?.length ? block.rows : [[""]];
    const cell = (value, row, col) => `<div class="be-cell" contenteditable="true" data-cell data-row="${row}" data-col="${col}">${textHtml(value || "")}</div>`;
    return `<div class="be-table">
      <div class="be-table-scroll"><table>
        <thead><tr>${rows[0].map((value, col) => `<th>${cell(value, 0, col)}</th>`).join("")}</tr></thead>
        <tbody>${rows.slice(1).map((row, index) => `<tr>${row.map((value, col) => `<td>${cell(value, index + 1, col)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <button type="button" class="be-table-add is-row" data-be="add-row" tabindex="-1" title="${escapeHtml(t("Add row"))}">${EDITOR_ICONS.plus}</button>
      <button type="button" class="be-table-add is-col" data-be="add-col" tabindex="-1" title="${escapeHtml(t("Add column"))}">${EDITOR_ICONS.plus}</button>
    </div>`;
  }

  function flashcardsHtml(block) {
    const cards = block.cards?.length ? block.cards : [{ question: "", answer: "" }];
    return `<div class="be-cards">
      <div class="be-cards-head">
        <span class="be-cards-title">${EDITOR_ICONS.flashcards}<strong>${escapeHtml(t("Flashcards"))}</strong><em>${escapeHtml(tn(cards.length, "{count} card", "{count} cards"))}</em></span>
        <button type="button" class="be-small-button" data-be="copy-cards">${escapeHtml(t("Copy for Anki / Quizlet"))}</button>
      </div>
      <ol class="be-card-list">${cards.map((card, index) => `
        <li class="be-card">
          <span class="be-card-number">${index + 1}</span>
          <div class="be-card-body">
            <div class="be-card-q" contenteditable="true" data-card="${index}" data-field="question" data-placeholder="${escapeHtml(t("Question"))}">${textHtml(card.question || "")}</div>
            <div class="be-card-a" contenteditable="true" data-card="${index}" data-field="answer" data-placeholder="${escapeHtml(t("Answer"))}">${textHtml(card.answer || "")}</div>
          </div>
          <button type="button" class="be-card-delete" data-be="delete-card" data-index="${index}" tabindex="-1" title="${escapeHtml(t("Delete card"))}">${EDITOR_ICONS.close}</button>
        </li>`).join("")}
      </ol>
      <button type="button" class="be-cards-add" data-be="add-card">${EDITOR_ICONS.plus}<span>${escapeHtml(t("Add card"))}</span></button>
    </div>`;
  }

  function blockHtml(block, numbers) {
    let content;
    if (block.type === "todo") {
      content = `<button type="button" class="be-check" data-be="check" tabindex="-1" role="checkbox" aria-checked="${Boolean(block.checked)}" aria-label="${escapeHtml(t("Mark as done"))}">${EDITOR_ICONS.check}</button>${editableText(block)}`;
    } else if (block.type === "bullet") {
      content = `<span class="be-marker" aria-hidden="true"></span>${editableText(block)}`;
    } else if (block.type === "numbered") {
      content = `<span class="be-marker" aria-hidden="true">${numbers.get(block.id) || 1}.</span>${editableText(block)}`;
    } else if (block.type === "callout") {
      content = `<span class="be-callout-icon" aria-hidden="true">${EDITOR_ICONS.callout}</span>${editableText(block)}`;
    } else if (TEXT_TYPES.has(block.type)) {
      content = editableText(block);
    } else if (block.type === "code") {
      content = `${block.language ? `<span class="be-code-lang">${escapeHtml(block.language)}</span>` : ""}<pre class="be-code" contenteditable="plaintext-only" spellcheck="false" data-placeholder="${escapeHtml(t("Code"))}">${escapeHtml(block.text || "")}</pre>`;
    } else if (block.type === "divider") {
      content = `<div class="be-divider" tabindex="0" role="separator"></div>`;
    } else if (block.type === "table") {
      content = tableHtml(block);
    } else if (block.type === "flashcards") {
      content = flashcardsHtml(block);
    } else {
      content = "";
    }
    const classes = ["be-block", `be-${block.type}`, block.checked ? "is-checked" : ""].filter(Boolean).join(" ");
    return `<div class="${classes}" data-id="${escapeHtml(block.id)}" style="--indent:${block.indent || 0}">${gutter()}<div class="be-content">${content}</div></div>`;
  }

  function render(focus) {
    closeMenu();
    hideToolbar();
    if (!blocks.length) {
      blocks = [createBlock()];
    }
    const numbers = listNumbers(blocks);
    root.innerHTML = blocks.map(block => blockHtml(block, numbers)).join("") + '<div class="be-tail" data-be="tail"></div>';
    root.classList.toggle("is-blank", blocks.length === 1 && blocks[0].type === "paragraph" && !blocks[0].text);
    if (focus) {
      focusBlock(focus.id, focus.offset);
    }
  }

  function editableOf(id, which = "first") {
    const element = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!element) {
      return null;
    }
    const editables = element.querySelectorAll(EDITABLE);
    return which === "last" ? editables[editables.length - 1] : editables[0];
  }

  function focusBlock(id, offset = "end") {
    const element = editableOf(id, offset === "start" || typeof offset === "number" ? "first" : "last");
    if (!element) {
      return;
    }
    element.focus({ preventScroll: true });
    if (element.isContentEditable) {
      setCaret(element, offset === "end" ? textLength(element) : offset === "start" ? 0 : offset);
    }
    const box = element.getBoundingClientRect();
    const scroller = root.closest(".nb-main");
    if (scroller) {
      const view = scroller.getBoundingClientRect();
      if (box.bottom > view.bottom - 24) {
        scroller.scrollTop += box.bottom - view.bottom + 48;
      } else if (box.top < view.top + 56) {
        scroller.scrollTop -= view.top + 72 - box.top;
      }
    }
  }

  // ---------- Model sync ----------

  function sync(element) {
    const found = blockFor(element);
    if (!found) {
      return;
    }
    const { block } = found;
    if (element.matches(".be-text")) {
      block.text = serializeEditable(element);
      if (!block.text && element.innerHTML) {
        element.innerHTML = "";
      }
    } else if (element.matches(".be-code")) {
      block.text = element.textContent;
    } else if (element.matches("[data-cell]")) {
      const row = Number(element.dataset.row);
      const col = Number(element.dataset.col);
      if (block.rows?.[row]) {
        block.rows[row][col] = serializeEditable(element).replace(/\n/g, " ");
      }
      if (!element.textContent && element.innerHTML) {
        element.innerHTML = "";
      }
    } else if (element.matches("[data-card]")) {
      const card = block.cards?.[Number(element.dataset.card)];
      if (card) {
        card[element.dataset.field] = serializeEditable(element).replace(/\n/g, " ");
      }
      if (!element.textContent && element.innerHTML) {
        element.innerHTML = "";
      }
    }
    emit();
  }

  // The text before the caret and after it, taken out of the element (which is re-rendered after).
  function splitAtCaret(element) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(element, element.childNodes.length);
    const holder = document.createElement("div");
    holder.append(after.extractContents());
    return { head: serializeEditable(element), tail: serializeEditable(holder) };
  }

  // ---------- Structure ----------

  function convert(block, type) {
    const text = block.type === "code" ? escapeInline(block.text || "") : block.text || "";
    const indent = LIST_TYPES.has(type) ? block.indent || 0 : undefined;
    delete block.indent;
    delete block.checked;
    delete block.language;
    block.type = type;
    block.text = type === "code" ? inlineToPlain(text) : text;
    if (LIST_TYPES.has(type)) {
      block.indent = indent;
    }
    if (type === "todo") {
      block.checked = false;
    }
    if (type === "code") {
      block.language = "";
    }
  }

  function focusTargetFor(block) {
    if (block.type === "divider") {
      return null;
    }
    return { id: block.id, offset: "start" };
  }

  // Turn a block into another type; blocks that don't hold text are inserted instead (below, or in
  // place of an empty line).
  function applyType(id, type, { fromSlash = false } = {}) {
    const index = indexOf(id);
    const block = blocks[index];
    if (!block) {
      return;
    }
    record();
    const holdsText = TEXT_TYPES.has(block.type) || block.type === "code";
    const isEmpty = holdsText && !String(block.text || "").trim();
    if ((TEXT_TYPES.has(type) || type === "code") && holdsText && !(fromSlash && !isEmpty)) {
      convert(block, type);
      render({ id: block.id, offset: "end" });
    } else {
      const created = createBlock(type);
      if (isEmpty) {
        blocks.splice(index, 1, created);
      } else {
        blocks.splice(index + 1, 0, created);
      }
      let focus = focusTargetFor(created);
      if (type === "divider") {
        const next = blocks[indexOf(created.id) + 1];
        const paragraph = next && TEXT_TYPES.has(next.type) && !next.text ? next : createBlock();
        if (paragraph !== next) {
          blocks.splice(indexOf(created.id) + 1, 0, paragraph);
        }
        focus = { id: paragraph.id, offset: "start" };
      }
      render(focus);
    }
    emit();
  }

  function insertAfter(index, block, offset = "start") {
    record();
    blocks.splice(index + 1, 0, block);
    render({ id: block.id, offset });
    emit();
  }

  function removeBlock(index, focusPrevious = true) {
    record();
    const [removed] = blocks.splice(index, 1);
    const neighbour = blocks[focusPrevious ? index - 1 : index] || blocks[index - 1] || blocks[index];
    render(neighbour ? { id: neighbour.id, offset: focusPrevious ? "end" : "start" } : null);
    emit();
    return removed;
  }

  function splitBlock(element, block, index) {
    record();
    const { head, tail } = splitAtCaret(element);
    block.text = head;
    if (!head && !tail && (LIST_TYPES.has(block.type) || block.type === "quote" || block.type === "callout")) {
      if (LIST_TYPES.has(block.type) && block.indent > 0) {
        block.indent -= 1;
      } else {
        convert(block, "paragraph");
      }
      render({ id: block.id, offset: 0 });
      emit();
      return;
    }
    if (!head && tail && !LIST_TYPES.has(block.type)) {
      // Enter at the start of a heading or quote keeps it and opens a line above.
      block.text = tail;
      blocks.splice(index, 0, createBlock());
      render({ id: block.id, offset: 0 });
      emit();
      return;
    }
    const next = createBlock(LIST_TYPES.has(block.type) ? block.type : "paragraph", { text: tail });
    if (LIST_TYPES.has(block.type)) {
      next.indent = block.indent || 0;
    }
    blocks.splice(index + 1, 0, next);
    render({ id: next.id, offset: 0 });
    emit();
  }

  function backspaceAtStart(block, index) {
    if (block.type !== "paragraph") {
      record();
      if (LIST_TYPES.has(block.type) && block.indent > 0) {
        block.indent -= 1;
      } else {
        convert(block, "paragraph");
      }
      render({ id: block.id, offset: 0 });
      emit();
      return;
    }
    const previous = blocks[index - 1];
    if (!previous) {
      return;
    }
    if (TEXT_TYPES.has(previous.type)) {
      record();
      const joinAt = plainLength(previous.text || "");
      previous.text = (previous.text || "") + (block.text || "");
      blocks.splice(index, 1);
      render({ id: previous.id, offset: joinAt });
      emit();
    } else if (previous.type === "code") {
      record();
      const joinAt = previous.text.length;
      previous.text += inlineToPlain(block.text || "");
      blocks.splice(index, 1);
      render({ id: previous.id, offset: joinAt });
      emit();
    } else if (previous.type === "divider") {
      record();
      blocks.splice(index - 1, 1);
      render({ id: block.id, offset: 0 });
      emit();
    } else if (!block.text) {
      removeBlock(index);
    } else {
      focusBlock(previous.id, "end");
    }
  }

  function deleteAtEnd(block, index) {
    const next = blocks[index + 1];
    if (!next) {
      return;
    }
    if (TEXT_TYPES.has(next.type)) {
      record();
      const joinAt = plainLength(block.text || "");
      block.text = (block.text || "") + (next.text || "");
      blocks.splice(index + 1, 1);
      render({ id: block.id, offset: joinAt });
      emit();
    } else if (next.type === "divider") {
      record();
      blocks.splice(index + 1, 1);
      render({ id: block.id, offset: "end" });
      emit();
    }
  }

  function changeIndent(block, element, delta) {
    if (!LIST_TYPES.has(block.type)) {
      return;
    }
    const index = indexOf(block.id);
    const previous = blocks[index - 1];
    const ceiling = previous && LIST_TYPES.has(previous.type) ? (previous.indent || 0) + 1 : 0;
    const indent = Math.max(0, Math.min(MAX_INDENT, ceiling, (block.indent || 0) + delta));
    if (indent === (block.indent || 0)) {
      return;
    }
    const offset = caretOffset(element);
    record();
    block.indent = indent;
    render({ id: block.id, offset });
    emit();
  }

  function duplicate(index) {
    record();
    const copy = { ...JSON.parse(JSON.stringify(blocks[index])), id: createBlock().id };
    blocks.splice(index + 1, 0, copy);
    render(focusTargetFor(copy));
    emit();
  }

  // ---------- Tables and flashcards ----------

  function tableAction(block, action, cell = lastCell?.id === block.id ? lastCell : null) {
    const rows = block.rows;
    const width = rows[0]?.length || 1;
    record();
    if (action === "add-row") {
      const at = cell ? cell.row + 1 : rows.length;
      rows.splice(Math.max(1, at), 0, Array(width).fill(""));
      render({ id: block.id, offset: "start" });
      root.querySelector(`[data-id="${CSS.escape(block.id)}"] [data-row="${Math.max(1, at)}"][data-col="0"]`)?.focus();
    } else if (action === "add-col") {
      const at = cell ? cell.col + 1 : width;
      rows.forEach(row => row.splice(at, 0, ""));
      render();
      root.querySelector(`[data-id="${CSS.escape(block.id)}"] [data-row="${cell?.row ?? 0}"][data-col="${at}"]`)?.focus();
    } else if (action === "delete-row") {
      if (rows.length > 1) {
        rows.splice(cell ? cell.row : rows.length - 1, 1);
      }
      render();
    } else if (action === "delete-col") {
      if (width > 1) {
        const at = cell ? cell.col : width - 1;
        rows.forEach(row => row.splice(at, 1));
      }
      render();
    }
    lastCell = null;
    emit();
  }

  function focusCell(block, row, col) {
    const cell = root.querySelector(`[data-id="${CSS.escape(block.id)}"] [data-row="${row}"][data-col="${col}"]`);
    if (cell) {
      cell.focus();
      setCaret(cell, textLength(cell));
    }
  }

  function tableKey(event, element, block) {
    const row = Number(element.dataset.row);
    const col = Number(element.dataset.col);
    const width = block.rows[0].length;
    if (event.key === "Tab") {
      event.preventDefault();
      let nextRow = row;
      let nextCol = col + (event.shiftKey ? -1 : 1);
      if (nextCol >= width) {
        nextCol = 0;
        nextRow += 1;
      } else if (nextCol < 0) {
        nextCol = width - 1;
        nextRow -= 1;
      }
      if (nextRow >= block.rows.length) {
        record();
        block.rows.push(Array(width).fill(""));
        render();
        emit();
      }
      if (nextRow >= 0) {
        focusCell(block, nextRow, nextCol);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row + 1 >= block.rows.length) {
        record();
        block.rows.push(Array(width).fill(""));
        render();
        emit();
      }
      focusCell(block, row + 1, col);
    } else if (event.key === "ArrowUp" && lineCheck(element, "top")) {
      event.preventDefault();
      if (row > 0) {
        focusCell(block, row - 1, col);
      } else if (blocks[indexOf(block.id) - 1]) {
        focusBlock(blocks[indexOf(block.id) - 1].id, "end");
      }
    } else if (event.key === "ArrowDown" && lineCheck(element, "bottom")) {
      event.preventDefault();
      if (row + 1 < block.rows.length) {
        focusCell(block, row + 1, col);
      } else {
        leaveBlock(block, "down");
      }
    }
  }

  function leaveBlock(block, direction) {
    const index = indexOf(block.id);
    const target = blocks[index + (direction === "down" ? 1 : -1)];
    if (target) {
      focusBlock(target.id, direction === "down" ? "start" : "end");
    } else if (direction === "down") {
      insertAfter(index, createBlock());
    } else {
      onExitTop?.();
    }
  }

  function cardKey(event, element, block) {
    const index = Number(element.dataset.card);
    const field = element.dataset.field;
    const selector = (card, name) => `[data-id="${CSS.escape(block.id)}"] [data-card="${card}"][data-field="${name}"]`;
    if (event.key === "Enter") {
      event.preventDefault();
      if (field === "question") {
        root.querySelector(selector(index, "answer"))?.focus();
      } else {
        record();
        block.cards.splice(index + 1, 0, { question: "", answer: "" });
        render();
        emit();
        root.querySelector(selector(index + 1, "question"))?.focus();
      }
    } else if (event.key === "Backspace" && field === "question" && !element.textContent && !block.cards[index].answer && block.cards.length > 1) {
      event.preventDefault();
      record();
      block.cards.splice(index, 1);
      render();
      emit();
      const previous = root.querySelector(selector(Math.max(0, index - 1), index ? "answer" : "question"));
      if (previous) {
        previous.focus();
        setCaret(previous, textLength(previous));
      }
    } else if (event.key === "ArrowUp" && lineCheck(element, "top") && field === "question" && index === 0) {
      event.preventDefault();
      leaveBlock(block, "up");
    } else if (event.key === "ArrowDown" && lineCheck(element, "bottom") && field === "answer" && index === block.cards.length - 1) {
      event.preventDefault();
      leaveBlock(block, "down");
    }
  }

  async function copyCards(block) {
    const tsv = block.cards
      .filter(card => card.question.trim() || card.answer.trim())
      .map(card => `${inlineToPlain(card.question).replace(/\t/g, " ")}\t${inlineToPlain(card.answer).replace(/\t/g, " ")}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      toast?.(t("Copied as tab-separated cards"));
    } catch {
      toast?.(t("Couldn't copy"));
    }
  }

  // ---------- Menus ----------

  function closeMenu() {
    if (menu) {
      menu.element.remove();
      menu = null;
    }
  }

  function renderMenu() {
    const query = menu.query.trim().toLowerCase();
    menu.visible = menu.items.filter(item => item.section === undefined && (!query
      || item.label.toLowerCase().includes(query)
      || (item.keys || "").toLowerCase().includes(query)));
    menu.index = Math.min(menu.index, Math.max(0, menu.visible.length - 1));
    if (!menu.visible.length) {
      menu.element.innerHTML = `<div class="be-menu-empty">${escapeHtml(t("No results"))}</div>`;
      return;
    }
    let html = "";
    for (const item of menu.items) {
      if (item.section !== undefined) {
        if (!query) {
          html += item.section ? `<div class="be-menu-section">${escapeHtml(item.section)}</div>` : '<div class="be-menu-rule"></div>';
        }
        continue;
      }
      const position = menu.visible.indexOf(item);
      if (position < 0) {
        continue;
      }
      html += `<button type="button" class="be-menu-item${position === menu.index ? " is-selected" : ""}${item.danger ? " is-danger" : ""}" data-index="${position}" role="option" aria-selected="${position === menu.index}">
        <span class="be-menu-icon${item.hint ? " is-large" : ""}">${EDITOR_ICONS[item.icon] || ""}</span>
        <span class="be-menu-text"><strong>${escapeHtml(item.label)}</strong>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}</span>
        ${item.active ? `<span class="be-menu-check">${EDITOR_ICONS.check}</span>` : ""}
      </button>`;
    }
    menu.element.innerHTML = html;
    menu.element.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }

  function placeMenu(rect) {
    const box = menu.element.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + box.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - box.height - 6);
    }
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
    menu.element.style.top = `${top}px`;
    menu.element.style.left = `${left}px`;
  }

  function openMenu(rect, items, extra = {}) {
    closeMenu();
    const element = document.createElement("div");
    element.className = `be-menu${extra.slash ? " is-slash" : ""}`;
    element.setAttribute("role", "listbox");
    document.body.append(element);
    menu = { element, items, visible: [], index: 0, query: "", rect, ...extra };
    renderMenu();
    placeMenu(rect);
    element.addEventListener("pointerdown", event => event.preventDefault());
    element.addEventListener("click", event => {
      const option = event.target.closest("[data-index]");
      if (option) {
        pickMenu(Number(option.dataset.index));
      }
    });
    element.addEventListener("pointermove", event => {
      const option = event.target.closest("[data-index]");
      if (option && Number(option.dataset.index) !== menu.index) {
        menu.index = Number(option.dataset.index);
        for (const button of element.querySelectorAll("[data-index]")) {
          button.classList.toggle("is-selected", Number(button.dataset.index) === menu.index);
        }
      }
    });
  }

  function pickMenu(index) {
    const item = menu?.visible[index];
    if (!item) {
      return;
    }
    const current = menu;
    closeMenu();
    if (current.slash) {
      removeSlashText(current.slash);
    }
    item.run();
  }

  function typeItems(filter, activeType) {
    return BLOCK_TYPES.filter(filter).map(entry => ({
      label: t(entry.label),
      hint: activeType === undefined ? t(entry.hint) : "",
      icon: entry.icon,
      keys: `${entry.keys} ${entry.label}`,
      active: entry.type === activeType,
      type: entry.type
    }));
  }

  function openSlashMenu(element, start) {
    const found = blockFor(element);
    if (!found) {
      return;
    }
    const caret = caretRect();
    const rect = caret?.height > 0 && caret.bottom > 0 ? caret : element.getBoundingClientRect();
    const items = typeItems(() => true).map(item => ({ ...item, run: () => applyType(found.block.id, item.type, { fromSlash: true }) }));
    items.splice(6, 0, { label: t("Page reference"), hint: t("Insert a blue PDF page link in your text"), icon: "page", keys: "page reference cite citation pdf 页码 引用 页面", run: () => openPagePicker(found.block.id, rect) });
    openMenu(rect, [{ section: t("Basic blocks") }, ...items], { slash: { id: found.block.id, start } });
  }

  function openPagePicker(id, fallbackRect) {
    const element = editableOf(id);
    const selection = window.getSelection();
    if (!element || !selection.rangeCount) return;
    const saved = selection.getRangeAt(0).cloneRange();
    const caret = caretRect() || saved.getBoundingClientRect();
    pagePicker?.remove();
    pagePicker = document.createElement("div");
    pagePicker.className = "be-page-picker glass";
    pagePicker.innerHTML = `<div class="be-page-field"><span aria-hidden="true">${EDITOR_ICONS.page}</span><input class="flyout-input" type="text" inputmode="numeric" value="${Math.max(1, Number(getCurrentPage?.()) || 1)}" aria-label="${escapeHtml(t("Page reference"))}" placeholder="${escapeHtml(t("Page number"))}"></div><button type="button">${escapeHtml(t("Insert"))}</button>`;
    const commit = () => {
      const page = Number(pagePicker?.querySelector("input")?.value);
      if (!Number.isInteger(page) || page < 1) return;
      record();
      element.focus({ preventScroll: true });
      selection.removeAllRanges();
      selection.addRange(saved);
      const cite = document.createElement("span");
      cite.className = "be-cite";
      cite.contentEditable = "false";
      cite.dataset.md = `[p. ${page}]`;
      cite.dataset.page = String(page);
      cite.textContent = t("p. {page}", { page });
      saved.deleteContents();
      saved.insertNode(cite);
      saved.setStartAfter(cite);
      saved.collapse(true);
      selection.removeAllRanges();
      selection.addRange(saved);
      sync(element);
      pagePicker?.remove();
      pagePicker = null;
    };
    pagePicker.querySelector("button").addEventListener("click", commit);
    pagePicker.querySelector("input").addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") { event.preventDefault(); pagePicker?.remove(); pagePicker = null; element.focus(); }
    });
    document.body.append(pagePicker);
    const box = pagePicker.getBoundingClientRect();
    const position = popupNearCaret(caret, fallbackRect || element.getBoundingClientRect(), box,
      { width: window.innerWidth, height: window.innerHeight });
    pagePicker.style.left = `${position.left}px`;
    pagePicker.style.top = `${position.top}px`;
    pagePicker.querySelector("input").focus();
    pagePicker.querySelector("input").select();
  }

  function removeSlashText({ id, start }) {
    const element = editableOf(id);
    if (!element) {
      return;
    }
    const end = caretOffset(element);
    const from = positionAt(element, start);
    const to = positionAt(element, Math.max(start, end));
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    range.deleteContents();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    sync(element);
  }

  function plainText(element) {
    let text = "";
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.nodeValue;
        } else if (isAtom(child)) {
          text += child.tagName === "BR" ? "\n" : "￼";
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    };
    walk(element);
    return text;
  }

  function updateSlash(element, event) {
    const offset = caretOffset(element);
    if (menu?.slash) {
      const found = blockFor(element);
      const text = plainText(element);
      if (!found || found.block.id !== menu.slash.id || offset <= menu.slash.start || text[menu.slash.start] !== "/") {
        closeMenu();
        return;
      }
      const query = text.slice(menu.slash.start + 1, offset);
      if (query.length > 24 || /\n/.test(query)) {
        closeMenu();
        return;
      }
      menu.query = query;
      renderMenu();
      if (!menu.visible.length && query.length > 3) {
        closeMenu();
      }
      return;
    }
    if (event.inputType === "insertText" && event.data === "/") {
      const text = plainText(element);
      const before = text[offset - 2];
      if (offset === 1 || /\s/.test(before || "")) {
        openSlashMenu(element, offset - 1);
      }
    }
  }

  function openBlockMenu(item, anchor) {
    const found = blockFor(item);
    if (!found) {
      return;
    }
    const { block } = found;
    const id = block.id;
    const items = [];
    if (TEXT_TYPES.has(block.type) || block.type === "code") {
      items.push({ section: t("Turn into") });
      items.push(...typeItems(entry => TEXT_TYPES.has(entry.type) || entry.type === "code", block.type)
        .map(entry => ({ ...entry, run: () => applyType(id, entry.type) })));
      items.push({ section: "" });
    }
    if (block.type === "table") {
      const cell = lastCell?.id === id ? lastCell : null;
      items.push(
        { label: t("Add row"), icon: "plus", run: () => tableAction(blocks[indexOf(id)], "add-row", cell) },
        { label: t("Add column"), icon: "plus", run: () => tableAction(blocks[indexOf(id)], "add-col", cell) },
        { label: cell ? t("Delete this row") : t("Delete last row"), icon: "close", run: () => tableAction(blocks[indexOf(id)], "delete-row", cell) },
        { label: cell ? t("Delete this column") : t("Delete last column"), icon: "close", run: () => tableAction(blocks[indexOf(id)], "delete-col", cell) },
        { section: "" }
      );
    }
    items.push(
      { label: t("Duplicate"), icon: "copy", run: () => duplicate(indexOf(id)) },
      { label: t("Delete"), icon: "trash", danger: true, run: () => removeBlock(indexOf(id)) }
    );
    openMenu(anchor.getBoundingClientRect(), items, { block: id });
  }

  // ---------- Selection toolbar ----------

  function hideToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
  }

  function selectionEditable() {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = (container.nodeType === 1 ? container : container.parentElement)?.closest(INLINE_EDITABLE);
    return element && root.contains(element) ? { element, range } : null;
  }

  function inside(tagNames) {
    const selection = window.getSelection();
    let node = selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
    while (node && node !== root) {
      if (node.nodeType === 1 && tagNames.includes(node.tagName)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function toolbarButtons() {
    const found = selectionEditable();
    const block = found && blockFor(found.element)?.block;
    const current = BLOCK_TYPES.find(entry => entry.type === block?.type);
    const state = command => {
      try {
        return document.queryCommandState(command);
      } catch {
        return false;
      }
    };
    const button = (action, icon, label, active) => `<button type="button" class="be-tool${active ? " is-active" : ""}" data-tool="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${EDITOR_ICONS[icon]}</button>`;
    return `${found?.element.matches(".be-text") && current ? `<button type="button" class="be-tool be-tool-turn" data-tool="turn">${escapeHtml(t(current.label))}${EDITOR_ICONS.chevron}</button><span class="be-tool-rule"></span>` : ""}
      ${button("bold", "bold", `${t("Bold")} ⌘B`, state("bold"))}
      ${button("italic", "italic", `${t("Italic")} ⌘I`, state("italic"))}
      ${button("strike", "strike", `${t("Strikethrough")} ⌘⇧X`, state("strikeThrough"))}
      ${button("code", "inlineCode", `${t("Inline code")} ⌘E`, Boolean(inside(["CODE"])))}
      ${button("link", "link", `${t("Link")} ⌘K`, Boolean(inside(["A"])))}`;
  }

  function showToolbar() {
    const found = selectionEditable();
    if (!found || selecting || menu) {
      if (!found && !toolbar?.contains(document.activeElement)) {
        hideToolbar();
      }
      return;
    }
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "be-toolbar";
      toolbar.addEventListener("pointerdown", event => {
        if (!event.target.closest("input")) {
          event.preventDefault();
        }
      });
      toolbar.addEventListener("click", event => {
        const tool = event.target.closest("[data-tool]");
        if (tool) {
          runTool(tool.dataset.tool, tool);
        }
      });
      document.body.append(toolbar);
    }
    if (toolbar.classList.contains("is-link")) {
      return;
    }
    toolbar.innerHTML = toolbarButtons();
    const rect = found.range.getBoundingClientRect();
    const box = toolbar.getBoundingClientRect();
    const top = rect.top - box.height - 8 < 8 ? rect.bottom + 8 : rect.top - box.height - 8;
    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8))}px`;
  }

  function toggleInlineCode() {
    const found = selectionEditable();
    if (!found) {
      return;
    }
    record();
    const code = inside(["CODE"]);
    if (code) {
      code.replaceWith(document.createTextNode(code.textContent));
    } else {
      const text = found.range.toString();
      found.range.deleteContents();
      const element = document.createElement("code");
      element.textContent = text;
      found.range.insertNode(element);
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    sync(found.element);
    showToolbar();
  }

  function startLink() {
    const found = selectionEditable();
    if (!found || !toolbar) {
      return;
    }
    const existing = inside(["A"]);
    if (existing) {
      record();
      document.execCommand("unlink");
      sync(found.element);
      showToolbar();
      return;
    }
    const saved = found.range.cloneRange();
    toolbar.classList.add("is-link");
    toolbar.innerHTML = `<input type="url" class="be-link-input" placeholder="${escapeHtml(t("Paste a link…"))}"><button type="button" class="be-tool" data-tool="apply-link" title="${escapeHtml(t("Add link"))}">${EDITOR_ICONS.check}</button>`;
    const input = toolbar.querySelector("input");
    const apply = () => {
      let url = input.value.trim();
      toolbar?.classList.remove("is-link");
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(saved);
      found.element.focus({ preventScroll: true });
      selection.removeAllRanges();
      selection.addRange(saved);
      if (url) {
        if (!/^https?:\/\//i.test(url)) {
          url = `https://${url}`;
        }
        record();
        document.execCommand("createLink", false, url);
        sync(found.element);
      }
      hideToolbar();
    };
    toolbar.querySelector("[data-tool]").addEventListener("click", apply, { once: true });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = "";
        apply();
      }
    });
    input.focus();
  }

  function runTool(action, button) {
    const found = selectionEditable();
    if (action === "apply-link") {
      return;
    }
    if (action === "turn") {
      const block = found && blockFor(found.element)?.block;
      if (block) {
        hideToolbar();
        const id = block.id;
        openMenu(button.getBoundingClientRect(), typeItems(entry => TEXT_TYPES.has(entry.type) || entry.type === "code", block.type)
          .map(entry => ({ ...entry, run: () => applyType(id, entry.type) })));
      }
      return;
    }
    if (action === "code") {
      toggleInlineCode();
    } else if (action === "link") {
      startLink();
    } else if (found) {
      document.execCommand({ bold: "bold", italic: "italic", strike: "strikeThrough" }[action]);
      showToolbar();
    }
  }

  // ---------- Events ----------

  function onKeyDown(event) {
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = menu.visible.length || 1;
        menu.index = (menu.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        renderMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (menu.visible.length) {
          event.preventDefault();
          pickMenu(menu.index);
          return;
        }
        closeMenu();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
    }

    const mod = event.metaKey || event.ctrlKey;
    const key = String(event.key ?? "").toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        travel(redoStack, undoStack);
      } else {
        travel(undoStack, redoStack);
      }
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      travel(redoStack, undoStack);
      return;
    }

    const element = event.target.closest?.(EDITABLE);
    if (!element || event.isComposing) {
      return;
    }
    const found = blockFor(element);
    if (!found) {
      return;
    }
    const { block, index } = found;


    if (element.matches(INLINE_EDITABLE) && mod) {
      const command = { b: "bold", i: "italic" }[key];
      if (command && !event.shiftKey) {
        event.preventDefault();
        document.execCommand(command);
        return;
      }
      if (key === "x" && event.shiftKey) {
        event.preventDefault();
        document.execCommand("strikeThrough");
        return;
      }
      if (key === "u") {
        event.preventDefault();
        return;
      }
      if (key === "e") {
        event.preventDefault();
        toggleInlineCode();
        return;
      }
      if (key === "k") {
        event.preventDefault();
        if (selectionEditable()) {
          showToolbar();
          startLink();
        }
        return;
      }
    }

    if (element.matches(".be-divider")) {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        removeBlock(index);
      } else if (event.key === "Enter") {
        event.preventDefault();
        insertAfter(index, createBlock());
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        leaveBlock(block, "up");
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        leaveBlock(block, "down");
      }
      return;
    }
    if (element.matches("[data-cell]")) {
      tableKey(event, element, block);
      return;
    }
    if (element.matches("[data-card]")) {
      cardKey(event, element, block);
      return;
    }
    if (element.matches(".be-code")) {
      if (event.key === "Tab") {
        event.preventDefault();
        document.execCommand("insertText", false, "  ");
      } else if ((event.key === "Enter" && mod) || event.key === "Escape") {
        event.preventDefault();
        insertAfter(index, createBlock());
      } else if (event.key === "Backspace" && !element.textContent) {
        event.preventDefault();
        record();
        convert(block, "paragraph");
        render({ id: block.id, offset: 0 });
        emit();
      } else if (event.key === "ArrowUp" && caretOffset(element) === 0 && selectionIsCollapsed()) {
        event.preventDefault();
        leaveBlock(block, "up");
      } else if (event.key === "ArrowDown" && caretOffset(element) >= element.textContent.replace(/\n$/, "").length && selectionIsCollapsed()) {
        event.preventDefault();
        leaveBlock(block, "down");
      }
      return;
    }

    // Text blocks.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      splitBlock(element, block, index);
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
    } else if (event.key === "Backspace" && selectionIsCollapsed() && caretOffset(element) === 0) {
      event.preventDefault();
      backspaceAtStart(block, index);
    } else if (event.key === "Delete" && selectionIsCollapsed() && caretOffset(element) >= textLength(element)) {
      event.preventDefault();
      deleteAtEnd(block, index);
    } else if (event.key === "Tab") {
      event.preventDefault();
      changeIndent(block, element, event.shiftKey ? -1 : 1);
    } else if (event.key === "ArrowUp" && selectionIsCollapsed() && lineCheck(element, "top")) {
      event.preventDefault();
      leaveBlock(block, "up");
    } else if (event.key === "ArrowDown" && selectionIsCollapsed() && lineCheck(element, "bottom")) {
      const next = blocks[index + 1];
      if (next) {
        event.preventDefault();
        focusBlock(next.id, "start");
      }
    } else if (event.key === "Escape") {
      element.blur();
    }
  }

  function applyShortcut(element, found) {
    const { block } = found;
    const offset = caretOffset(element);
    const before = plainText(element).slice(0, offset);
    if (block.type === "paragraph" && /^(---|\*\*\*)$/.test(before) && plainText(element).length === 3) {
      record();
      element.textContent = "";
      block.text = "";
      applyType(block.id, "divider");
      return true;
    }
    for (const [pattern, type] of SHORTCUTS) {
      if (!pattern.test(before) || block.type === type) {
        continue;
      }
      if (block.type !== "paragraph" && !(LIST_TYPES.has(block.type) && LIST_TYPES.has(type))) {
        continue;
      }
      record();
      const from = positionAt(element, 0);
      const to = positionAt(element, offset);
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      range.deleteContents();
      block.text = serializeEditable(element);
      convert(block, type);
      if (type === "todo" && /x/i.test(before)) {
        block.checked = true;
      }
      render({ id: block.id, offset: 0 });
      emit();
      return true;
    }
    return false;
  }

  function onBeforeInput(event) {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyUndo") {
        travel(undoStack, redoStack);
      } else {
        travel(redoStack, undoStack);
      }
      return;
    }
    const now = Date.now();
    if (now - lastInputAt > 800 || event.inputType.startsWith("format") || event.inputType === "insertFromPaste" || event.inputType === "deleteByCut") {
      const state = snapshot();
      if (undoStack.at(-1)?.blocks !== state.blocks) {
        undoStack.push(state);
        if (undoStack.length > 200) {
          undoStack.shift();
        }
      }
      redoStack.length = 0;
    }
    lastInputAt = now;
  }

  function onInput(event) {
    const element = event.target.closest?.(EDITABLE);
    if (!element) {
      return;
    }
    sync(element);
    if (element.matches(".be-text")) {
      const found = blockFor(element);
      if (event.inputType === "insertText" && found && !menu && applyShortcut(element, found)) {
        return;
      }
      updateSlash(element, event);
    }
    if (toolbar && !selectionEditable()) {
      hideToolbar();
    }
  }

  function onPaste(event) {
    const element = event.target.closest?.(EDITABLE);
    if (!element) {
      return;
    }
    event.preventDefault();
    const text = (event.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    if (!text) {
      return;
    }
    if (element.matches(".be-code")) {
      document.execCommand("insertText", false, text);
      return;
    }
    if (element.matches("[data-cell], [data-card]") || !text.trim().includes("\n")) {
      document.execCommand("insertText", false, element.matches(".be-text") ? text.trim() : text.replace(/\s*\n\s*/g, " ").trim());
      return;
    }
    const parsed = markdownToBlocks(text);
    const found = blockFor(element);
    if (!parsed.length || !found) {
      return;
    }
    record();
    const { block, index } = found;
    const { head, tail } = splitAtCaret(element);
    block.text = head;
    let insertAt = index + 1;
    if (!head.trim() && block.type === "paragraph") {
      blocks.splice(index, 1);
      insertAt = index;
    }
    blocks.splice(insertAt, 0, ...parsed);
    let last = parsed.at(-1);
    let offset = "end";
    if (tail) {
      if (TEXT_TYPES.has(last.type)) {
        offset = plainLength(last.text);
        last.text += tail;
      } else {
        last = createBlock("paragraph", { text: tail });
        blocks.splice(insertAt + parsed.length, 0, last);
        offset = 0;
      }
    }
    render(last.type === "divider" ? null : { id: last.id, offset });
    emit();
  }

  function onClick(event) {
    const cite = event.target.closest(".be-cite");
    if (cite) {
      onCite?.(Number(cite.dataset.page));
      return;
    }
    // Clicking an equation opens its TeX for editing; it renders again when the text loses focus.
    const math = event.target.closest(".be-math");
    const mathElement = math?.closest(EDITABLE);
    if (mathElement) {
      record();
      const source = document.createTextNode(math.dataset.md || "");
      math.replaceWith(source);
      mathElement.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(source, Math.max(0, source.nodeValue.length - (source.nodeValue.startsWith("$$") || source.nodeValue.startsWith("\\") ? 2 : 1)));
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      sync(mathElement);
      return;
    }
    const link = event.target.closest("a[href]");
    if (link && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      window.open(link.href, "_blank", "noopener");
      return;
    }
    const button = event.target.closest("[data-be]");
    if (!button) {
      return;
    }
    const found = blockFor(button);
    const action = button.dataset.be;
    if (action === "tail") {
      const last = blocks.at(-1);
      if (last && last.type === "paragraph" && !last.text) {
        focusBlock(last.id, "start");
      } else {
        insertAfter(blocks.length - 1, createBlock());
      }
      return;
    }
    if (!found) {
      return;
    }
    const { block, index } = found;
    if (action === "check") {
      record();
      block.checked = !block.checked;
      button.setAttribute("aria-checked", String(block.checked));
      button.closest(".be-block").classList.toggle("is-checked", block.checked);
      emit();
    } else if (action === "add") {
      const created = createBlock();
      insertAfter(index, created);
      document.execCommand("insertText", false, "/");
    } else if (action === "add-row" || action === "add-col") {
      tableAction(block, action, null);
    } else if (action === "add-card") {
      record();
      block.cards.push({ question: "", answer: "" });
      render();
      emit();
      root.querySelector(`[data-id="${CSS.escape(block.id)}"] [data-card="${block.cards.length - 1}"][data-field="question"]`)?.focus();
    } else if (action === "delete-card") {
      record();
      block.cards.splice(Number(button.dataset.index), 1);
      if (!block.cards.length) {
        blocks.splice(index, 1);
      }
      render();
      emit();
    } else if (action === "copy-cards") {
      copyCards(block);
    }
  }

  // TeX typed or opened for editing turns back into an equation once the caret leaves the text.
  function onFocusOut(event) {
    const element = event.target.closest?.(EDITABLE);
    if (!element?.isContentEditable || element.matches(".be-code")) {
      return;
    }
    const markdown = serializeEditable(element);
    const holder = document.createElement("div");
    holder.innerHTML = inlineToHtml(markdown);
    if (holder.querySelectorAll(".be-math").length !== element.querySelectorAll(".be-math").length) {
      element.innerHTML = textHtml(markdown);
    }
  }

  function onFocusIn(event) {
    const cell = event.target.closest?.("[data-cell]");
    if (cell) {
      lastCell = { id: blockFor(cell)?.block.id, row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    }
  }

  function onSelectionChange() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(showToolbar);
  }

  function onDocumentPointerDown(event) {
    if (menu && !menu.element.contains(event.target)) {
      closeMenu();
    }
    if (toolbar && !toolbar.contains(event.target)) {
      hideToolbar();
    }
    selecting = root.contains(event.target);
  }

  function onDocumentPointerUp() {
    if (selecting) {
      selecting = false;
      onSelectionChange();
    }
  }

  function onScroll() {
    if (menu) {
      closeMenu();
    }
    if (toolbar && !toolbar.classList.contains("is-link")) {
      hideToolbar();
    }
  }

  const detachSortable = attachSortable(root, {
    items: ".be-block",
    handle: '[data-be="handle"]',
    onClick: (item, grip) => openBlockMenu(item, grip),
    onMove: (item, before) => {
      const from = indexOf(item.dataset.id);
      record();
      const [moved] = blocks.splice(from, 1);
      const to = before ? indexOf(before.dataset.id) : blocks.length;
      blocks.splice(to, 0, moved);
      render();
      emit();
    }
  });

  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("input", onInput);
  root.addEventListener("paste", onPaste);
  root.addEventListener("click", onClick);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("pointerup", onDocumentPointerUp, true);
  const scroller = root.closest(".nb-main");
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  // Menus opened from a block handle get keys even though focus stays where it was.
  const onDocumentKeyDown = event => {
    if (menu && !root.contains(event.target)) {
      onKeyDown(event);
    }
  };
  document.addEventListener("keydown", onDocumentKeyDown, true);

  render();

  return {
    destroy() {
      closeMenu();
      hideToolbar();
      pagePicker?.remove();
      pagePicker = null;
      detachSortable();
      cancelAnimationFrame(selectionFrame);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("pointerup", onDocumentPointerUp, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      scroller?.removeEventListener("scroll", onScroll);
    },
    focusStart() {
      focusBlock(blocks[0].id, "start");
    },
    hasFocus: () => root.contains(document.activeElement),
    getBlocks: () => blocks
  };
}
