import { createAgentTools, formatPages, TOOL_LABELS } from "./agent-tools.js";
import { getItem, setItem } from "./store.js";

const SETTINGS_KEY = "aiSettings";
const HISTORY_KEY = "aiHistory";
const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "deepseek-flash",
  baseUrl: "https://api.deepseek.com",
  pageFormat: "auto",
  thinking: "high",
  allowEdits: true,
  mode: "read"
};
// Model IDs from DeepSeek's model list (September 2026). `vision` decides how pages are sent in "auto" mode.
const MODEL_PRESETS = [
  { id: "deepseek-flash", label: "DeepSeek Flash", hint: "Reads images", vision: true }
];
// Earlier versions of this extension defaulted to these IDs; DeepSeek no longer lists them.
const RETIRED_DEFAULT_MODELS = new Set(["deepseek-chat", "deepseek-reasoner"]);
const THINKING_LEVELS = [["none", "Off"], ["low", "Low"], ["high", "High"], ["max", "Max"]];
const MAX_ATTACHED_PAGES = 8;
const MAX_ATTACHED_REGIONS = 4;
// Older page images are replaced by a short note so long chats don't resend every image.
const RECENT_IMAGE_ATTACHMENTS = 3;
const MAX_HISTORY_TURNS = 8;
const MAX_STORED_MESSAGES = 120;
const MAX_STORED_TOOL_RESULT = 1500;
const RECENT_FULL_TRANSCRIPTS = 4;
const MAX_AGENT_STEPS = 14;
const IMAGE_CACHE_LIMIT = 40;
const MENTION_PATTERN = /(^|\s)@(\d+)(?:\s*[-–]\s*(\d+))?(?=$|[\s.,;:!?)])/g;

const ICONS = {
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>',
  deepseek: '<img class="deepseek-logo" src="icons/deepseek.svg" alt="" aria-hidden="true">',
  page: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>',
  region: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><rect x="8" y="8" width="8" height="8" rx="1.5"></rect></svg>',
  quote: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h4v4H6zM14 7h4v4h-4z"></path><path d="M10 11c0 3-1.5 5-4 6M18 11c0 3-1.5 5-4 6"></path></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L19 7"></path></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4M12 16h.01"></path></svg>',
  jump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>'
};

// One icon per kind of tool, so a step log reads at a glance: looked, searched, filled, marked…
const TOOL_ICONS = {
  view_pages: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  view_region: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  search_document: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.5-4.5"></path></svg>',
  find_text: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.5-4.5"></path></svg>',
  get_outline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3 6h.01M3 12h.01M3 18h.01"></path></svg>',
  set_outline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3 6h.01M3 12h.01M3 18h.01"></path></svg>',
  get_page_layout: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path></svg>',
  list_form_fields: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 10h6M7 14h10"></path></svg>',
  fill_form_fields: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 12h6"></path><path d="m15 12 2 2 4-4"></path></svg>',
  add_text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V4h16v3"></path><path d="M12 4v16"></path><path d="M9 20h6"></path></svg>',
  add_text_layer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z"></path><path d="m3 13 9 5 9-5"></path></svg>',
  highlight_text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11-6 6v2h8l3-3"></path><path d="m21 11-4.6 4.6a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8L14 4z"></path></svg>',
  draw_shape: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17c3-4.5 5-6 6.5-4.5s-1 4 1 4.5 3.5-5 6-6.5 3 .5 4.5 1.5"></path></svg>',
  list_markup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.9-2.9a2 2 0 0 1 .5-.9z"></path></svg>',
  delete_markup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  report_items: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"></path><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"></path></svg>',
  propose_redactions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a13 13 0 0 1-2.2 3.2"></path><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"></path><path d="m2 2 20 20"></path></svg>',
  go_to_page: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>'
};

const SEVERITY_ICONS = {
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4M12 16h.01"></path></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.2 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3l-7.9-13.8a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4M12 17h.01"></path></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L19 7"></path></svg>'
};

// ---------- Modes & commands ----------
// Three modes group the assistant's features around what the reader is doing; every command is also
// reachable by typing "/" in the composer, whatever the mode. {page} is the current page, {language}
// the reader's UI language.

const MODES = [
  {
    id: "read",
    label: "Read",
    hint: "Understand what you're reading",
    prompt: "The reader is in Read mode: help them understand the document. Prefer clear explanations in plain words, define jargon, and point to the exact pages. Hold ⌥ and point at any part of a page for a quick explanation bubble; the reader can also click 'Figure 2'-style references to see them.",
    commands: [
      { id: "brief", label: "Document brief", description: "What this is, how it's organised, and where the key parts are", prompt: "Give me a brief of this document: what it is, how it's organised (use get_outline, and search_document or view_pages to skim), its main points or purpose, and where to look for the key parts. Cite pages." },
      { id: "explain-page", label: "Explain this page", description: "Plain-words explanation of the current page", prompt: "Explain @{page} in plain words. Define any jargon and walk through any formulas, tables or charts." },
      { id: "summarize", label: "Summarize this page", description: "A few bullet points for the current page", prompt: "Summarize @{page} in a few bullet points." },
      { id: "translate", label: "Translate in place", description: "Lay a translation over the page as a layer you can switch off", prompt: "Translate @{page} into {language} in place: call get_page_layout, then add_text_layer with one item per text block (skip page numbers, running headers and footers), keeping each block's box so the layout stays the same. Translate the full text of every block; don't summarise." },
      { id: "define", label: "Define a term", description: "Ask what a word or concept means in this document", prompt: "In this document, what does \"\" mean? Cite where it's defined or used." },
      { id: "outline", label: "Build a table of contents", description: "For PDFs without bookmarks: headings and pages in the sidebar", prompt: "Build a table of contents for this document and put it in the sidebar with set_outline. Skim every page (view_pages a few at a time; get_page_layout shows font sizes when you're unsure what is a heading), collect every heading as printed with its page, use depth 0 for chapters or top-level sections and 1 or 2 for subsections, then call set_outline once with all entries." }
    ]
  },
  {
    id: "study",
    label: "Study",
    hint: "Notes, quizzes and flashcards",
    prompt: "The reader is in Study mode: turn the document and their own highlights (list_markup returns them with text and page) into notes, quizzes, glossaries and flashcards. Cite pages so they can review. For quizzes, ask one question at a time, wait for the answer, then grade it kindly with the correct answer and a page citation before the next question. For flashcards, end with a ```flashcards code block containing one card per line as 'Question :: Answer'.",
    commands: [
      { id: "notes", label: "Highlights into notes", description: "Group everything you highlighted by topic, with page links and quiz questions", prompt: "Turn my highlights into study notes: call list_markup to collect every highlight and underline with its text and page. Group them by topic under headings, keep the page citations, and add five quiz questions with answers. Finish with a ```flashcards block (one 'Question :: Answer' per line) I can export." },
      { id: "quiz", label: "Quiz me", description: "Five questions on the current page, one at a time", prompt: "Quiz me on @{page}: ask one question at a time and wait for my answer. Grade each answer kindly with the correct answer and a page citation, then ask the next. Five questions in total, then a score." },
      { id: "glossary", label: "Key terms", description: "A table of the important terms and what they mean", prompt: "List the key terms and concepts on @{page} in a table with a one-line definition for each, in the order they appear." },
      { id: "study-notes", label: "Summarize into notes", description: "Structured notes for the current page", prompt: "Summarize @{page} into structured study notes: short headings, bullet points, and any key numbers, formulas or definitions. Cite pages." },
      { id: "flashcards", label: "Flashcards", description: "Question and answer cards from the current page", prompt: "Make 10 flashcards from @{page}. Output them as a ```flashcards block with one 'Question :: Answer' per line." }
    ]
  },
  {
    id: "work",
    label: "Work",
    hint: "Forms, contracts and reports",
    prompt: "The reader is in Work mode: they are dealing with forms, contracts, invoices or reports. Be precise and practical. Use list_form_fields and fill_form_fields for real forms, report_items to present reviews and extracted facts as a checklist the reader can click through, propose_redactions to hide personal information (never approve them yourself), and a ```csv code block for extracted tables.",
    commands: [
      { id: "review-form", label: "Review this form", description: "Check for empty fields, wrong dates, missing signatures and contradictions before you submit", prompt: "Review this form before I submit it. Call list_form_fields for the whole document and view the pages that have fields (or every page if there are no real fields). Then call report_items with every problem you find: empty required fields, dates in the wrong format, missing signatures or dates next to signatures, ticks that contradict each other, and anything inconsistent, each with a severity and its box. Finish with a two-sentence summary." },
      { id: "fill-form", label: "Fill in this form", description: "The assistant fills the fields and asks for anything it needs", prompt: "Fill in the form on @{page}. Ask me for any details you need before inventing anything." },
      { id: "extract", label: "Extract key facts", description: "Parties, dates, deadlines, amounts and obligations as a checklist", prompt: "Extract the key facts from this document: parties, dates and deadlines, amounts, obligations and anything I must act on. Use search_document and view_pages to find them, then call report_items with one item per fact and its page. End with a short summary." },
      { id: "table-csv", label: "Table to CSV", description: "Copy a table off the page as CSV", prompt: "Extract the table on @{page} as CSV in a ```csv block, keeping the header row exactly as printed." },
      { id: "redact", label: "Redact personal info", description: "Propose black boxes over names, IDs, phone numbers, emails, addresses and signatures", prompt: "Find personal information on @{page}: names, ID or account numbers, phone numbers, emails, addresses, dates of birth and signatures. Use get_page_layout and find_text to get exact boxes, then call propose_redactions with slightly padded boxes and a reason for each. Don't approve them; I will." }
    ]
  }
];

