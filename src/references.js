// Pop-out references: "see Figure 2", "Table 3", "Section 4.1", "Eq. (5)" and "[12]" in the text become
// clickable, and open a floating card with the target (a crop of the figure/table, the section text,
// or the reference entry) so the reader doesn't lose their place. Heuristic, no AI needed.

import { t } from "./i18n.js";

const REF_PATTERN = /\b(Fig(?:ure|s)?\.?|Figs?\.|Table|Tab\.|Section|Sec\.|§|Eq(?:uation|s)?\.?|Appendix|Algorithm|Theorem|Lemma|Chapter)\s*~?\(?(\d+(?:\.\d+)*[a-z]?)\)?/gi;
const CITE_PATTERN = /\[(\d{1,3})(?:\s*[,;–-]\s*\d{1,3})*\]/g;
const MAX_REFS_PER_PAGE = 120;

function kindOf(word) {
  const key = word.toLowerCase();
  if (key.startsWith("fig")) {
    return "figure";
  }
  if (key.startsWith("tab")) {
    return "table";
  }
  if (key.startsWith("eq")) {
    return "equation";
  }
  return "section";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findItemIndex(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

// Rectangles (page units) covering text[start, end) using the text layer's item boxes.
function rectsFor(data, start, end) {
  const rects = [];
  for (let item = findItemIndex(data.starts, start); item < data.starts.length && data.starts[item] < end; item += 1) {
    const length = data.strings[item].length;
    const from = Math.max(start, data.starts[item]) - data.starts[item];
    const to = Math.min(end, data.starts[item] + length) - data.starts[item];
    if (!length || to <= from) {
      continue;
    }
    const box = data.boxes[item];
    rects.push({ x: box.x + (box.width * from) / length, y: box.y, width: (box.width * (to - from)) / length, height: box.height });
  }
  return rects;
}

// Merges rectangles that sit on the same text line; rectangles on different lines stay separate.
function mergeSameLine(rects) {
  const merged = [];
  for (const rect of rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = merged.at(-1);
    const overlap = last ? Math.min(last.y + last.height, rect.y + rect.height) - Math.max(last.y, rect.y) : 0;
    if (last && overlap > Math.min(last.height, rect.height) * 0.5) {
      const right = Math.max(last.x + last.width, rect.x + rect.width);
      const bottom = Math.max(last.y + last.height, rect.y + rect.height);
      last.x = Math.min(last.x, rect.x);
      last.y = Math.min(last.y, rect.y);
      last.width = right - last.x;
      last.height = bottom - last.y;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createReferences(host, { onExplain } = {}) {
  let card = null;
  let current = null;
  let token = 0;
  const resolved = new Map();

  // ---------- Detection ----------

  function isCaption(data, match) {
    const atItemStart = data.starts.includes(match.index);
    const after = data.text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    return atItemStart && (/^[\s]*[:.\-—–|]/.test(after) || after.trim() === "");
  }

  async function attach(page, loadToken) {
    if (page.refsStarted) {
      return;
    }
    page.refsStarted = true;

    let geometry;
    try {
      geometry = await host.textGeometry(page.number);
    } catch {
      return;
    }
    if (loadToken !== host.loadToken()) {
      return;
    }

    const { data } = geometry;
    const found = [];
    for (const match of data.text.matchAll(REF_PATTERN)) {
      if (isCaption(data, match)) {
        continue;
      }
      found.push({ start: match.index, end: match.index + match[0].length, kind: kindOf(match[1]), number: match[2], label: match[0].replace(/\s+/g, " ") });
    }
    for (const match of data.text.matchAll(CITE_PATTERN)) {
      found.push({ start: match.index, end: match.index + match[0].length, kind: "citation", number: match[1], label: match[0] });
    }
    if (!found.length) {
      return;
    }

    const layer = document.createElement("div");
    layer.className = "ref-layer";
    page.refLayer = layer;
    for (const ref of found.slice(0, MAX_REFS_PER_PAGE)) {
      // One hit area per line, so a reference that wraps doesn't get one box spanning both lines.
      for (const box of mergeSameLine(rectsFor(data, ref.start, ref.end))) {
        if (box.width <= 0 || box.height <= 0) {
          continue;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ref-hit";
        button.title = t("Open {label}", { label: ref.label });
        button.style.left = `${(box.x / page.width) * 100}%`;
        button.style.top = `${(box.y / page.height) * 100}%`;
        button.style.width = `${(box.width / page.width) * 100}%`;
        button.style.height = `${(box.height / page.height) * 100}%`;
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          open(ref, page.number, button.getBoundingClientRect());
        });
        layer.append(button);
      }
    }
    page.shell.append(layer);
  }

  // ---------- Lookup ----------

  function pagesNear(fromPage, fromEnd = false) {
    const pages = host.pages();
    if (fromEnd) {
      return pages.slice().reverse();
    }
    const ordered = [];
    for (let distance = 0; ordered.length < pages.length; distance += 1) {
      const lower = fromPage - distance;
      const upper = fromPage + distance;
      if (lower >= 1) {
        ordered.push(pages[lower - 1]);
      }
      if (distance && upper <= pages.length) {
        ordered.push(pages[upper - 1]);
      }
    }
    return ordered;
  }

  function resolveCached(ref, fromPage) {
    const key = `${ref.kind}:${ref.number}:${fromPage}`;
    if (!resolved.has(key)) {
      resolved.set(key, resolve(ref, fromPage).catch(error => {
        resolved.delete(key);
        throw error;
      }));
    }
    return resolved.get(key);
  }

  async function findItem(fromPage, test, { fromEnd = false } = {}) {
    for (const page of pagesNear(fromPage, fromEnd)) {
      let geometry;
      try {
        geometry = await host.textGeometry(page.number);
      } catch {
        continue;
      }
      const { data } = geometry;
      for (let index = 0; index < data.strings.length; index += 1) {
        if (test(data.strings[index].trim(), index, data)) {
          return { page, data, index, box: data.boxes[index] };
        }
      }
    }
    return null;
  }

  // Text that bounds a figure or table: paragraphs, longer lines and headings (axis labels are short).
  async function paragraphBlocks(pageNumber) {
    const { blocks } = await host.layout(pageNumber);
    return blocks.filter(block => block.box.width > 0 && (block.lineCount >= 2 || block.text.length > 60 || block.fontSize >= 13));
  }

  async function resolve(ref, fromPage) {
    const number = escapeRegExp(ref.number);

    if (ref.kind === "figure" || ref.kind === "table") {
      const word = ref.kind === "figure" ? "fig(?:ure|\\.)?" : "tab(?:le|\\.)";
      // A caption is "Figure 1:" / "Figure 1." / "Figure 1" alone; running text like "Figure 1 shows" is not.
      const strict = new RegExp(`^${word}\\s*${number}(?![\\d.]\\d)(?:\\s*[:.\\-—–|]|\\s*$)`, "i");
      const loose = new RegExp(`^${word}\\s*${number}(?![\\d.]\\d)(?!\\s+[a-z])`, "i");
      const hit = await findItem(fromPage, text => strict.test(text)) || await findItem(fromPage, text => loose.test(text));
      if (!hit) {
        return null;
      }
      const { page, box } = hit;
      const blocks = await paragraphBlocks(page.number);
      let region;
      if (ref.kind === "figure") {
        const above = blocks.filter(block => block.box.y + block.box.height < box.y - 4 && block.box.y !== box.y).sort((a, b) => b.box.y - a.box.y)[0];
        const top = Math.max(above ? above.box.y + above.box.height + 3 : 0, box.y - page.height * 0.6);
        region = { x: page.width * 0.04, y: top, width: page.width * 0.92, height: box.y + box.height * 1.4 - top };
      } else {
        const below = blocks.filter(block => block.box.y > box.y + box.height + 4).sort((a, b) => a.box.y - b.box.y)[0];
        const bottom = Math.min(below ? below.box.y - 3 : page.height, box.y + page.height * 0.6);
        region = { x: page.width * 0.04, y: Math.max(0, box.y - box.height * 0.4), width: page.width * 0.92, height: bottom - box.y + box.height * 0.4 };
      }
      return { page: page.number, region, title: t(ref.kind === "figure" ? "Figure {number}" : "Table {number}", { number: ref.number }) };
    }

    if (ref.kind === "equation") {
      const pattern = new RegExp(`^\\(${number}\\)$`);
      const hit = await findItem(fromPage, text => pattern.test(text));
      if (!hit) {
        return null;
      }
      const { page, box } = hit;
      const pad = box.height * 2.2;
      return {
        page: page.number,
        region: { x: page.width * 0.06, y: Math.max(0, box.y - pad), width: page.width * 0.88, height: box.height + pad * 2 },
        title: t("Equation ({number})", { number: ref.number })
      };
    }

    if (ref.kind === "citation") {
      const bracket = new RegExp(`^\\[${number}\\]`);
      const dotted = new RegExp(`^${number}\\.\\s`);
      const hit = await findItem(fromPage, text => bracket.test(text), { fromEnd: true })
        || await findItem(fromPage, text => dotted.test(text), { fromEnd: true });
      if (!hit) {
        return null;
      }
      const start = hit.data.starts[hit.index];
      const text = hit.data.text.slice(start, start + 420).replace(/\s+/g, " ");
      return { page: hit.page.number, box: hit.box, text: text.length >= 420 ? `${text}…` : text, title: t("Reference [{number}]", { number: ref.number }) };
    }

    // Sections, appendices, theorems: try the outline first, then a heading in the text.
    const outline = await host.outline();
    const entry = outline.find(item => item.page && new RegExp(`^(?:[A-Za-z]+\\s+)?${number}(?![\\d.]\\d)`).test(item.title.trim()));
    if (entry) {
      const heading = await findItem(entry.page, text => text.startsWith(entry.title.trim().slice(0, 24)));
      const snippet = heading ? await snippetAt(heading) : "";
      return { page: entry.page, box: heading?.box, text: snippet, title: entry.title };
    }
    const pattern = new RegExp(`^${number}\\.?\\s+\\S`);
    const hit = await findItem(fromPage, (text, index, data) => pattern.test(text) && data.boxes[index].height >= 9);
    if (!hit) {
      return null;
    }
    return { page: hit.page.number, box: hit.box, text: await snippetAt(hit), title: `${ref.label}` };
  }

  async function snippetAt(hit) {
    const start = hit.data.starts[hit.index];
    const text = hit.data.text.slice(start, start + 520).replace(/\s+/g, " ");
    return text.length >= 520 ? `${text}…` : text;
  }

  // ---------- Card ----------

  function ensureCard() {
    if (card) {
      return card;
    }
    card = document.createElement("div");
    card.className = "ref-card glass";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="ref-card-head">
        <strong class="ref-card-title"></strong>
        <button type="button" class="ref-card-page" title="${t("Go to page")}"></button>
        <button type="button" class="ref-card-close panel-icon-button" aria-label="${t("Close")}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
      </div>
      <div class="ref-card-body"></div>
      <div class="ref-card-actions">
        <button type="button" class="text-button" data-ref="go">${t("Go there")}</button>
        <button type="button" class="text-button" data-ref="explain">${t("Explain")}</button>
      </div>`;
    card.addEventListener("pointerdown", event => event.stopPropagation());
    card.querySelector(".ref-card-close").addEventListener("click", close);
    card.querySelector(".ref-card-page").addEventListener("click", goThere);
    card.querySelector('[data-ref="go"]').addEventListener("click", goThere);
    card.querySelector('[data-ref="explain"]').addEventListener("click", () => {
      if (current?.page && (current.region || current.box)) {
        onExplain?.(current.page, current.region || current.box, current.text || "");
        close();
      }
    });
    host.stage.append(card);
    return card;
  }

  function goThere() {
    if (!current?.page) {
      return;
    }
    const box = current.region || current.box;
    host.goToPage(current.page, box ? Math.max(0, box.y - 40) : 0);
    if (box) {
      window.setTimeout(() => host.flashBox(current.page, box), 350);
    }
  }

  function position(anchor) {
    const stage = host.stage.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = anchor.left - stage.left;
    let top = anchor.bottom - stage.top + 10;
    if (top + height > stage.height - 12) {
      top = Math.max(12, anchor.top - stage.top - height - 10);
    }
    const area = host.uncovered?.() || { left: 0, right: stage.width };
    left = clamp(left, area.left + 12, Math.max(area.left + 12, area.right - width - 12));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  async function open(ref, fromPage, anchor) {
    const element = ensureCard();
    const myToken = ++token;
    current = { ref, fromPage };
    element.hidden = false;
    element.querySelector(".ref-card-title").textContent = ref.label;
    element.querySelector(".ref-card-page").textContent = "";
    element.querySelector(".ref-card-body").innerHTML = `<div class="ref-card-loading">${t("Looking for it…")}</div>`;
    element.querySelector(".ref-card-actions").hidden = true;
    position(anchor);

    let result = null;
    try {
      result = await resolveCached(ref, fromPage);
    } catch (error) {
      console.warn("Reference lookup failed", error);
    }
    if (myToken !== token) {
      return;
    }

    const body = element.querySelector(".ref-card-body");
    if (!result) {
      body.innerHTML = `<div class="ref-card-loading">${t("Couldn't find {label} in this document.", { label: escape(ref.label) })}</div>`;
      position(anchor);
      return;
    }

    current = { ...current, ...result };
    element.querySelector(".ref-card-title").textContent = result.title || ref.label;
    element.querySelector(".ref-card-page").textContent = t("p. {page}", { page: result.page });
    element.querySelector(".ref-card-actions").hidden = false;

    if (result.region) {
      try {
        const { dataUrl, box } = await host.renderRegion(result.page, result.region, { longSide: 900 });
        if (myToken !== token) {
          return;
        }
        current.region = box;
        const image = document.createElement("img");
        image.alt = result.title;
        image.src = dataUrl;
        image.addEventListener("load", () => position(anchor), { once: true });
        body.replaceChildren(image);
      } catch {
        body.innerHTML = `<div class="ref-card-loading">${t("Couldn't render that part of the page.")}</div>`;
      }
    } else {
      const text = document.createElement("p");
      text.className = "ref-card-text";
      text.textContent = result.text || "";
      body.replaceChildren(text);
    }
    position(anchor);
  }

  function escape(value) {
    return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function close() {
    token += 1;
    current = null;
    if (card) {
      card.hidden = true;
    }
  }

  function reset() {
    close();
    resolved.clear();
  }

  // Called when a page scrolls far away; its hits are rebuilt with the text layer.
  function release(page) {
    page.refLayer?.remove();
    page.refLayer = null;
    page.refsStarted = false;
  }

  document.addEventListener("pointerdown", event => {
    if (card && !card.hidden && !card.contains(event.target) && !event.target.closest?.(".ref-hit")) {
      close();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && card && !card.hidden) {
      close();
    }
  });

  return { attach, close, release, reset, isOpen: () => Boolean(card && !card.hidden) };
}
