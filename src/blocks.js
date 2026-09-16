// Notebook pages as blocks, and the Markdown they come from and go back to. The assistant writes
// Markdown; the editor works on blocks whose text keeps inline Markdown (bold, links, [p. 3]
// citations), so a page can always be copied or exported as plain Markdown. No DOM or imports here.

export const TEXT_TYPES = new Set(["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "callout"]);
export const LIST_TYPES = new Set(["bullet", "numbered", "todo"]);
export const MAX_INDENT = 3;

let counter = 0;

export function blockId() {
  counter += 1;
  return `blk-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function createBlock(type = "paragraph", fields = {}) {
  const block = { id: blockId(), type };
  if (TEXT_TYPES.has(type) || type === "code") {
    block.text = "";
  }
  if (LIST_TYPES.has(type)) {
    block.indent = 0;
  }
  if (type === "todo") {
    block.checked = false;
  }
  if (type === "code") {
    block.language = "";
  }
  if (type === "table") {
    block.rows = [["", ""], ["", ""], ["", ""]];
  }
  if (type === "flashcards") {
    block.cards = [{ question: "", answer: "" }];
  }
  return { ...block, ...fields };
}

// ---------- Markdown → blocks ----------

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\](?:\s+(.*))?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const CALLOUT = /^(?:\[!(?:note|tip|info|important|warning|caution)\]\s*|(?:💡|⚠️|ℹ️|📌|❗)\s*)/iu;

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

function tableBlock(rows) {
  const width = Math.max(1, ...rows.map(row => row.length));
  return createBlock("table", { rows: rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? "")) });
}

export function parseFlashcards(text) {
  return String(text ?? "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s*::\s*|\s*\|\s*(?=[^|]*$)/);
    return parts.length >= 2 ? { question: parts[0].replace(/^[-*\d.)\s]+/, ""), answer: parts.slice(1).join(" ") } : null;
  }).filter(Boolean);
}

export function parseCsv(text) {
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

function escapeCellText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/[*`]/g, "\\$&");
}

function fenceBlock(language, code) {
  if (language === "flashcards") {
    const cards = parseFlashcards(code);
    if (cards.length) {
      return createBlock("flashcards", { cards });
    }
  }
  if (language === "csv") {
    const rows = parseCsv(code);
    if (rows.length) {
      return tableBlock(rows.map(row => row.map(escapeCellText)));
    }
  }
  return createBlock("code", { text: code, language });
}

export function markdownToBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match;

    if ((match = line.match(FENCE))) {
      paragraph = null;
      const marker = match[1];
      const body = [];
      index += 1;
      while (index < lines.length) {
        const closing = lines[index].match(FENCE);
        if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length && !closing[2]) {
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      blocks.push(fenceBlock(match[2].toLowerCase(), body.join("\n")));
    } else if (!line.trim()) {
      paragraph = null;
    } else if ((match = line.match(HEADING))) {
      paragraph = null;
      blocks.push(createBlock(`heading${Math.min(match[1].length, 3)}`, { text: match[2] }));
    } else if (RULE.test(line)) {
      paragraph = null;
      blocks.push(createBlock("divider"));
    } else if (line.includes("|") && index + 1 < lines.length && lines[index + 1].includes("|") && TABLE_DIVIDER.test(lines[index + 1])) {
      paragraph = null;
      const rows = [splitCells(line)];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitCells(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(tableBlock(rows));
    } else if ((match = line.match(LIST_ITEM))) {
      paragraph = null;
      const indent = Math.min(MAX_INDENT, Math.floor(match[1].replace(/\t/g, "  ").length / 2));
      const task = match[3].match(TASK);
      if (task) {
        blocks.push(createBlock("todo", { text: task[2] ?? "", checked: task[1] !== " ", indent }));
      } else {
        blocks.push(createBlock(/\d/.test(match[2]) ? "numbered" : "bullet", { text: match[3], indent }));
      }
    } else if ((match = line.match(/^\s*>\s?(.*)$/))) {
      paragraph = null;
      const parts = [match[1]];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].replace(/^\s*>\s?/, ""));
      }
      const text = parts.join("\n").trim();
      const callout = text.match(CALLOUT);
      blocks.push(callout
        ? createBlock("callout", { text: text.slice(callout[0].length).trim() })
        : createBlock("quote", { text }));
    } else if (/^\s{2,}\S/.test(line) && LIST_TYPES.has(blocks.at(-1)?.type) && !paragraph) {
      // A wrapped continuation of the list item above.
      blocks.at(-1).text += ` ${line.trim()}`;
    } else if (paragraph) {
      paragraph.text += `\n${line.trim()}`;
    } else {
      paragraph = createBlock("paragraph", { text: line.trim() });
      blocks.push(paragraph);
    }
  }
  return blocks;
}

// ---------- Blocks → Markdown ----------

// The number shown beside each numbered item; a run restarts after any other block at its depth.
export function listNumbers(blocks) {
  const numbers = new Map();
  const counts = [];
  for (const block of blocks) {
    if (!LIST_TYPES.has(block.type)) {
      counts.length = 0;
      continue;
    }
    const depth = block.indent || 0;
    counts.length = depth + 1;
    if (block.type === "numbered") {
      counts[depth] = (counts[depth] || 0) + 1;
      numbers.set(block.id, counts[depth]);
    } else {
      counts[depth] = 0;
    }
  }
  return numbers;
}