function languageName() {
  try {
    const code = navigator.language.split("-")[0];
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || navigator.language;
  } catch {
    return "English";
  }
}

// ---------- Markdown ----------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

// Everything is escaped first, so only the tags produced here can reach the DOM.
function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return ` ${codes.length - 1} `;
  });

  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    // Page citations, bracketed ([p. 3], [pp. 3-4]) or bare (p. 3), become jump buttons.
    .replace(/\[(pp?)\.\s*(\d+)(?:\s*[-–]\s*(\d+))?(?:\s*[,;]\s*([^\]]{1,60}))?\]|\b(pp?)\.\s*(\d+)(?:\s*[-–]\s*(\d+))?(?=$|[\s.,;:!?)\]])/gi, (match, prefix, start, end, extra, barePrefix, bareStart, bareEnd) => {
      const first = start ?? bareStart;
      const last = end ?? bareEnd;
      const label = `${(prefix ?? barePrefix).toLowerCase()}. ${first}${last ? `–${last}` : ""}`;
      const detail = extra ? `<span class="cite-extra">, ${extra.trim()}</span>` : "";
      return `<button type="button" class="cite" data-page="${first}" title="Go to page ${first}">${label}</button>${detail}`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return html.replace(/ (\d+) /g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

function splitCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, "|").trim());
}

function renderTable(lines) {
  const header = splitCells(lines[0]);
  const aligns = splitCells(lines[1]).map(cell => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const style = index => (aligns[index] ? ` style="text-align:${aligns[index]}"` : "");
  let html = `<div class="table-wrap"><table><thead><tr>${header.map((cell, index) => `<th${style(index)}>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
  const body = lines.slice(2).map(line => {
    const cells = splitCells(line);
    while (cells.length < header.length) {
      cells.push("");
    }
    return `<tr>${cells.slice(0, header.length).map((cell, index) => `<td${style(index)}>${renderInline(cell)}</td>`).join("")}</tr>`;
  });
  if (body.length) {
    html += `<tbody>${body.join("")}</tbody>`;
  }
  return `${html}</table></div>`;
}

function renderListTree(list) {
  const items = list.items.map(item => {
    let text = item.text;
    let checkbox = "";
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checkbox = `<input type="checkbox" disabled ${task[1] === " " ? "" : "checked"}> `;
      text = task[2];
    }
    return `<li>${checkbox}${renderInline(text)}${item.children.map(renderListTree).join("")}</li>`;
  });
  return `<${list.type}>${items.join("")}</${list.type}>`;
}

function renderList(lines) {
  const root = { type: "root", indent: -1, items: [{ text: "", children: [] }] };
  const stack = [root];

  for (const line of lines) {
    const match = line.match(LIST_ITEM);
    if (!match) {
      const top = stack.at(-1);
      const last = top.items.at(-1);
      if (last) {
        last.text += ` ${line.trim()}`;
      }
      continue;
    }

    const indent = match[1].length;
    const type = /\d/.test(match[2]) ? "ol" : "ul";
    while (stack.length > 1 && indent < stack.at(-1).indent) {
      stack.pop();
    }
    let top = stack.at(-1);
    if (top === root || indent > top.indent) {
      const list = { type, indent, items: [] };
      const parent = top.items.at(-1);
      parent.children.push(list);
      stack.push(list);
      top = list;
    } else if (top.type !== type) {
      stack.pop();
      const list = { type, indent, items: [] };
      stack.at(-1).items.at(-1).children.push(list);
      stack.push(list);
      top = list;
    }
    top.items.push({ text: match[3], children: [] });
  }

  return root.items[0].children.map(renderListTree).join("");
}