function tableMarkdown(rows) {
  const line = cells => `| ${cells.map(cell => String(cell ?? "").replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

function fence(language, text) {
  const marker = /```/.test(text) ? "~~~~" : "```";
  return `${marker}${language}\n${text.replace(/\n$/, "")}\n${marker}`;
}

function blockMarkdown(block, numbers) {
  const text = block.text ?? "";
  const pad = "  ".repeat(block.indent || 0);
  const continued = value => value.replace(/\n/g, `\n${pad}  `);
  switch (block.type) {
    case "heading1":
    case "heading2":
    case "heading3":
      return `${"#".repeat(Number(block.type.slice(-1)))} ${text.replace(/\n/g, " ")}`;
    case "bullet":
      return `${pad}- ${continued(text)}`;
    case "numbered":
      return `${pad}${numbers.get(block.id) || 1}. ${continued(text)}`;
    case "todo":
      return `${pad}- [${block.checked ? "x" : " "}] ${continued(text)}`;
    case "quote":
      return text.split("\n").map(line => `> ${line}`.trimEnd()).join("\n");
    case "callout":
      return text.split("\n").map((line, index) => `> ${index ? "" : "💡 "}${line}`.trimEnd()).join("\n");
    case "divider":
      return "---";
    case "code":
      return fence(block.language || "", text);
    case "table":
      return tableMarkdown(block.rows || []);
    case "flashcards":
      return fence("flashcards", (block.cards || [])
        .filter(card => card.question.trim() || card.answer.trim())
        .map(card => `${card.question.replace(/\n/g, " ")} :: ${card.answer.replace(/\n/g, " ")}`)
        .join("\n"));
    default:
      return text;
  }
}

export function blocksToMarkdown(blocks) {
  const numbers = listNumbers(blocks);
  let markdown = "";
  let previous = null;
  for (const block of blocks) {
    if (previous) {
      markdown += LIST_TYPES.has(previous.type) && LIST_TYPES.has(block.type) ? "\n" : "\n\n";
    }
    markdown += blockMarkdown(block, numbers);
    previous = block;
  }
  return markdown;
}

// ---------- Inline Markdown ----------

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

const CITE = /^\[((?:pp?\.|page)\s*(\d+)(?:\s*[-–,;]\s*\d+)*)\]/i;
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

// Where `mark` closes, skipping escapes and code spans; -1 when it never does.
function findClose(source, mark, from) {
  let index = from;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index) {
        index = end + 1;
        continue;
      }
    }
    if (source.startsWith(mark, index)) {
      if (mark.length === 1 && source[index + 1] === mark) {
        index += 2;
        continue;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

// Everything is escaped, so only the tags built here reach the DOM. Citations become atoms the
// editor can't type into; `citeLabel` names them in the reader's language.
export function inlineToHtml(source, { citeLabel = raw => raw } = {}) {
  const text = String(source ?? "");
  let html = "";
  let buffer = "";
  let index = 0;
  const flush = () => {
    html += escapeHtml(buffer);
    buffer = "";
  };
  const wrapped = (mark, tag) => {
    const end = findClose(text, mark, index + mark.length);
    if (end > index + mark.length && !/\s/.test(text[index + mark.length]) && !/\s/.test(text[end - 1])) {
      if (mark === "_" && /\w/.test(text[end + 1] || "")) {
        return false;
      }
      flush();
      html += `<${tag}>${inlineToHtml(text.slice(index + mark.length, end), { citeLabel })}</${tag}>`;
      index = end + mark.length;
      return true;
    }
    return false;
  };

  while (index < text.length) {
    const character = text[index];
    if (character === "\\" && /[\\*_`~[\]]/.test(text[index + 1] || "")) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (character === "\n") {
      flush();
      html += "<br>";
      index += 1;
      continue;
    }
    if (character === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        html += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      if (wrapped(text.slice(index, index + 2), "strong")) {
        continue;
      }
      buffer += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text.startsWith("~~", index) && wrapped("~~", "s")) {
      continue;
    }
    if ((character === "*" || (character === "_" && !/\w/.test(text[index - 1] || ""))) && wrapped(character, "em")) {
      continue;
    }
    if (character === "[") {
      const rest = text.slice(index);
      let match = rest.match(CITE);
      if (match) {
        flush();
        html += `<span class="be-cite" contenteditable="false" data-md="${escapeHtml(match[0])}" data-page="${Number(match[2])}">${escapeHtml(citeLabel(match[1], Number(match[2])))}</span>`;
        index += match[0].length;
        continue;
      }
      match = rest.match(LINK);
      if (match) {
        flush();
        html += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${inlineToHtml(match[1], { citeLabel })}</a>`;
        index += match[0].length;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();
  return html;
}

// Inline Markdown without its marks, for plain-text copies (flashcards to Anki, tables to CSV).
export function inlineToPlain(source) {
  return String(source ?? "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[^\w\\])[*_](?=\S)|(?<=\S)[*_](?!\w)/g, "$1")
    .replace(/\\([\\*_`~[\]])/g, "$1");
}

// Plain text written as inline Markdown: marks the parser would read are escaped.
export function escapeInline(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[*`]/g, "\\$&")
    .replace(/~~/g, "\\~\\~")
    .replace(/(^|[^\w])_/g, "$1\\_")
    .replace(/\[(?=pp?\.\s*\d|[^\]]*\]\()/gi, "\\[");
}