function renderBlocks(text) {
  const lines = text.split("\n");
  let html = "";
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${paragraph.map(renderInline).join("<br>")}</p>`;
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trimEnd();
    let match;

    if (!line.trim()) {
      flushParagraph();
    } else if ((match = line.match(HEADING))) {
      flushParagraph();
      const level = match[1].length <= 2 ? "h3" : "h4";
      html += `<${level}>${renderInline(match[2])}</${level}>`;
    } else if (RULE.test(line)) {
      flushParagraph();
      html += "<hr>";
    } else if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes("|")) {
      flushParagraph();
      const rows = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html += renderTable(rows);
    } else if (LIST_ITEM.test(line)) {
      flushParagraph();
      const rows = [line];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (LIST_ITEM.test(next) || (/^\s{2,}\S/.test(next) && !HEADING.test(next))) {
          rows.push(next);
          index += 1;
        } else {
          break;
        }
      }
      html += renderList(rows);
    } else if ((match = line.match(/^\s*>\s?(.*)$/))) {
      flushParagraph();
      const quoteLines = [match[1]];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) {
        index += 1;
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
      }
      html += `<blockquote>${renderBlocks(quoteLines.join("\n"))}</blockquote>`;
    } else {
      paragraph.push(line);
    }
  }

  flushParagraph();
  return html;
}

const blockStore = new Map();
let blockCounter = 0;

function storeBlock(kind, text) {
  const id = `b${++blockCounter}`;
  blockStore.set(id, { kind, text });
  if (blockStore.size > 200) {
    blockStore.delete(blockStore.keys().next().value);
  }
  return id;
}

function parseFlashcards(text) {
  return text.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s*::\s*|\s*\|\s*(?=[^|]*$)/);
    return parts.length >= 2 ? { question: parts[0].replace(/^[-*\d.)\s]+/, ""), answer: parts.slice(1).join(" ") } : null;
  }).filter(Boolean);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(cells => cells.some(value => value.trim()));
}

function renderCodeBlock(language, code) {
  const lang = language.trim().toLowerCase();
  if (lang === "flashcards") {
    const cards = parseFlashcards(code);
    if (cards.length) {
      const id = storeBlock("flashcards", code);
      return `<div class="ai-card flashcards" data-block-id="${id}">
        <div class="ai-card-head"><strong>Flashcards</strong><span>${cards.length} cards</span></div>
        <ol class="flashcard-list">${cards.slice(0, 40).map(card => `<li><strong>${renderInline(card.question)}</strong><span>${renderInline(card.answer)}</span></li>`).join("")}</ol>
        <div class="ai-card-actions">
          <button type="button" data-block-action="copy-tsv">Copy for Anki / Quizlet</button>
          <button type="button" data-block-action="copy-md">Copy as Markdown</button>
          <button type="button" data-block-action="download-tsv">Download .tsv</button>
        </div>
      </div>`;
    }
  }
  if (lang === "csv") {
    const rows = parseCsv(code);
    if (rows.length) {
      const id = storeBlock("csv", code);
      const [header, ...body] = rows;
      return `<div class="ai-card csv" data-block-id="${id}">
        <div class="ai-card-head"><strong>Table</strong><span>${rows.length - 1} rows</span></div>
        <div class="table-wrap"><table><thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>
        <tbody>${body.slice(0, 60).map(cells => `<tr>${header.map((_, index) => `<td>${escapeHtml(cells[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="ai-card-actions">
          <button type="button" data-block-action="copy-csv">Copy CSV</button>
          <button type="button" data-block-action="copy-tsv-table">Copy for Excel / Sheets</button>
          <button type="button" data-block-action="download-csv">Download .csv</button>
        </div>
      </div>`;
    }
  }
  return `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
}

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let buffer = [];
  let fence = null;

  for (const line of lines) {
    const opening = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      if (opening && opening[1][0] === fence.marker[0] && opening[1].length >= fence.marker.length && !opening[2]) {
        html += renderCodeBlock(fence.language, fence.lines.join("\n"));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (opening) {
      html += renderBlocks(buffer.join("\n"));
      buffer = [];
      fence = { marker: opening[1], language: opening[2] || "", lines: [] };
      continue;
    }
    buffer.push(line);
  }

  if (fence) {
    html += renderCodeBlock(fence.language, fence.lines.join("\n"));
  }
  return html + renderBlocks(buffer.join("\n"));
}

function truncate(text, length) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean;
}

// "@3" or "@2-4" anywhere in the message attaches those pages.
function parseMentions(text, pageCount) {
  const tokens = [];
  const pages = new Set();

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const first = Number(match[2]);
    const last = match[3] ? Number(match[3]) : first;
    const start = match.index + match[1].length;
    const low = Math.max(1, Math.min(first, last));
    const high = Math.min(pageCount, Math.max(first, last));
    const valid = pageCount > 0 && low <= high;

    tokens.push({ start, end: match.index + match[0].length, from: low, to: valid ? high : low, valid });
    for (let page = low; valid && page <= high; page += 1) {
      pages.add(page);
    }
  }

  return { tokens, pages: [...pages].sort((a, b) => a - b) };
}

function regionKey(region) {
  const { x1, y1, x2, y2 } = region.box;
  return `${region.page}|${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}`;
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function createAssistant({ host, getSelectedText, toast }) {
  const $ = selector => document.querySelector(selector);
  const el = {
    allowEdits: $("#aiAllowEdits"),
    appShell: $("#appShell"),
    attach: $("#aiAttach"),
    attachMenu: $("#aiAttachMenu"),
    attachments: $("#aiAttachments"),
    baseUrl: $("#aiBaseUrl"),
    close: $("#aiClose"),
    commandMenu: $("#aiCommandMenu"),
    conversation: $("#aiConversation"),
    docLabel: $("#aiDocLabel"),
    form: $("#aiForm"),
    input: $("#aiInput"),
    key: $("#aiKey"),
    keyToggle: $("#aiKeyToggle"),
    mentionMenu: $("#aiMentionMenu"),
    messages: $("#aiMessages"),
    mic: $("#aiMic"),
    model: $("#aiModel"),
    modelButton: $("#aiModelButton"),
    modelEffort: $("#aiModelEffort"),
    modelLabel: $("#aiModelLabel"),
    modelMenu: $("#aiModelMenu"),
    modes: $("#aiModes"),
    pageFormat: $("#aiPageFormat"),
    panel: $("#aiPanel"),
    quickActions: $("#aiQuickActions"),
    send: $("#aiSend"),
    settings: $("#aiSettings"),
    settingsButton: $("#aiSettingsBtn"),
    settingsCancel: $("#aiSettingsCancel"),
    title: $("#aiTitle"),
    titleButton: $("#aiTitleButton"),
    titleMenu: $("#aiTitleMenu"),
    toggle: $("#aiToggle")
  };
  const menus = [el.titleMenu, el.attachMenu, el.modelMenu, el.mentionMenu, el.commandMenu];
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const tools = createAgentTools(host);
  const imageCache = new Map();

  let settings = { ...DEFAULT_SETTINGS };
  let history = [];
  let quote = "";
  let regions = [];
  let controller = null;
  let docKey = "";
  let updateFrame = 0;
  let recognition = null;
  let mention = null;
  let command = null;
  let persistTimer = 0;

  el.panel.inert = true;
  el.mic.hidden = !SpeechRecognition;

  const ready = Promise.all([getItem(SETTINGS_KEY, null), getItem(HISTORY_KEY, null)]).then(([savedSettings, savedHistory]) => {
    settings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) };
    if (RETIRED_DEFAULT_MODELS.has(settings.model)) {
      settings.model = DEFAULT_SETTINGS.model;
    }
    if (!MODES.some(mode => mode.id === settings.mode)) {
      settings.mode = DEFAULT_SETTINGS.mode;
    }
    history = restoreHistory(savedHistory);
    renderModes();
    updateMeta();
  });

  function currentMode() {
    return MODES.find(mode => mode.id === settings.mode) || MODES[0];
  }

  function isDeepSeekHost() {
    try {
      return new URL(settings.baseUrl).hostname.endsWith("deepseek.com");
    } catch {
      return false;
    }
  }

  function pageFormat() {
    if (settings.pageFormat === "image" || settings.pageFormat === "text") {
      return settings.pageFormat;
    }
    return MODEL_PRESETS.find(preset => preset.id === settings.model)?.vision === false ? "text" : "image";
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await setItem(SETTINGS_KEY, settings);
    updateMeta();
  }

  // ---------- History persistence ----------
  // One continuous chat is kept across documents and reloads; a divider marks each document switch.

  function restoreHistory(saved) {
    if (!Array.isArray(saved)) {
      return [];
    }
    return saved.filter(message => message && typeof message === "object").map(message => {
      if (message.role === "assistant" && !message.error) {
        const fix = step => ({ ...step, undo: null, status: step.status === "running" ? "error" : step.status });
        const cards = message.cards || [];
        let timeline;
        let steps;
        if (Array.isArray(message.timeline)) {
          timeline = message.timeline.map(entry => (entry.type === "step" ? { type: "step", step: fix(entry.step) } : entry));
          steps = timeline.filter(entry => entry.type === "step").map(entry => entry.step);
        } else {
          // Older saves: steps, then cards, then the text.
          steps = (message.steps || []).map(fix);
          timeline = [
            ...steps.map(step => ({ type: "step", step })),
            ...cards.map(card => ({ type: "card", card })),
            ...(message.content ? [{ type: "text", content: message.content }] : [])
          ];
        }
        return { ...message, steps, cards, timeline, transcript: Array.isArray(message.transcript) ? message.transcript : [], streaming: false, thinking: false };
      }
      return { ...message };
    });
  }

  // Tool results from older turns are trimmed before saving: they can be large (field lists, page
  // layouts) and only the recent ones still shape the conversation.
  function compactTranscript(transcript, keepFull) {
    if (keepFull) {
      return transcript;
    }
    return transcript.map(entry => {
      if (entry.role === "tool" && typeof entry.content === "string" && entry.content.length > MAX_STORED_TOOL_RESULT) {
        return { ...entry, content: `${entry.content.slice(0, MAX_STORED_TOOL_RESULT)}… (older result trimmed)` };
      }
      return entry;
    });
  }

  function serializeHistory() {
    const kept = history.filter(message => !message.error && !message.streaming).slice(-MAX_STORED_MESSAGES);
    const recentAssistants = kept.filter(message => message.role === "assistant").slice(-RECENT_FULL_TRANSCRIPTS);
    return kept.map(message => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          docKey: message.docKey,
          steps: message.steps.map(step => ({ tool: step.tool, label: step.label, status: step.status, undone: Boolean(step.undone) })),
          cards: message.cards,
          timeline: (message.timeline || []).map(entry => entry.type === "step"
            ? { type: "step", step: { tool: entry.step.tool, label: entry.step.label, status: entry.step.status, undone: Boolean(entry.step.undone) } }
            : entry),
          transcript: compactTranscript(message.transcript, recentAssistants.includes(message))
        };
      }
      const { node, ...rest } = message;
      return rest;
    });
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => setItem(HISTORY_KEY, serializeHistory()), 300);
  }

  // ---------- Panel ----------

  function isOpen() {
    return el.appShell.classList.contains("ai-open");
  }

  async function open({ quote: quotedText, region, draft } = {}) {
    el.appShell.classList.add("ai-open");
    el.panel.inert = false;
    el.toggle.setAttribute("aria-expanded", "true");

    await ready;
    if (quotedText) {
      setQuote(quotedText);
    }
    if (region) {
      addRegion(region);
    }
    if (draft) {
      el.input.value = draft;
      autosize();
    }
    renderMessages();
    renderAttachments();
    if (el.settings.hidden) {
      el.input.focus({ preventScroll: true });
    }
  }

  function close() {
    closeMenus();
    recognition?.stop();
    el.appShell.classList.remove("ai-open");
    el.panel.inert = true;
    el.toggle.setAttribute("aria-expanded", "false");
  }

  function updateMeta() {
    const info = host.getDocumentInfo();
    const preset = MODEL_PRESETS.find(entry => entry.id === settings.model);
    el.modelLabel.textContent = preset?.label || settings.model;
    el.modelEffort.textContent = isDeepSeekHost() ? THINKING_LEVELS.find(([value]) => value === settings.thinking)?.[1] || "" : "";
    el.docLabel.textContent = info.pageCount ? truncate(info.name, 24) : "No PDF open";
    el.docLabel.title = info.pageCount ? info.name : "";
    const firstQuestion = history.findLast(message => message.role === "user")?.content;
    el.title.textContent = firstQuestion ? truncate(firstQuestion, 30) : "New chat";
  }

  function setPageFormatChoice(value) {
    for (const button of el.pageFormat.querySelectorAll("[data-format]")) {
      const active = button.dataset.format === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    }
  }

  function chosenPageFormat() {
    return el.pageFormat.querySelector(".is-active")?.dataset.format || "auto";
  }

  function showSettings(visible) {
    closeMenus();
    el.settings.hidden = !visible;
    el.conversation.hidden = visible;
    el.modes.hidden = visible;
    el.panel.classList.toggle("is-settings", visible);
    if (visible) {
      el.key.value = settings.apiKey;
      el.key.type = "password";
      el.keyToggle.setAttribute("aria-pressed", "false");
      el.model.value = settings.model;
      el.baseUrl.value = settings.baseUrl;
      setPageFormatChoice(settings.pageFormat);
      el.allowEdits.checked = settings.allowEdits;
      el.key.focus();
    }
  }

  function setQuote(text) {
    quote = String(text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
    renderAttachments();
  }

  function addRegion(region) {
    if (!region?.box || regions.some(entry => regionKey(entry) === regionKey(region))) {
      return;
    }
    if (regions.length >= MAX_ATTACHED_REGIONS) {
      toast(`Only ${MAX_ATTACHED_REGIONS} regions can be attached`);
      return;
    }
    regions.push({ page: Number(region.page), box: region.box, label: region.label || `Region on p. ${region.page}` });
    renderAttachments();
  }

  function setDocument(key) {
    if (key !== docKey) {
      docKey = key;
      controller?.abort();
      imageCache.clear();
      regions = [];
      setQuote("");
    }
    updateMeta();
    renderMessages();
  }

  function newChat() {
    controller?.abort();
    history = [];
    regions = [];
    setQuote("");
    showSettings(false);
    persist();
    renderMessages();
    el.input.focus();
  }

  // ---------- Modes ----------

  function renderModes() {
    el.modes.innerHTML = MODES.map(mode => `
      <button type="button" role="tab" data-mode="${mode.id}" class="${mode.id === settings.mode ? "is-active" : ""}" aria-selected="${mode.id === settings.mode}" title="${escapeHtml(mode.hint)}">${mode.label}</button>`).join("");
    renderQuickActions();
  }

  function renderQuickActions() {
    const mode = currentMode();
    el.quickActions.innerHTML = mode.commands.map(item => `
      <button type="button" data-command="${item.id}" title="${escapeHtml(item.description)}">${escapeHtml(item.label)}</button>`).join("");
    el.quickActions.hidden = !history.length;
  }

  function findCommand(id) {
    for (const mode of MODES) {
      const found = mode.commands.find(item => item.id === id);
      if (found) {
        return { ...found, mode };
      }
    }
    return null;
  }

  function fillTemplate(prompt) {
    const info = host.getDocumentInfo();
    return prompt.replace(/\{page\}/g, String(info.currentPage || 1)).replace(/\{language\}/g, languageName());
  }

  // Commands put their prompt into the composer so the reader can adjust it, then send with Enter.
  function useCommand(id, { sendNow = false } = {}) {
    const found = findCommand(id);
    if (!found) {
      return;
    }
    closeMenus();
    const text = fillTemplate(found.prompt);
    if (sendNow) {
      send(text);
      return;
    }
    el.input.value = text;
    const caret = text.indexOf('""');
    el.input.focus();
    if (caret !== -1) {
      el.input.setSelectionRange(caret + 1, caret + 1);
    } else {
      el.input.setSelectionRange(text.length, text.length);
    }
    autosize();
    renderAttachments();
  }

  // ---------- Menus ----------

  function closeMenus() {
    for (const menu of menus) {
      menu.hidden = true;
    }
    mention = null;
    command = null;
  }

  function toggleMenu(menu) {
    const opening = menu.hidden;
    closeMenus();
    menu.hidden = !opening;
  }

  function buildAttachMenu() {
    const info = host.getDocumentInfo();
    const selected = getSelectedText?.() || "";
    const disabled = info.pageCount ? "" : "disabled";
    el.attachMenu.innerHTML = `
      <button type="button" role="menuitem" data-attach="current" ${disabled}>Current page<em>@${info.currentPage}</em></button>
      <button type="button" role="menuitem" data-attach="pick" ${disabled}>Choose pages…<em>@</em></button>
      <button type="button" role="menuitem" data-attach="selection" ${selected ? "" : "disabled"}>
        Quote selected text${selected ? `<em>${escapeHtml(truncate(selected, 16))}</em>` : ""}
      </button>
      <hr>
      <button type="button" role="menuitem" data-attach="commands">All actions…<em>/</em></button>`;
  }

  function buildModelMenu() {
    const options = MODEL_PRESETS.some(preset => preset.id === settings.model)
      ? MODEL_PRESETS
      : [...MODEL_PRESETS, { id: settings.model, label: settings.model, hint: "Custom" }];

    let html = options.map(option => `
      <button type="button" role="menuitem" data-model="${escapeHtml(option.id)}" class="${option.id === settings.model ? "is-current" : ""}">
        <span>${escapeHtml(option.label)} <em>${escapeHtml(option.hint)}</em></span>
      </button>`).join("");

    if (isDeepSeekHost()) {
      html += '<hr><div class="menu-label">Thinking</div>' + THINKING_LEVELS.map(([value, label]) => `
        <button type="button" role="menuitem" data-thinking="${value}" class="${value === settings.thinking ? "is-current" : ""}">${label}</button>`).join("");
    }

    el.modelMenu.innerHTML = `${html}<hr><button type="button" role="menuitem" data-ai-action="settings">Custom model & API…</button>`;
  }

  function insertAtCaret(text) {
    const { value, selectionStart: start, selectionEnd: end } = el.input;
    const prefix = start > 0 && !/\s/.test(value[start - 1]) ? " " : "";
    el.input.value = value.slice(0, start) + prefix + text + value.slice(end);
    const caret = start + prefix.length + text.length;
    el.input.focus();
    el.input.setSelectionRange(caret, caret);
    autosize();
    renderAttachments();
  }

  function handleAttach(kind) {
    const info = host.getDocumentInfo();
    if (kind === "current") {
      insertAtCaret(`@${info.currentPage} `);
    } else if (kind === "pick") {
      insertAtCaret("@");
      updateMention();
    } else if (kind === "commands") {
      el.input.value = "/";
      el.input.focus();
      autosize();
      updateCommand();
    } else {
      setQuote(getSelectedText?.() || "");
      el.input.focus();
    }
  }

  // ---------- @ mentions ----------

  function updateMention() {
    const info = host.getDocumentInfo();
    const caret = el.input.selectionStart;
    const match = el.input.value.slice(0, caret).match(/(?:^|\s)@(\d*)$/);
    if (!match || !info.pageCount || el.input.selectionEnd !== caret) {
      closeMention();
      return;
    }

    const query = match[1];
    const items = [];
    if (!query) {
      items.push({ token: `@${info.currentPage}`, label: `Page ${info.currentPage}`, hint: "Current page" });
      for (let page = 1; page <= Math.min(info.pageCount, 8); page += 1) {
        if (page !== info.currentPage) {
          items.push({ token: `@${page}`, label: `Page ${page}`, hint: "" });
        }
      }
      if (info.pageCount > 1 && info.pageCount <= MAX_ATTACHED_PAGES) {
        items.push({ token: `@1-${info.pageCount}`, label: "All pages", hint: `1–${info.pageCount}` });
      }
    } else {
      for (let page = 1; page <= info.pageCount && items.length < 8; page += 1) {
        if (String(page).startsWith(query)) {
          items.push({ token: `@${page}`, label: `Page ${page}`, hint: page === info.currentPage ? "Current page" : "" });
        }
      }
    }

    if (!items.length) {
      closeMention();
      return;
    }

    const active = mention && mention.query === query ? Math.min(mention.active, items.length - 1) : 0;
    mention = { items, active, query, start: caret - query.length - 1, end: caret };
    renderMentionMenu();
  }

  function renderMentionMenu() {
    for (const menu of menus) {
      if (menu !== el.mentionMenu) {
        menu.hidden = true;
      }
    }
    el.mentionMenu.innerHTML = '<div class="menu-label">Attach page</div>' + mention.items.map((item, index) => `
      <button type="button" role="option" data-mention-index="${index}" class="${index === mention.active ? "is-active" : ""}" aria-selected="${index === mention.active}">
        <span>${escapeHtml(item.label)}</span><em>${escapeHtml(item.hint)}</em>
      </button>`).join("");
    el.mentionMenu.hidden = false;
    el.mentionMenu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  function closeMention() {
    mention = null;
    el.mentionMenu.hidden = true;
  }

  function chooseMention(index) {
    const item = mention?.items[index];
    if (!item) {
      return;
    }
    const { value } = el.input;
    el.input.value = `${value.slice(0, mention.start)}${item.token} ${value.slice(mention.end)}`;
    const caret = mention.start + item.token.length + 1;
    closeMention();
    el.input.focus();
    el.input.setSelectionRange(caret, caret);
    autosize();
    renderAttachments();
  }

  // ---------- / commands ----------

  function updateCommand() {
    const match = el.input.value.match(/^\/([\w-]*)$/);
    if (!match) {
      closeCommand();
      return;
    }
    const query = match[1].toLowerCase();
    const items = [];
    for (const mode of MODES) {
      for (const item of mode.commands) {
        const haystack = `${item.id} ${item.label} ${item.description}`.toLowerCase();
        if (!query || haystack.includes(query)) {
          items.push({ ...item, mode });
        }
      }
    }
    if (!items.length) {
      closeCommand();
      return;
    }
    const active = command && command.query === query ? Math.min(command.active, items.length - 1) : 0;
    command = { items, active, query };
    renderCommandMenu();
  }

  function renderCommandMenu() {
    for (const menu of menus) {
      if (menu !== el.commandMenu) {
        menu.hidden = true;
      }
    }
    let html = "";
    let lastMode = null;
    command.items.forEach((item, index) => {
      if (item.mode !== lastMode) {
        html += `<div class="menu-label">${escapeHtml(item.mode.label)}</div>`;
        lastMode = item.mode;
      }
      html += `
        <button type="button" role="option" data-command-index="${index}" class="command-item ${index === command.active ? "is-active" : ""}" aria-selected="${index === command.active}">
          <span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.description)}</small>
        </button>`;
    });
    el.commandMenu.innerHTML = html;
    el.commandMenu.hidden = false;
    el.commandMenu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  function closeCommand() {
    command = null;
    el.commandMenu.hidden = true;
  }

  function chooseCommand(index) {
    const item = command?.items[index];
    closeCommand();
    if (item) {
      useCommand(item.id);
    }
  }

  // ---------- Attachment chips ----------

  function chip(label, key, icon, invalid = false) {
    return `
      <span class="ai-chip${invalid ? " is-invalid" : ""}">
        ${icon}<span>${escapeHtml(label)}</span>
        <button type="button" data-chip-remove="${key}" aria-label="Remove ${escapeHtml(label)}">${ICONS.close}</button>
      </span>`;
  }

  function renderAttachments() {
    const info = host.getDocumentInfo();
    const { tokens, pages } = parseMentions(el.input.value, info.pageCount);
    let html = quote ? chip(`“${truncate(quote, 36)}”`, "quote", ICONS.quote) : "";

    regions.forEach((region, index) => {
      html += chip(truncate(region.label, 30), `region-${index}`, ICONS.region);
    });

    tokens.forEach((token, index) => {
      const label = !token.valid
        ? `No page ${token.from}`
        : token.from === token.to ? `Page ${token.from}` : `Pages ${token.from}–${token.to}`;
      html += chip(label, `token-${index}`, ICONS.page, !token.valid);
    });

    if (pages.length > MAX_ATTACHED_PAGES) {
      html += `<span class="ai-chip is-invalid"><span>Only the first ${MAX_ATTACHED_PAGES} pages are sent</span></span>`;
    }

    el.attachments.innerHTML = html;
    el.attachments.hidden = !html;
  }

  function removeChip(key) {
    if (key === "quote") {
      setQuote("");
    } else if (key.startsWith("region-")) {
      regions.splice(Number(key.replace("region-", "")), 1);
      renderAttachments();
    } else {
      const index = Number(key.replace("token-", ""));
      const token = parseMentions(el.input.value, host.getDocumentInfo().pageCount).tokens[index];
      if (token) {
        const { value } = el.input;
        el.input.value = (value.slice(0, token.start) + value.slice(token.end)).replace(/ {2,}/g, " ").trimStart();
        autosize();
        renderAttachments();
      }
    }
    el.input.focus();
  }

  // ---------- Messages ----------

  function isNearBottom() {
    const { scrollTop, scrollHeight, clientHeight } = el.messages;
    return scrollHeight - scrollTop - clientHeight < 80;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderEmptyState() {
    const mode = currentMode();
    const keyPrompt = settings.apiKey
      ? ""
      : '<button type="button" class="ai-key-prompt" data-ai-action="settings">Add your DeepSeek API key to start</button>';
    el.messages.innerHTML = `
      <div class="ai-empty">
        ${keyPrompt}
        <div class="ai-empty-title">${escapeHtml(mode.label)} mode</div>
        <p class="ai-empty-sub">${escapeHtml(mode.hint)}</p>
        <div class="ai-cards">
          ${mode.commands.map(item => `
            <button type="button" class="ai-action-card" data-command="${item.id}">
              <strong>${escapeHtml(item.label)}</strong>
              <span>${escapeHtml(item.description)}</span>
            </button>`).join("")}
        </div>
        <p class="ai-empty-hint">Type <strong>/</strong> for every action, <strong>@</strong> to attach pages, or hold <strong>⌥</strong> and point at the page to explain it</p>
      </div>`;
  }

  function renderMessages() {
    updateMeta();
    renderQuickActions();

    if (!history.length) {
      renderEmptyState();
      return;
    }

    el.messages.replaceChildren(...history.map(renderMessage));
    scrollToBottom();
  }

  function renderMessage(message) {
    const node = document.createElement("div");
    message.node = node;

    if (message.role === "divider") {
      node.className = "msg divider";
      node.innerHTML = `<span>${ICONS.page}${escapeHtml(truncate(message.docName, 40))}</span>`;
      return node;
    }

    if (message.role === "user") {
      node.className = "msg user";
      if (message.quote) {
        const blockquote = document.createElement("blockquote");
        blockquote.textContent = `“${message.quote}”`;
        node.append(blockquote);
      }
      if (message.regions?.length) {
        const tags = document.createElement("div");
        tags.className = "msg-regions";
        tags.innerHTML = message.regions.map(region => `<span>${ICONS.region}${escapeHtml(truncate(region.label, 28))}</span>`).join("");
        node.append(tags);
      }
      const body = document.createElement("div");
      body.innerHTML = escapeHtml(message.content).replace(MENTION_PATTERN, (_, lead, from, to) => `${lead}<span class="mention">@${from}${to ? `–${to}` : ""}</span>`);
      node.append(body);
    } else if (message.error) {
      node.className = "msg error";
      node.textContent = message.content;
      if (message.retry) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry";
        retry.addEventListener("click", retryLast);
        node.append(retry);
      }
    } else {
      node.className = "msg assistant";
      fillAssistantMessage(node, message);
    }

    return node;
  }

  function renderCard(card, message) {
    const node = document.createElement("div");
    node.className = `ai-card ${card.type}`;

    if (card.type === "checklist") {
      const counts = { error: 0, warning: 0 };
      for (const item of card.items) {
        if (item.severity in counts) {
          counts[item.severity] += 1;
        }
      }
      const summary = counts.error || counts.warning
        ? [counts.error ? `${counts.error} to fix` : "", counts.warning ? `${counts.warning} to check` : ""].filter(Boolean).join(" · ")
        : `${card.items.length} items`;
      node.innerHTML = `<div class="ai-card-head"><strong>${escapeHtml(card.title)}</strong><span>${escapeHtml(summary)}</span></div>`;
      const list = document.createElement("ul");
      list.className = "checklist";
      card.items.forEach((item, index) => {
        const row = document.createElement("li");
        row.className = `is-${item.severity}${item.done ? " is-done" : ""}`;
        row.innerHTML = `
          <button type="button" class="check-toggle" title="Mark as done"><span class="check-icon">${SEVERITY_ICONS[item.severity] || SEVERITY_ICONS.info}</span></button>
          <span class="check-text">${renderInline(item.text)}</span>
          <button type="button" class="check-jump" title="Go to page ${item.page}"><span>p. ${item.page}</span>${ICONS.jump}</button>`;
        row.querySelector(".check-toggle").addEventListener("click", () => {
          item.done = !item.done;
          row.classList.toggle("is-done", item.done);
          persist();
        });
        row.querySelector(".check-jump").addEventListener("click", () => {
          try {
            host.revealBox(item.page, item.box || null);
          } catch (error) {
            toast(error.message);
          }
        });
        list.append(row);
      });
      node.append(list);
      const actions = document.createElement("div");
      actions.className = "ai-card-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy as list";
      copy.addEventListener("click", async () => {
        const text = `${card.title}\n${card.items.map(item => `- [${item.done ? "x" : " "}] ${item.text} (p. ${item.page})`).join("\n")}`;
        try {
          await navigator.clipboard.writeText(text);
          toast("Copied");
        } catch {
          toast("Couldn't copy");
        }
      });
      actions.append(copy);
      node.append(actions);
      return node;
    }

    if (card.type === "redactions") {
      const pending = card.items.filter(item => !item.state);
      node.innerHTML = `<div class="ai-card-head"><strong>Proposed redactions</strong><span>p. ${card.page} · ${pending.length ? `${pending.length} to review` : "reviewed"}</span></div>`;
      const list = document.createElement("ul");
      list.className = "redaction-list";
      for (const item of card.items) {
        const row = document.createElement("li");
        row.className = item.state ? `is-${item.state}` : "";
        row.innerHTML = `
          <span class="redaction-reason">${escapeHtml(item.reason)}</span>
          <span class="redaction-state">${item.state === "approved" ? "Approved" : item.state === "rejected" ? "Rejected" : ""}</span>
          <button type="button" class="check-jump" title="Show on the page">${ICONS.jump}</button>
          ${item.state ? "" : '<button type="button" data-redact="approve">Approve</button><button type="button" data-redact="reject">Reject</button>'}`;
        row.querySelector(".check-jump").addEventListener("click", () => {
          try {
            host.revealBox(card.page, item.box);
          } catch (error) {
            toast(error.message);
          }
        });
        row.querySelector('[data-redact="approve"]')?.addEventListener("click", () => resolveRedactions(card, [item], true, message));
        row.querySelector('[data-redact="reject"]')?.addEventListener("click", () => resolveRedactions(card, [item], false, message));
        list.append(row);
      }
      node.append(list);
      if (pending.length) {
        const actions = document.createElement("div");
        actions.className = "ai-card-actions";
        const approveAll = document.createElement("button");
        approveAll.type = "button";
        approveAll.className = "is-primary";
        approveAll.textContent = `Approve all (${pending.length})`;
        approveAll.addEventListener("click", () => resolveRedactions(card, pending, true, message));
        const rejectAll = document.createElement("button");
        rejectAll.type = "button";
        rejectAll.textContent = "Reject all";
        rejectAll.addEventListener("click", () => resolveRedactions(card, pending, false, message));
        actions.append(approveAll, rejectAll);
        node.append(actions);
      } else if (card.items.some(item => item.state === "approved")) {
        const note = document.createElement("p");
        note.className = "ai-card-note";
        note.textContent = "Approved boxes are black on the page. Download writes an image-only PDF so the text underneath is removed.";
        node.append(note);
      }
      return node;
    }

    return node;
  }

  function resolveRedactions(card, items, approve, message) {
    try {
      host.resolveRedactions(items.map(item => item.id), approve);
      for (const item of items) {
        item.state = approve ? "approved" : "rejected";
      }
      toast(approve ? "Redactions approved" : "Redactions rejected");
    } catch (error) {
      toast(error.message);
    }
    persist();
    if (message.node) {
      fillAssistantMessage(message.node, message);
    }
  }

  function renderStepGroup(entries, message, node) {
    const first = entries[0];
    const steps = entries.map(entry => entry.step);
    const running = steps.some(step => step.status === "running");
    // A single step is shown as is; a run of several folds behind a one-line summary.
    const single = steps.length === 1;
    const open = single || (first.open ?? (message.streaming && running));
    const wrapper = document.createElement("div");
    wrapper.className = `agent-steps${open ? " is-open" : ""}${single ? " is-single" : ""}`;

    const edits = steps.filter(step => step.undo && step.status === "done").length;
    const failed = steps.filter(step => step.status === "error").length;
    const summary = running
      ? "Working…"
      : `${steps.length} step${steps.length === 1 ? "" : "s"}`
        + (edits ? ` · ${edits} edit${edits === 1 ? "" : "s"}` : "")
        + (failed ? ` · ${failed} failed` : "");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-steps-toggle";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = `<span>${escapeHtml(summary)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
    toggle.addEventListener("click", () => {
      first.open = !open;
      fillAssistantMessage(node, message);
    });
    if (!single) {
      wrapper.append(toggle);
    }

    const list = document.createElement("div");
    list.className = "agent-steps-list";
    for (const step of steps) {
      const row = document.createElement("div");
      row.className = `agent-step is-${step.status}${step.undone ? " is-undone" : ""}`;
      const icon = step.status === "running" ? "" : step.status === "error" ? ICONS.error : (TOOL_ICONS[step.tool] || ICONS.check);
      row.innerHTML = `<span class="agent-step-icon">${icon}</span>`;

      const label = document.createElement("span");
      label.className = "agent-step-label";
      label.textContent = step.label;
      row.append(label);

      if (step.undo && step.status === "done" && !message.streaming) {
        const undo = document.createElement("button");
        undo.type = "button";
        undo.textContent = step.undone ? "Undone" : "Undo";
        undo.disabled = Boolean(step.undone);
        undo.addEventListener("click", async () => {
          try {
            await step.undo();
            step.undone = true;
            toast("Change undone");
          } catch (error) {
            toast(`Couldn't undo: ${error.message}`);
          }
          persist();
          fillAssistantMessage(node, message);
        });
        row.append(undo);
      }
      list.append(row);
    }
    wrapper.append(list);
    return wrapper;
  }

  function fillAssistantMessage(node, message) {
    node.replaceChildren();

    const timeline = message.timeline || [];
    let index = 0;
    while (index < timeline.length) {
      const entry = timeline[index];
      if (entry.type === "step") {
        const group = [];
        while (index < timeline.length && timeline[index].type === "step") {
          group.push(timeline[index]);
          index += 1;
        }
        node.append(renderStepGroup(group, message, node));
        continue;
      }
      if (entry.type === "card") {
        node.append(renderCard(entry.card, message));
      } else if (entry.type === "text" && entry.content.trim()) {
        const body = document.createElement("div");
        body.className = "msg-body";
        body.innerHTML = renderMarkdown(entry.content);
        node.append(body);
      }
      index += 1;
    }

    const last = timeline.at(-1);
    const busy = message.streaming && !message.steps.some(step => step.status === "running");
    if (busy && (!last || last.type !== "text" || !last.content.trim())) {
      const thinking = document.createElement("div");
      thinking.className = "thinking";
      thinking.innerHTML = `<i></i><i></i><i></i><span>${message.thinking ? "Thinking…" : "Working…"}</span>`;
      node.append(thinking);
    }

    if (!message.streaming && message.content) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(message.content);
          toast("Copied");
        } catch {
          toast("Couldn't copy");
        }
      });
      actions.append(copy);
      node.append(actions);
    }
  }

  function scheduleUpdate(message) {
    if (updateFrame) {
      return;
    }
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      const pinned = isNearBottom();
      if (message.node) {
        fillAssistantMessage(message.node, message);
      }
      if (pinned) {
        scrollToBottom();
      }
    });
  }

  function setBusy(busy) {
    el.send.classList.toggle("is-stop", busy);
    el.send.innerHTML = busy ? ICONS.stop : ICONS.send;
    el.send.title = busy ? "Stop" : "Send";
    el.send.setAttribute("aria-label", busy ? "Stop" : "Send");
  }

  // ---------- Building requests ----------

  // Page and region images are rendered once per markup revision, then reused across steps and turns.
  function cached(key, render) {
    if (!imageCache.has(key)) {
      if (imageCache.size >= IMAGE_CACHE_LIMIT) {
        imageCache.delete(imageCache.keys().next().value);
      }
      imageCache.set(key, render().catch(error => {
        imageCache.delete(key);
        throw error;
      }));
    }
    return imageCache.get(key);
  }

  function pageImage(page) {
    return cached(`${docKey}|${page}|${host.getRevision()}`, () => host.renderPageImage(page));
  }

  function regionImage(region) {
    return cached(`${docKey}|r|${regionKey(region)}|${host.getRevision()}`, () => host.renderRegionImage(region.page, region.box));
  }

  function describeAttachments(pages, regions) {
    const parts = [];
    if (pages.length) {
      parts.push(formatPages(pages));
    }
    if (regions.length) {
      parts.push(`${regions.length === 1 ? "a region" : `${regions.length} regions`} of ${formatPages([...new Set(regions.map(region => region.page))])}`);
    }
    return parts.join(" and ");
  }

  async function attachmentContent(lead, { pages = [], regions = [], format, withImages, sameDocument, docName }) {
    const label = describeAttachments(pages, regions);
    if (!sameDocument) {
      return `${lead}\n\n(${label} of another document, "${docName}", were attached here earlier.)`;
    }
    if (!withImages) {
      return `${lead}\n\n(${label} ${format === "text" ? "was" : "were"} attached earlier in this conversation.)`;
    }

    if (format === "text") {
      const blocks = [];
      for (const page of pages) {
        const text = (await host.getPageText(page)).trim();
        blocks.push(`[Page ${page} text]\n${text || "(no extractable text on this page)"}`);
      }
      for (const region of regions) {
        blocks.push(`[${region.label}]\n(Regions can't be shown as text; the page's text is above or can be viewed with view_pages.)`);
      }
      return `${lead}\n\n${blocks.join("\n\n")}`;
    }

    const parts = [{ type: "text", text: `${lead}\n\n(Attached: ${label} as images.)` }];
    for (const page of pages) {
      parts.push(
        { type: "text", text: `Page ${page}:` },
        { type: "image_url", image_url: { url: await pageImage(page) } }
      );
    }
    for (const region of regions) {
      parts.push(
        { type: "text", text: `${region.label} (zoomed crop; grid labels are page coordinates):` },
        { type: "image_url", image_url: { url: await regionImage(region) } }
      );
    }
    return parts;
  }

  function buildSystemPrompt(info, format) {
    const seeing = format === "image"
      ? "Pages arrive as images with a faint blue grid labelled 0–1000 (x from the left edge, y from the top edge). Every tool coordinate uses this same grid, so read positions straight off the image."
      : "Pages arrive as extracted text, so you can't see layout, handwriting or pictures. Tool coordinates use a 0–1000 grid (x from the left edge, y from the top edge); get positions from find_text, get_page_layout and list_form_fields.";

    const editing = settings.allowEdits
      ? [
        "You can edit this PDF with tools. Work step by step:",
        "- Forms: call list_form_fields first. If there are real fields, fill them with fill_form_fields. Otherwise type answers with add_text: use find_text to locate each label, then place the answer just right of the label at the same y, or on the blank line below it (top edge a little above the line). For tick boxes that aren't real fields, use draw_shape with \"check\".",
        "- If you need information you don't have (names, dates, ID numbers…), ask the reader instead of inventing it.",
        "- Use highlight_text to highlight, underline or strike through existing text; add_text_layer for translations; report_items for checklists; propose_redactions for hiding personal data.",
        "- After editing, call view_pages once to check the result, fix anything misplaced (delete_markup, then redo it), and finish with a short summary of what you changed. The reader can undo every change and can click any text box to edit it."
      ].join("\n")
      : "Editing tools are turned off in settings, so you can't change the PDF. If the reader asks for edits, explain what you would change.";

    return [
      `You are an AI assistant inside a PDF reader, working on "${info.name}" (${info.pageCount} pages). The reader is currently on page ${info.currentPage}. This chat may also contain earlier questions about other documents; only the current document can be viewed or edited now.`,
      "You only see pages that are attached: the reader attaches them with @ mentions (like @3 or @2-4) or as regions, and you can open any page yourself with view_pages, zoom into a part with view_region, find things with search_document and get_outline. Never guess what a page you haven't seen says.",
      seeing,
      editing,
      currentMode().prompt,
      "When you rely on the document, cite pages inline as [p. 3] or [pp. 3-4]. Reply in the reader's language, concisely, in Markdown (tables are fine)."
    ].join("\n\n");
  }

  async function buildRequestMessages() {
    const info = host.getDocumentInfo();
    const format = pageFormat();
    const turns = history.filter(message => !message.error && message.role !== "divider");

    let first = 0;
    for (let index = turns.length - 1, seen = 0; index >= 0; index -= 1) {
      if (turns[index].role === "user" && ++seen === MAX_HISTORY_TURNS) {
        first = index;
        break;
      }
    }
    const window = turns.slice(first);

    const attachmentEntries = [];
    for (const message of window) {
      if (message.role === "user" && (message.pages.length || message.regions?.length)) {
        attachmentEntries.push(message);
      } else if (message.role === "assistant") {
        attachmentEntries.push(...message.transcript.filter(entry => entry.kind === "pages"));
      }
    }
    const recent = new Set(attachmentEntries.slice(-RECENT_IMAGE_ATTACHMENTS));

    const messages = [{ role: "system", content: buildSystemPrompt(info, format) }];
    for (const message of window) {
      const sameDocument = !message.docKey || message.docKey === docKey;
      if (message.role === "user") {
        const lead = message.quote
          ? `About this passage from the PDF:\n"""\n${message.quote}\n"""\n\n${message.content}`
          : message.content;
        const hasAttachments = message.pages.length || message.regions?.length;
        messages.push({
          role: "user",
          content: hasAttachments
            ? await attachmentContent(lead, { pages: message.pages, regions: message.regions || [], format, withImages: recent.has(message), sameDocument, docName: message.docName })
            : lead
        });
        continue;
      }

      for (const entry of message.transcript) {
        if (entry.kind === "pages") {
          messages.push({
            role: "user",
            content: await attachmentContent("Here is what you asked to see.", {
              pages: entry.pages || [],
              regions: entry.regions || [],
              format,
              withImages: recent.has(entry),
              sameDocument: !entry.docKey || entry.docKey === docKey,
              docName: entry.docName || message.docName || "another document"
            })
          });
        } else {
          messages.push(entry);
        }
      }
    }

    return messages;
  }

  async function describeHttpError(response, hadImages) {
    let detail = "";
    try {
      detail = (await response.json())?.error?.message || "";
    } catch {
      detail = "";
    }

    const hints = {
      401: "Invalid API key — check it in settings.",
      402: "Your DeepSeek account balance is insufficient.",
      429: "Rate limited — wait a moment, then retry.",
      500: "DeepSeek had a server error — try again.",
      503: "DeepSeek is busy right now — try again shortly."
    };
    const parts = [hints[response.status] || `Request failed (HTTP ${response.status}).`, detail];
    if (hadImages && (response.status === 400 || response.status === 422)) {
      parts.push("If this model can't read images, choose DeepSeek Flash, or set “Send pages as” to Text in API settings.");
    }
    return parts.filter(Boolean).join(" ");
  }

  // One streamed model call. Text streams into `reply`; tool calls are collected and returned.
  async function requestTurn(messages, reply, signal, { withTools = true, thinking = settings.thinking } = {}) {
    const body = {
      model: settings.model,
      messages,
      stream: true
    };
    if (withTools) {
      body.tools = tools.definitions(settings.allowEdits);
    }
    if (isDeepSeekHost()) {
      body.thinking = thinking === "none"
        ? { type: "disabled" }
        : { type: "enabled", reasoning_effort: thinking };
    }

    const hadImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw new Error(await describeHttpError(response, hadImages));
    }

    const turn = { content: "", reasoning: "", toolCalls: [] };
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") {
          continue;
        }

        let delta;
        try {
          delta = JSON.parse(trimmed.slice(5)).choices?.[0]?.delta || {};
        } catch {
          continue;
        }

        if (delta.reasoning_content) {
          turn.reasoning += delta.reasoning_content;
          reply.thinking = true;
        }
        if (delta.content) {
          if (!turn.content && reply.content) {
            reply.content += "\n\n";
          }
          appendText(reply, delta.content, !turn.content);
          turn.content += delta.content;
          reply.content += delta.content;
        }
        for (const call of delta.tool_calls || []) {
          const slot = (turn.toolCalls[call.index ?? turn.toolCalls.length] ||= { id: "", name: "", arguments: "" });
          if (call.id) {
            slot.id = call.id;
          }
          if (call.function?.name) {
            slot.name += call.function.name;
          }
          if (call.function?.arguments) {
            slot.arguments += call.function.arguments;
          }
        }
      }

      reply.onUpdate?.(reply);
    }

    turn.toolCalls = turn.toolCalls.filter(Boolean);
    return turn;
  }

  // A stopped or failed run can leave tool calls without results, which the API rejects next turn.
  function sanitizeTranscript(reply) {
    const { transcript } = reply;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry.role === "assistant" && entry.tool_calls) {
        const answered = new Set(transcript.slice(index + 1).filter(item => item.role === "tool").map(item => item.tool_call_id));
        if (entry.tool_calls.some(call => !answered.has(call.id))) {
          transcript.length = index;
        }
        break;
      }
    }
  }

  async function runAgent(reply) {
    controller = new AbortController();
    const { signal } = controller;
    const info = host.getDocumentInfo();
    setBusy(true);
    reply.onUpdate = scheduleUpdate;

    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        const messages = await buildRequestMessages();
        signal.throwIfAborted();
        const turn = await requestTurn(messages, reply, signal);

        // DeepSeek requires reasoning_content to be sent back on later requests that include tools.
        const assistantMessage = { role: "assistant", content: turn.content };
        if (turn.reasoning) {
          assistantMessage.reasoning_content = turn.reasoning;
        }

        if (!turn.toolCalls.length) {
          reply.transcript.push(assistantMessage);
          break;
        }

        assistantMessage.content = turn.content || null;
        assistantMessage.tool_calls = turn.toolCalls.map((call, index) => ({
          id: call.id || `call_${step}_${index}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" }
        }));
        reply.transcript.push(assistantMessage);

        const attachPages = [];
        const attachRegions = [];
        for (const call of assistantMessage.tool_calls) {
          signal.throwIfAborted();
          const view = { tool: call.function.name, label: TOOL_LABELS[call.function.name] || `Running ${call.function.name}…`, status: "running" };
          reply.steps.push(view);
          reply.timeline.push({ type: "step", step: view });
          scheduleUpdate(reply);

          let content;
          try {
            const outcome = await tools.execute(call.function.name, JSON.parse(call.function.arguments || "{}"), { allowEdits: settings.allowEdits });
            view.status = "done";
            view.label = outcome.summary;
            view.undo = outcome.undo;
            attachPages.push(...(outcome.attachPages || []));
            attachRegions.push(...(outcome.attachRegions || []));
            if (outcome.card) {
              reply.cards.push(outcome.card);
              reply.timeline.push({ type: "card", card: outcome.card });
            }
            content = JSON.stringify(outcome.result ?? { ok: true });
          } catch (error) {
            view.status = "error";
            view.label = `${view.label.replace(/…$/, "")} failed: ${error.message}`;
            content = JSON.stringify({ error: error.message });
          }

          reply.transcript.push({ role: "tool", tool_call_id: call.id, content });
          scheduleUpdate(reply);
        }

        if (attachPages.length || attachRegions.length) {
          reply.transcript.push({
            kind: "pages",
            pages: [...new Set(attachPages)].slice(0, MAX_ATTACHED_PAGES),
            regions: attachRegions.slice(0, MAX_ATTACHED_REGIONS),
            docKey,
            docName: info.name
          });
        }
        if (step === MAX_AGENT_STEPS - 1) {
          reply.content += `${reply.content ? "\n\n" : ""}*Stopped after ${MAX_AGENT_STEPS} steps.*`;
        }
      }

      if (!reply.content && !reply.steps.length) {
        reply.content = "*No response.*";
        appendText(reply, reply.content, true);
      }
    } catch (error) {
      sanitizeTranscript(reply);
      if (error.name === "AbortError") {
        if (!reply.content) {
          reply.content = "*Stopped.*";
          appendText(reply, reply.content, true);
        }
      } else {
        const message = error instanceof TypeError
          ? "Couldn't reach the API. Check your connection and the base URL in settings."
          : error.message || "Request failed.";
        const keepReply = reply.steps.length > 0 || Boolean(reply.content);
        if (!keepReply) {
          history = history.filter(entry => entry !== reply);
        }
        history.push({ role: "assistant", error: true, retry: !keepReply, content: message });
      }
    } finally {
      if (updateFrame) {
        cancelAnimationFrame(updateFrame);
        updateFrame = 0;
      }
      reply.streaming = false;
      reply.onUpdate = null;
      if (controller?.signal === signal) {
        controller = null;
      }
      setBusy(false);
      persist();
      renderMessages();
    }
  }

  function newReply() {
    return { role: "assistant", content: "", steps: [], cards: [], timeline: [], transcript: [], streaming: true, thinking: false, docKey };
  }

  // The reply is kept as a timeline (text, tool steps, cards in the order they happened), so the
  // model's short notes between tool calls stay next to the calls they introduce.
  function appendText(reply, text, startNew) {
    if (!reply.timeline) {
      return;
    }
    const last = reply.timeline.at(-1);
    if (startNew || !last || last.type !== "text") {
      reply.timeline.push({ type: "text", content: text });
    } else {
      last.content += text;
    }
  }

  async function send(text) {
    const content = text.trim();
    if (!content || controller) {
      return;
    }

    await ready;
    if (!settings.apiKey) {
      showSettings(true);
      toast("Add your DeepSeek API key first");
      return;
    }

    const info = host.getDocumentInfo();
    if (!info.pageCount) {
      toast("Open a PDF first");
      return;
    }

    let { pages } = parseMentions(content, info.pageCount);
    if (pages.length > MAX_ATTACHED_PAGES) {
      toast(`Only the first ${MAX_ATTACHED_PAGES} pages are attached`);
      pages = pages.slice(0, MAX_ATTACHED_PAGES);
    }

    closeMenus();
    history = history.filter(message => !message.error);
    const lastDoc = history.findLast(message => message.role === "user")?.docKey;
    if (history.length && lastDoc !== docKey) {
      history.push({ role: "divider", docName: info.name, docKey });
    }
    history.push({ role: "user", content, pages, regions, quote, docKey, docName: info.name, at: Date.now() });
    quote = "";
    regions = [];
    el.input.value = "";
    autosize();
    renderAttachments();

    const reply = newReply();
    history.push(reply);
    renderMessages();
    await runAgent(reply);
  }

  function retryLast() {
    if (controller) {
      return;
    }
    history = history.filter(message => !message.error);
    if (history.at(-1)?.role !== "user") {
      return;
    }
    const reply = newReply();
    history.push(reply);
    renderMessages();
    runAgent(reply);
  }

  // One-off question about an image (used by the ⌥ explain lens): no history, no tools, streams text back.
  async function quickAsk({ image, prompt, signal, onUpdate }) {
    await ready;
    if (!settings.apiKey) {
      showSettings(true);
      open();
      throw new Error("Add your DeepSeek API key first.");
    }
    const info = host.getDocumentInfo();
    const messages = [
      { role: "system", content: `You are a helpful assistant inside a PDF reader; the reader is looking at "${info.name}". Answer briefly in Markdown, without preamble.` },
      {
        role: "user",
        content: pageFormat() === "text"
          ? `${prompt}\n\n(The image can't be sent to this text-only model; rely on the extracted text above, or say that you can't see the image.)`
          : [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }]
      }
    ];
    const reply = { content: "", onUpdate: current => onUpdate?.(current.content) };
    await requestTurn(messages, reply, signal, { withTools: false, thinking: "none" });
    onUpdate?.(reply.content);
    return reply.content;
  }

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
  }

  // ---------- Block cards (flashcards, CSV) ----------

  async function copyText(text, message = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast("Couldn't copy");
    }
  }

  function handleBlockAction(action, block) {
    const base = (host.getDocumentInfo().name || "document").replace(/\.pdf$/i, "");
    if (block.kind === "flashcards") {
      const cards = parseFlashcards(block.text);
      const tsv = cards.map(card => `${card.question.replace(/\t/g, " ")}\t${card.answer.replace(/\t/g, " ")}`).join("\n");
      if (action === "copy-tsv") {
        copyText(tsv, "Copied as tab-separated cards");
      } else if (action === "copy-md") {
        copyText(cards.map(card => `- **${card.question}**\n  ${card.answer}`).join("\n"));
      } else if (action === "download-tsv") {
        downloadText(`${base} flashcards.tsv`, `${tsv}\n`, "text/tab-separated-values");
      }
    } else if (block.kind === "csv") {
      const rows = parseCsv(block.text);
      if (action === "copy-csv") {
        copyText(block.text.trim());
      } else if (action === "copy-tsv-table") {
        copyText(rows.map(cells => cells.map(cell => cell.replace(/\t/g, " ")).join("\t")).join("\n"), "Copied; paste into a spreadsheet");
      } else if (action === "download-csv") {
        downloadText(`${base} table.csv`, `${block.text.trim()}\n`, "text/csv");
      }
    }
  }

  // ---------- Dictation ----------

  function toggleDictation() {
    if (recognition) {
      recognition.stop();
      return;
    }

    const base = el.input.value.trim() ? `${el.input.value.trimEnd()} ` : "";
    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.addEventListener("result", event => {
      el.input.value = base + [...event.results].map(result => result[0].transcript).join("");
      autosize();
      renderAttachments();
    });
    recognition.addEventListener("error", event => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast("Microphone access is blocked for dictation");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        toast("Dictation stopped");
      }
    });
    recognition.addEventListener("end", () => {
      recognition = null;
      el.mic.classList.remove("is-listening");
      el.input.focus();
    });

    el.mic.classList.add("is-listening");
    recognition.start();
  }

  // ---------- Events ----------

  el.toggle.addEventListener("click", () => (isOpen() ? close() : open()));
  el.close.addEventListener("click", close);
  el.titleButton.addEventListener("click", () => toggleMenu(el.titleMenu));
  el.attach.addEventListener("click", () => {
    buildAttachMenu();
    toggleMenu(el.attachMenu);
  });
  el.modelButton.addEventListener("click", () => {
    buildModelMenu();
    toggleMenu(el.modelMenu);
  });
  el.settingsButton.addEventListener("click", () => showSettings(el.settings.hidden));
  el.settingsCancel.addEventListener("click", () => showSettings(false));
  el.keyToggle.addEventListener("click", () => {
    const show = el.key.type === "password";
    el.key.type = show ? "text" : "password";
    el.keyToggle.setAttribute("aria-pressed", String(show));
    el.keyToggle.title = show ? "Hide key" : "Show key";
    el.key.focus();
  });
  el.pageFormat.addEventListener("click", event => {
    const button = event.target.closest("[data-format]");
    if (button) {
      setPageFormatChoice(button.dataset.format);
    }
  });
  el.mic.addEventListener("click", toggleDictation);
  el.mentionMenu.addEventListener("pointerdown", event => event.preventDefault());
  el.commandMenu.addEventListener("pointerdown", event => event.preventDefault());

  document.addEventListener("pointerdown", event => {
    if (!event.target.closest?.(".ai-menu, [data-menu-trigger]")) {
      closeMenus();
    }
  });

  el.panel.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) {
      return;
    }

    const { dataset } = button;
    if (dataset.aiAction === "new") {
      closeMenus();
      newChat();
    } else if (dataset.aiAction === "settings") {
      closeMenus();
      showSettings(true);
    } else if (dataset.mode) {
      await saveSettings({ mode: dataset.mode });
      renderModes();
      if (!history.length) {
        renderMessages();
      }
    } else if (dataset.command) {
      useCommand(dataset.command);
    } else if (dataset.attach) {
      closeMenus();
      handleAttach(dataset.attach);
    } else if (dataset.model) {
      closeMenus();
      await saveSettings({ model: dataset.model });
    } else if (dataset.thinking) {
      closeMenus();
      await saveSettings({ thinking: dataset.thinking });
    } else if (dataset.mentionIndex !== undefined) {
      chooseMention(Number(dataset.mentionIndex));
    } else if (dataset.commandIndex !== undefined) {
      chooseCommand(Number(dataset.commandIndex));
    } else if (dataset.chipRemove) {
      removeChip(dataset.chipRemove);
    } else if (dataset.prompt) {
      send(dataset.prompt);
    } else if (dataset.blockAction) {
      const block = blockStore.get(button.closest("[data-block-id]")?.dataset.blockId);
      if (block) {
        handleBlockAction(dataset.blockAction, block);
      }
    } else if (button.classList.contains("cite")) {
      try {
        host.goToPage(Number(dataset.page));
      } catch (error) {
        toast(error.message);
      }
    }
  });

  el.settings.addEventListener("submit", async event => {
    event.preventDefault();
    await saveSettings({
      apiKey: el.key.value.trim(),
      model: el.model.value.trim() || DEFAULT_SETTINGS.model,
      baseUrl: (el.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
      pageFormat: chosenPageFormat(),
      allowEdits: el.allowEdits.checked
    });
    showSettings(false);
    renderMessages();
    toast(settings.apiKey ? "AI settings saved" : "API key removed");
    el.input.focus();
  });

  el.form.addEventListener("submit", event => {
    event.preventDefault();
    if (controller) {
      controller.abort();
    } else {
      send(el.input.value);
    }
  });

  el.input.addEventListener("input", () => {
    autosize();
    updateMention();
    updateCommand();
    renderAttachments();
  });
  el.input.addEventListener("click", updateMention);
  el.input.addEventListener("keyup", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      updateMention();
    }
  });
  el.input.addEventListener("keydown", event => {
    const activeMenu = mention && !el.mentionMenu.hidden ? "mention" : command && !el.commandMenu.hidden ? "command" : null;
    if (activeMenu) {
      const state = activeMenu === "mention" ? mention : command;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = state.items.length;
        state.active = (state.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        if (activeMenu === "mention") {
          renderMentionMenu();
        } else {
          renderCommandMenu();
        }
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.isComposing) {
        event.preventDefault();
        if (activeMenu === "mention") {
          chooseMention(state.active);
        } else {
          chooseCommand(state.active);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMention();
        closeCommand();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      el.form.requestSubmit();
    }
  });

  el.panel.addEventListener("keydown", event => {
    if (event.key !== "Escape") {
      return;
    }
    event.stopPropagation();
    if (menus.some(menu => !menu.hidden)) {
      closeMenus();
    } else if (!el.settings.hidden) {
      showSettings(false);
    } else {
      close();
    }
  });

  return { close, isOpen, open, setDocument, quickAsk, useCommand };
}
