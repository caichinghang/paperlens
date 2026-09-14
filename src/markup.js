import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { getItem, removeItem, setItem } from "./store.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// PDF.js only writes annotation-storage entries with this prefix into saved files.
const EDITOR_PREFIX = "pdfjs_internal_editor_";
const TEXT_TOOLS = new Set(["highlight", "underline", "strike"]);
const DRAW_TOOLS = new Set(["pen", "rect", "ellipse", "arrow", "line", "text", "signature"]);
const TOOL_KEYS = { v: "select", h: "highlight", u: "underline", s: "strike", p: "pen", r: "rect", o: "ellipse", a: "arrow", l: "line", t: "text" };
const WIDTH_TO_FONT_SIZE = { 1: 11, 2: 14, 4: 20 };
const TEXT_LINE_HEIGHT = 1.25;
const HISTORY_LIMIT = 100;
const LABELS = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "Strikethrough",
  ink: "Drawing",
  signature: "Signature",
  rect: "Rectangle",
  ellipse: "Oval",
  arrow: "Arrow",
  line: "Line",
  text: "Text",
  redact: "Redaction"
};
const FONT_STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const SWATCHES = ["#1f1f1f", "#e03131", "#4dabf7", "#51cf66", "#fcc419", "#f783ac"];
// Tools that feel like "the same pen" share one remembered color, like Preview.
const COLOR_GROUPS = {
  highlight: "highlight",
  underline: "textLine",
  strike: "textLine",
  pen: "ink",
  rect: "ink",
  ellipse: "ink",
  arrow: "ink",
  line: "ink",
  text: "text",
  signature: "signature"
};
const DEFAULT_COLORS = {
  highlight: "#fcc419",
  textLine: "#e03131",
  ink: "#e03131",
  text: "#1f1f1f",
  signature: "#1f1f1f"
};

const measureContext = document.createElement("canvas").getContext("2d");

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function highlightRgb(hex) {
  return hexToRgb(hex).map(channel => Math.round(channel + (255 - channel) * 0.35));
}

function rgbCss(rgb) {
  return `rgb(${rgb.join(" ")})`;
}

function colorKey(annotation) {
  if (annotation.kind === "signature") {
    return "signature";
  }
  return COLOR_GROUPS[annotation.type === "ink" ? "pen" : annotation.type];
}

function textFont(fontSize) {
  return `${fontSize}px Helvetica, Arial, sans-serif`;
}

// Greedy word wrap (falling back to character wrap for long words and CJK text) inside maxWidth page units.
function wrapText(text, fontSize, maxWidth) {
  measureContext.font = textFont(fontSize);
  const fits = value => measureContext.measureText(value).width <= maxWidth;
  const lines = [];

  for (const paragraph of (text || " ").split("\n")) {
    const tokens = paragraph.match(/\S+\s*|\s+/g) || [""];
    let line = "";

    for (const token of tokens) {
      if (fits((line + token).trimEnd())) {
        line += token;
        continue;
      }
      if (line) {
        lines.push(line.trimEnd());
        line = "";
      }
      if (fits(token.trimEnd())) {
        line = token;
        continue;
      }
      let chunk = "";
      for (const character of token) {
        if (chunk && !fits(chunk + character)) {
          lines.push(chunk);
          chunk = "";
        }
        chunk += character;
      }
      line = chunk;
    }
    lines.push(line.trimEnd());
  }

  return lines;
}

// Lines and box of a text annotation; a `width` wraps the text, a `height` reserves at least that much space.
function layoutText(annotation) {
  const fontSize = annotation.fontSize;
  const lines = annotation.width ? wrapText(annotation.text, fontSize, annotation.width) : (annotation.text || " ").split("\n");
  measureContext.font = textFont(fontSize);
  const width = annotation.width || Math.max(4, ...lines.map(line => measureContext.measureText(line).width));
  const height = Math.max(annotation.height || 0, lines.length * fontSize * TEXT_LINE_HEIGHT);
  return { lines, width, height };
}

function measureText(annotation) {
  const { width, height } = layoutText(annotation);
  return { width, height };
}

function getBounds(annotation) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  switch (annotation.type) {
    case "highlight":
    case "underline":
    case "strike":
      for (const [x, y, w, h] of annotation.rects) {
        include(x, y);
        include(x + w, y + h);
      }
      break;
    case "ink":
      for (const path of annotation.paths) {
        for (let i = 0; i < path.length; i += 2) {
          include(path[i], path[i + 1]);
        }
      }
      break;
    case "text": {
      const { width, height } = measureText(annotation);
      include(annotation.x, annotation.y);
      include(annotation.x + width, annotation.y + height);
      break;
    }
    default:
      include(annotation.x1, annotation.y1);
      include(annotation.x2, annotation.y2);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function smoothPath(points) {
  const count = points.length;
  if (count < 4) {
    return `M${points[0]} ${points[1]}l0.01 0`;
  }
  if (count === 4) {
    return `M${points[0]} ${points[1]}L${points[2]} ${points[3]}`;
  }

  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < count - 2; i += 2) {
    const midX = round((points[i] + points[i + 2]) / 2);
    const midY = round((points[i + 1] + points[i + 3]) / 2);
    d += `Q${points[i]} ${points[i + 1]} ${midX} ${midY}`;
  }
  return `${d}L${points[count - 2]} ${points[count - 1]}`;
}

function arrowHead({ x1, y1, x2, y2, width }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const length = Math.max(8, width * 4);
  const spread = Math.PI / 7;
  return [
    [round(x2 - length * Math.cos(angle - spread)), round(y2 - length * Math.sin(angle - spread))],
    [round(x2 - length * Math.cos(angle + spread)), round(y2 - length * Math.sin(angle + spread))]
  ];
}

function ellipsePoints({ x1, y1, x2, y2 }, segments = 72) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle));
  }
  return points;
}

function shapePath(annotation) {
  if (annotation.type === "ink") {
    return annotation.paths.map(smoothPath).join("");
  }

  const { x1, y1, x2, y2 } = annotation;
  switch (annotation.type) {
    case "rect":
    case "redact":
      return `M${x1} ${y1}H${x2}V${y2}H${x1}Z`;
    case "ellipse": {
      const rx = round(Math.abs(x2 - x1) / 2);
      const ry = round(Math.abs(y2 - y1) / 2);
      const left = Math.min(x1, x2);
      const cy = round((y1 + y2) / 2);
      return `M${left} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
    }
    case "arrow": {
      const [a, b] = arrowHead(annotation);
      return `M${x1} ${y1}L${x2} ${y2}M${a[0]} ${a[1]}L${x2} ${y2}L${b[0]} ${b[1]}`;
    }
    default:
      return `M${x1} ${y1}L${x2} ${y2}`;
  }
}

function constrainPoint(tool, start, point) {
  const dx = point.x - start.x;
  const dy = point.y - start.y;

  if (tool === "line" || tool === "arrow") {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) };
  }

  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
}

function mergeLineRects(rects) {
  const sorted = rects.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const merged = [];

  for (const rect of sorted) {
    const last = merged.at(-1);
    if (last) {
      const overlapY = Math.min(last[1] + last[3], rect[1] + rect[3]) - Math.max(last[1], rect[1]);
      const sameLine = overlapY > Math.min(last[3], rect[3]) * 0.5;
      const gap = rect[0] - (last[0] + last[2]);
      if (sameLine && gap < 2 && rect[0] + rect[2] > last[0] - 2) {
        const left = Math.min(last[0], rect[0]);
        const top = Math.min(last[1], rect[1]);
        const right = Math.max(last[0] + last[2], rect[0] + rect[2]);
        const bottom = Math.max(last[1] + last[3], rect[1] + rect[3]);
        last.splice(0, 4, left, top, right - left, bottom - top);
        continue;
      }
    }
    merged.push(rect.slice());
  }

  return merged;
}

function textDecorationLine(type, [x, y, w, h]) {
  const thickness = Math.max(0.75, h * 0.075);
  const lineY = type === "underline" ? y + h - thickness / 2 : y + h * 0.55;
  return { x1: x, y1: lineY, x2: x + w, y2: lineY, thickness };
}

function translateAnnotation(target, original, dx, dy) {
  switch (original.type) {
    case "ink":
      target.paths = original.paths.map(path => path.map((value, i) => round(value + (i % 2 === 0 ? dx : dy))));
      break;
    case "text":
      target.x = round(original.x + dx);
      target.y = round(original.y + dy);
      break;
    default:
      target.x1 = round(original.x1 + dx);
      target.y1 = round(original.y1 + dy);
      target.x2 = round(original.x2 + dx);
      target.y2 = round(original.y2 + dy);
  }
}

export function createMarkup({ pdfPages, bar, list, signatureDialog, getPages, goToPage, toast, onChange, onVisibilityChange }) {
  const undoButton = bar.querySelector("#undoBtn");
  const redoButton = bar.querySelector("#redoBtn");
  const deleteButton = bar.querySelector("#deleteBtn");
  const signaturePad = signatureDialog.querySelector("#signaturePad");
  const padContext = signaturePad.getContext("2d");
  const layers = new Map();

  let docKey = "";
  let annotations = [];
  let undoStack = [];
  let redoStack = [];
  let open = false;
  let tool = "select";
  let selectedId = null;
  let colors = { ...DEFAULT_COLORS };
  let strokeWidth = 2;
  let signature = null;
  let saveTimer = 0;
  let pendingSave = null;
  let editing = null;
  let dragging = null;
  let padStrokes = [];
  let hiddenLayers = new Set();
  let mini = null;

  getItem("markupPrefs").then(prefs => {
    if (prefs) {
      colors = { ...DEFAULT_COLORS, ...prefs.colors };
      strokeWidth = prefs.width || strokeWidth;
      syncBar();
    }
  });
  getItem("signature").then(saved => {
    signature = saved;
  });

  // ---------- State & persistence ----------

  function snapshot() {
    return JSON.stringify(annotations);
  }

  function findAnnotation(id) {
    return id ? annotations.find(annotation => annotation.id === id) || null : null;
  }

  function pushHistory(before) {
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack.shift();
    }
    redoStack = [];
  }

  function commit(mutate) {
    const before = snapshot();
    mutate();
    if (before !== snapshot()) {
      pushHistory(before);
      changed();
    }
  }

  function changed() {
    if (selectedId && !findAnnotation(selectedId)) {
      selectedId = null;
    }
    renderAll();
    renderList();
    syncBar();
    scheduleSave();
    onChange?.();
  }

  function isVisible(annotation) {
    return !annotation.layer || !hiddenLayers.has(annotation.layer);
  }

  function restore(serialized) {
    finishEditing();
    annotations = JSON.parse(serialized);
    changed();
  }

  function undo() {
    if (!undoStack.length) {
      return false;
    }
    redoStack.push(snapshot());
    restore(undoStack.pop());
    return true;
  }

  function redo() {
    if (!redoStack.length) {
      return false;
    }
    undoStack.push(snapshot());
    restore(redoStack.pop());
    return true;
  }

  function storageKey(key) {
    return `markup:${key}`;
  }

  function scheduleSave() {
    if (!docKey) {
      return;
    }
    clearTimeout(saveTimer);
    pendingSave = { key: docKey, data: annotations.slice() };
    saveTimer = window.setTimeout(flushSave, 400);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!pendingSave) {
      return;
    }
    const { key, data } = pendingSave;
    pendingSave = null;
    if (data.length) {
      setItem(storageKey(key), data);
    } else {
      removeItem(storageKey(key));
    }
  }

  function savePrefs() {
    setItem("markupPrefs", { colors, width: strokeWidth });
  }

  async function setDocument(key) {
    flushSave();
    editing = null;
    dragging = null;
    docKey = key;
    layers.clear();
    selectedId = null;
    hiddenLayers = new Set();
    mini?.remove();
    mini = null;
    undoStack = [];
    redoStack = [];

    const stored = key ? await getItem(storageKey(key), []) : [];
    if (docKey !== key) {
      return;
    }

    annotations = Array.isArray(stored) ? stored : [];
    renderList();
    syncBar();
  }

  // ---------- Rendering ----------

  function attachPage(page) {
    const layer = document.createElement("div");
    layer.className = "markup-layer";
    const svg = svgElement("svg", { preserveAspectRatio: "none" });
    layer.append(svg);

    // Text boxes live in a second, unblended layer so their backgrounds can cover the page (translations).
    const texts = document.createElement("div");
    texts.className = "markup-layer markup-texts";

    const surface = document.createElement("div");
    surface.className = "draw-surface";
    page.shell.append(layer, texts, surface);

    const entry = { page, layer, svg, surface, texts };
    layers.set(page.number, entry);
    surface.addEventListener("pointerdown", event => startDrawing(event, entry));
    updatePageSize(page);
  }

  function updatePageSize(page) {
    const entry = layers.get(page.number);
    if (entry) {
      entry.page = page;
      entry.svg.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
      renderPage(page.number);
    }
  }

  function renderAll() {
    for (const number of layers.keys()) {
      renderPage(number);
    }
  }

  function renderPage(number) {
    const entry = layers.get(number);
    if (!entry) {
      return;
    }

    entry.svg.replaceChildren();
    for (const element of entry.texts.querySelectorAll(".markup-text")) {
      if (element !== editing?.element) {
        element.remove();
      }
    }

    for (const annotation of annotations) {
      if (annotation.page === number && isVisible(annotation)) {
        drawAnnotation(entry, annotation);
      }
    }

    const selected = findAnnotation(selectedId);
    if (selected?.page === number && selected.type === "text") {
      showMiniToolbar(entry, selected);
    } else if (mini && mini.parentElement === entry.page.shell) {
      hideMiniToolbar();
    }
    if (selected?.page === number && selected.type !== "text") {
      const bounds = getBounds(selected);
      const pad = 3 + (selected.width || 0) / 2;
      entry.svg.append(svgElement("rect", {
        class: "sel-box",
        x: bounds.x - pad,
        y: bounds.y - pad,
        width: bounds.width + pad * 2,
        height: bounds.height + pad * 2,
        rx: 2
      }));
    }
  }

  function drawAnnotation({ svg, texts, page }, annotation) {
    if (annotation.type === "text") {
      if (editing?.id === annotation.id) {
        return;
      }
      const element = document.createElement("div");
      element.className = "markup-text movable";
      element.classList.toggle("is-selected", annotation.id === selectedId);
      element.classList.toggle("is-boxed", Boolean(annotation.width));
      element.dataset.id = annotation.id;
      element.style.left = `${(annotation.x / page.width) * 100}%`;
      element.style.top = `${(annotation.y / page.height) * 100}%`;
      if (annotation.width) {
        element.style.width = `${(annotation.width / page.width) * 100}%`;
      }
      if (annotation.height) {
        element.style.minHeight = `${(annotation.height / page.height) * 100}%`;
      }
      element.style.setProperty("--fs", annotation.fontSize);
      element.style.setProperty("--c", annotation.color);
      element.style.setProperty("--bg", annotation.background || "transparent");
      element.textContent = annotation.text;
      texts.append(element);
      return;
    }

    const group = svgElement("g", { "data-id": annotation.id });

    if (annotation.type === "redact") {
      const { x1, y1, x2, y2 } = annotation;
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      group.classList.add("movable", annotation.status === "approved" ? "redact-approved" : "redact-pending");
      group.append(svgElement("rect", { ...box, class: "redact-box" }), svgElement("rect", { ...box, class: "hit-fill" }));
      if (annotation.status !== "approved" && annotation.reason) {
        const title = svgElement("title");
        title.textContent = annotation.reason;
        group.append(title);
      }
      svg.append(group);
      return;
    }

    if (TEXT_TOOLS.has(annotation.type)) {
      group.classList.add("ann-text-markup");
      for (const rect of annotation.rects) {
        const [x, y, width, height] = rect;
        if (annotation.type === "highlight") {
          group.append(svgElement("rect", { x, y, width, height, rx: 1, fill: rgbCss(highlightRgb(annotation.color)) }));
        } else {
          const line = textDecorationLine(annotation.type, rect);
          group.append(
            svgElement("line", { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, stroke: annotation.color, "stroke-width": line.thickness }),
            svgElement("rect", { x, y, width, height, class: "hit-fill" })
          );
        }
      }
    } else {
      group.classList.add("movable");
      const d = shapePath(annotation);
      group.append(
        svgElement("path", {
          d,
          fill: "none",
          stroke: annotation.color,
          "stroke-width": annotation.width,
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        }),
        svgElement("path", { d, class: "hit", "stroke-width": annotation.width + 8 })
      );
    }

    svg.append(group);
  }

  function renderList() {
    if (!annotations.length) {
      list.innerHTML = '<div class="sidebar-empty">No markup yet. Select some text, or open the markup toolbar to draw.</div>';
      return;
    }

    const layerRows = getLayers().map(entry => {
      const row = document.createElement("label");
      row.className = "layer-row";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = entry.visible;
      toggle.addEventListener("change", () => setLayerVisible(entry.name, toggle.checked));
      const name = document.createElement("span");
      name.textContent = `${entry.label} layer`;
      const count = document.createElement("em");
      count.textContent = `${entry.count}`;
      row.append(toggle, name, count);
      return row;
    });

    const sorted = annotations.slice().sort((a, b) => a.page - b.page || getBounds(a).y - getBounds(b).y);
    list.replaceChildren(...layerRows, ...sorted.map(annotation => {
      const item = document.createElement("div");
      item.className = "annotation-item";
      item.tabIndex = 0;
      item.setAttribute("role", "button");

      const swatch = document.createElement("span");
      swatch.className = "ann-swatch";
      swatch.style.setProperty("--c", annotation.type === "highlight" ? rgbCss(highlightRgb(annotation.color)) : annotation.color);

      const meta = document.createElement("span");
      meta.className = "ann-meta";
      const label = document.createElement("strong");
      label.textContent = annotation.type === "redact" && annotation.status !== "approved"
        ? "Proposed redaction"
        : annotation.layer ? `${layerLabel(annotation.layer)}` : LABELS[annotation.kind || annotation.type] || "Markup";
      const pageLabel = document.createElement("em");
      pageLabel.textContent = `p. ${annotation.page}`;
      meta.append(label, pageLabel);
      item.append(swatch, meta);

      if (annotation.text) {
        const snippet = document.createElement("span");
        snippet.className = "ann-snippet";
        snippet.textContent = annotation.text;
        item.append(snippet);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ann-delete";
      remove.title = "Delete";
      remove.setAttribute("aria-label", "Delete markup");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      remove.addEventListener("click", event => {
        event.stopPropagation();
        commit(() => {
          annotations = annotations.filter(entry => entry.id !== annotation.id);
        });
      });
      item.append(remove);

      const reveal = () => revealAnnotation(annotation.id);
      item.addEventListener("click", reveal);
      item.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          reveal();
        }
      });
      return item;
    }));
  }

  function findElement(annotation) {
    const entry = layers.get(annotation.page);
    return entry?.texts.querySelector(`[data-id="${annotation.id}"]`) || entry?.layer.querySelector(`[data-id="${annotation.id}"]`) || null;
  }

  function flashElement(element) {
    if (!element) {
      return;
    }
    element.classList.remove("flash");
    void element.getBoundingClientRect();
    element.classList.add("flash");
  }

  function revealAnnotation(id) {
    const annotation = findAnnotation(id);
    if (!annotation) {
      return false;
    }
    goToPage(annotation.page, Math.max(0, getBounds(annotation).y - 36));
    window.setTimeout(() => flashElement(findElement(annotation)), 400);
    return true;
  }

  // ---------- Layers (e.g. translations) ----------

  function layerLabel(name) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function getLayers() {
    const counts = new Map();
    for (const annotation of annotations) {
      if (annotation.layer) {
        counts.set(annotation.layer, (counts.get(annotation.layer) || 0) + 1);
      }
    }
    return [...counts].map(([name, count]) => ({ name, label: layerLabel(name), count, visible: !hiddenLayers.has(name) }));
  }

  function setLayerVisible(name, visible) {
    if (visible) {
      hiddenLayers.delete(name);
    } else {
      hiddenLayers.add(name);
      const selected = findAnnotation(selectedId);
      if (selected?.layer === name) {
        select(null);
      }
    }
    finishEditing();
    renderAll();
    renderList();
    onChange?.();
  }

  // ---------- Mini toolbar for text boxes ----------

  function buildMiniToolbar() {
    const bar = document.createElement("div");
    bar.className = "markup-mini glass";
    bar.setAttribute("role", "toolbar");
    bar.innerHTML = `
      <button type="button" data-mini="edit" title="Edit text (Enter)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.9-2.9a2 2 0 0 1 .5-.9z"></path></svg></button>
      <button type="button" data-mini="smaller" title="Smaller text">A−</button>
      <button type="button" data-mini="larger" title="Larger text">A+</button>
      <span class="mini-divider"></span>
      ${SWATCHES.map(color => `<button type="button" class="mini-swatch" data-mini="color" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`).join("")}
      <span class="mini-divider"></span>
      <button type="button" data-mini="delete" title="Delete (⌫)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
    bar.addEventListener("pointerdown", event => event.preventDefault());
    bar.addEventListener("click", event => {
      const button = event.target.closest("button");
      const selected = findAnnotation(selectedId);
      if (!button || !selected) {
        return;
      }
      const action = button.dataset.mini;
      if (action === "edit") {
        startEditing(selected.id);
      } else if (action === "smaller" || action === "larger") {
        const index = FONT_STEPS.findIndex(size => size >= selected.fontSize);
        const next = FONT_STEPS[clamp((index === -1 ? FONT_STEPS.length - 1 : index) + (action === "larger" ? 1 : -1), 0, FONT_STEPS.length - 1)];
        if (next !== selected.fontSize) {
          commit(() => {
            selected.fontSize = next;
          });
        }
      } else if (action === "color") {
        setColor(button.dataset.color);
      } else if (action === "delete") {
        deleteSelected();
      }
    });
    return bar;
  }

  function showMiniToolbar(entry, annotation) {
    mini ||= buildMiniToolbar();
    if (mini.parentElement !== entry.page.shell) {
      entry.page.shell.append(mini);
    }
    const { width } = measureText(annotation);
    mini.style.left = `${clamp((annotation.x / entry.page.width) * 100, 0, 100)}%`;
    mini.style.top = `${(annotation.y / entry.page.height) * 100}%`;
    mini.classList.toggle("is-below", annotation.y < 40);
    mini.style.setProperty("--anchor-w", `${(width / entry.page.width) * 100}%`);
    for (const swatch of mini.querySelectorAll(".mini-swatch")) {
      swatch.classList.toggle("is-active", swatch.dataset.color === annotation.color.toLowerCase());
    }
    mini.hidden = Boolean(editing) || !isVisible(annotation);
  }

  function hideMiniToolbar() {
    if (mini) {
      mini.hidden = true;
    }
  }

  // ---------- Toolbar ----------

  function syncModeClasses() {
    pdfPages.dataset.tool = tool;
    pdfPages.classList.toggle("tool-draw", open && DRAW_TOOLS.has(tool));
    pdfPages.classList.toggle("markup-select", open && tool === "select");
  }

  function syncBar() {
    const selected = findAnnotation(selectedId);
    const activeColor = (selected?.color ?? colors[COLOR_GROUPS[tool] || "highlight"]).toLowerCase();

    for (const button of bar.querySelectorAll("[data-tool]")) {
      button.classList.toggle("is-active", button.dataset.tool === tool);
      if (TEXT_TOOLS.has(button.dataset.tool)) {
        button.style.setProperty("--tool-color", colors[COLOR_GROUPS[button.dataset.tool]]);
      }
    }
    for (const button of bar.querySelectorAll("[data-color]")) {
      button.classList.toggle("is-active", button.dataset.color.toLowerCase() === activeColor);
    }

    let activeWidth = strokeWidth;
    if (selected?.width) {
      activeWidth = selected.width;
    } else if (selected?.type === "text") {
      activeWidth = Number(Object.keys(WIDTH_TO_FONT_SIZE).find(key => WIDTH_TO_FONT_SIZE[key] === selected.fontSize) || 2);
    }
    for (const button of bar.querySelectorAll("[data-width]")) {
      button.classList.toggle("is-active", Number(button.dataset.width) === activeWidth);
    }

    undoButton.disabled = !undoStack.length;
    redoButton.disabled = !redoStack.length;
    deleteButton.disabled = !selected;
    document.documentElement.style.setProperty("--highlight-color", colors.highlight);
  }

  let closeTimer = 0;

  // The bar fades and lifts out before it is hidden, mirroring how it comes in.
  function setOpen(visible) {
    open = visible;
    clearTimeout(closeTimer);
    if (visible) {
      bar.classList.remove("is-closing");
      bar.hidden = false;
    } else {
      finishEditing();
      tool = "select";
      select(null);
      if (!bar.hidden) {
        bar.classList.add("is-closing");
        closeTimer = window.setTimeout(() => {
          bar.hidden = true;
          bar.classList.remove("is-closing");
        }, 170);
      }
    }
    syncModeClasses();
    syncBar();
    onVisibilityChange?.(visible);
  }

  function setTool(next) {
    finishEditing();
    tool = next;
    if (tool !== "select") {
      select(null);
    }
    syncModeClasses();
    syncBar();
  }

  function select(id) {
    if (selectedId === id) {
      return;
    }
    const previous = findAnnotation(selectedId);
    selectedId = id;
    if (previous) {
      renderPage(previous.page);
    }
    const next = findAnnotation(id);
    if (next && next.page !== previous?.page) {
      renderPage(next.page);
    }
    syncBar();
  }

  function deleteSelected() {
    const selected = findAnnotation(selectedId);
    if (selected) {
      commit(() => {
        annotations = annotations.filter(annotation => annotation.id !== selected.id);
      });
    }
  }

  function setColor(color) {
    const selected = findAnnotation(selectedId);
    if (selected) {
      commit(() => {
        selected.color = color;
      });
      colors[colorKey(selected)] = color;
    } else {
      colors[COLOR_GROUPS[tool] || "highlight"] = color;
    }
    savePrefs();
    syncBar();
  }

  function setWidth(width) {
    const selected = findAnnotation(selectedId);
    if (selected?.width) {
      commit(() => {
        selected.width = width;
      });
    } else if (selected?.type === "text") {
      commit(() => {
        selected.fontSize = WIDTH_TO_FONT_SIZE[width];
      });
    }
    strokeWidth = width;
    savePrefs();
    syncBar();
  }

  function currentPdfRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    return pdfPages.contains(range.commonAncestorContainer) ? range : null;
  }

  bar.addEventListener("pointerdown", event => {
    if (event.target.closest("button")) {
      event.preventDefault();
    }
  });

  bar.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) {
      return;
    }

    const nextTool = button.dataset.tool;
    if (nextTool) {
      if (nextTool === "signature" && (tool === "signature" || !signature)) {
        openSignaturePad();
        return;
      }
      if (TEXT_TOOLS.has(nextTool)) {
        const range = currentPdfRange();
        if (range) {
          addTextMarkup(nextTool, range);
          return;
        }
      }
      setTool(nextTool);
      if (nextTool === "signature") {
        toast("Click on the page to place your signature");
      }
      return;
    }

    if (button.dataset.color) {
      setColor(button.dataset.color);
    } else if (button.dataset.width) {
      setWidth(Number(button.dataset.width));
    } else if (button === undoButton) {
      undo();
    } else if (button === redoButton) {
      redo();
    } else if (button === deleteButton) {
      deleteSelected();
    }
  });

  // ---------- Drawing ----------

  function pagePoint(entry, event) {
    const rect = entry.layer.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * entry.page.width, 0, entry.page.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * entry.page.height, 0, entry.page.height)
    };
  }

  function startDrawing(event, entry) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();

    const start = pagePoint(entry, event);
    if (tool === "text") {
      createText(entry, start);
      return;
    }
    if (tool === "signature") {
      placeSignature(entry, start);
      return;
    }

    const activeTool = tool;
    const color = colors[COLOR_GROUPS[activeTool]];
    const width = strokeWidth;
    const points = [round(start.x), round(start.y)];
    let shape = null;
    const preview = svgElement("path", {
      fill: "none",
      stroke: color,
      "stroke-width": width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      d: smoothPath(points)
    });
    entry.svg.append(preview);
    entry.surface.setPointerCapture(event.pointerId);

    const move = moveEvent => {
      if (activeTool === "pen") {
        for (const sample of moveEvent.getCoalescedEvents?.() || [moveEvent]) {
          const point = pagePoint(entry, sample);
          if (Math.hypot(point.x - points.at(-2), point.y - points.at(-1)) >= 0.6) {
            points.push(round(point.x), round(point.y));
          }
        }
        preview.setAttribute("d", smoothPath(points));
      } else {
        let point = pagePoint(entry, moveEvent);
        if (moveEvent.shiftKey) {
          point = constrainPoint(activeTool, start, point);
        }
        shape = { type: activeTool, x1: round(start.x), y1: round(start.y), x2: round(point.x), y2: round(point.y), width };
        preview.setAttribute("d", shapePath(shape));
      }
    };

    const end = () => {
      entry.surface.removeEventListener("pointermove", move);
      entry.surface.removeEventListener("pointerup", end);
      entry.surface.removeEventListener("pointercancel", end);
      preview.remove();

      let annotation = null;
      if (activeTool === "pen") {
        annotation = { type: "ink", width, paths: [points] };
      } else if (shape && Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) >= 3) {
        annotation = shape;
      }

      if (annotation) {
        commit(() => {
          annotations.push({ ...annotation, id: uid(), page: entry.page.number, color });
        });
      }
    };

    entry.surface.addEventListener("pointermove", move);
    entry.surface.addEventListener("pointerup", end);
    entry.surface.addEventListener("pointercancel", end);
  }

  function createText(entry, point) {
    const before = snapshot();
    const fontSize = WIDTH_TO_FONT_SIZE[strokeWidth] || 14;
    const annotation = {
      id: uid(),
      type: "text",
      page: entry.page.number,
      color: colors.text,
      fontSize,
      x: round(point.x),
      y: round(Math.max(0, point.y - fontSize * 0.65)),
      text: ""
    };
    annotations.push(annotation);
    setTool("select");
    startEditing(annotation.id, before);
  }

  function startEditing(id, before = snapshot()) {
    finishEditing();
    const annotation = findAnnotation(id);
    const entry = annotation && layers.get(annotation.page);
    if (!entry) {
      return;
    }

    renderPage(annotation.page);
    const element = entry.texts.querySelector(`.markup-text[data-id="${id}"]`);
    if (!element) {
      return;
    }

    editing = { id, element, before };
    hideMiniToolbar();
    element.classList.add("is-editing");
    element.contentEditable = "plaintext-only";
    element.focus();

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    element.addEventListener("blur", finishEditing, { once: true });
    element.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        element.blur();
      }
    });
  }

  function finishEditing() {
    if (!editing) {
      return;
    }

    const { id, element, before } = editing;
    editing = null;
    element.contentEditable = "false";
    element.classList.remove("is-editing");

    const annotation = findAnnotation(id);
    if (annotation) {
      const text = element.innerText.replace(/\n+$/, "");
      if (text.trim()) {
        annotation.text = text;
      } else {
        annotations = annotations.filter(entry => entry.id !== id);
      }
    }

    if (before !== snapshot()) {
      pushHistory(before);
    }
    element.remove();
    changed();
  }

  // Text boxes (including ones the assistant added) can be selected, moved and edited at any time;
  // other markup is only interactive with the toolbar's Select tool, so it never blocks text selection.
  pdfPages.addEventListener("pointerdown", event => {
    if (event.button !== 0) {
      return;
    }

    const selectMode = open && tool === "select";
    const target = event.target.closest?.(".markup-layer [data-id]");
    if (!target || (!selectMode && !target.classList.contains("markup-text"))) {
      if (!event.target.closest?.(".markup-text.is-editing, .markup-mini")) {
        select(null);
      }
      return;
    }
    if (target.classList.contains("is-editing")) {
      return;
    }

    event.preventDefault();
    finishEditing();
    const annotation = findAnnotation(target.dataset.id);
    if (!annotation) {
      return;
    }

    select(annotation.id);
    if (TEXT_TOOLS.has(annotation.type)) {
      return;
    }

    const entry = layers.get(annotation.page);
    const rect = entry.layer.getBoundingClientRect();
    dragging = {
      annotation,
      original: JSON.parse(JSON.stringify(annotation)),
      before: snapshot(),
      startX: event.clientX,
      startY: event.clientY,
      scaleX: entry.page.width / rect.width,
      scaleY: entry.page.height / rect.height,
      moved: false
    };
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd, { once: true });
  });

  function dragMove(event) {
    if (!dragging) {
      return;
    }
    const clientDx = event.clientX - dragging.startX;
    const clientDy = event.clientY - dragging.startY;
    if (!dragging.moved && Math.hypot(clientDx, clientDy) < 3) {
      return;
    }
    dragging.moved = true;
    translateAnnotation(dragging.annotation, dragging.original, clientDx * dragging.scaleX, clientDy * dragging.scaleY);
    renderPage(dragging.annotation.page);
  }

  function dragEnd() {
    window.removeEventListener("pointermove", dragMove);
    if (dragging?.moved) {
      pushHistory(dragging.before);
      changed();
    }
    dragging = null;
  }

  pdfPages.addEventListener("dblclick", event => {
    if (open && tool !== "select") {
      return;
    }
    const element = event.target.closest?.(".markup-text");
    if (element && !element.classList.contains("is-editing")) {
      event.preventDefault();
      startEditing(element.dataset.id);
    }
  });

  // ---------- Text markup ----------

  function addTextMarkup(type, range) {
    const clientRects = [...range.getClientRects()].filter(rect => rect.width > 0.5 && rect.height > 0.5);
    if (!clientRects.length) {
      return false;
    }

    const bounds = range.getBoundingClientRect();
    const candidates = [...layers.values()]
      .map(entry => ({ entry, rect: entry.layer.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= bounds.top && rect.top <= bounds.bottom);
    const rectsByPage = new Map();

    for (const clientRect of clientRects) {
      const cx = clientRect.left + clientRect.width / 2;
      const cy = clientRect.top + clientRect.height / 2;
      const hit = candidates.find(({ rect }) => cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom);
      if (!hit) {
        continue;
      }

      const { entry, rect } = hit;
      const scaleX = entry.page.width / rect.width;
      const scaleY = entry.page.height / rect.height;
      const pageRects = rectsByPage.get(entry.page.number) || [];
      pageRects.push([
        (clientRect.left - rect.left) * scaleX,
        (clientRect.top - rect.top) * scaleY,
        clientRect.width * scaleX,
        clientRect.height * scaleY
      ]);
      rectsByPage.set(entry.page.number, pageRects);
    }

    if (!rectsByPage.size) {
      return false;
    }

    const text = range.toString().replace(/\s+/g, " ").trim().slice(0, 280);
    commit(() => {
      for (const [page, rects] of rectsByPage) {
        annotations.push({
          id: uid(),
          type,
          page,
          color: colors[COLOR_GROUPS[type]],
          rects: mergeLineRects(rects).map(rect => rect.map(round)),
          text
        });
      }
    });
    window.getSelection()?.removeAllRanges();
    return true;
  }

  // ---------- Signature ----------

  function redrawPad() {
    padContext.clearRect(0, 0, signaturePad.width, signaturePad.height);
    padContext.lineWidth = 3;
    padContext.lineCap = "round";
    padContext.lineJoin = "round";
    padContext.strokeStyle = "#1f1f1f";

    for (const stroke of padStrokes) {
      padContext.beginPath();
      padContext.moveTo(stroke[0], stroke[1]);
      for (let i = 2; i < stroke.length - 2; i += 2) {
        padContext.quadraticCurveTo(stroke[i], stroke[i + 1], (stroke[i] + stroke[i + 2]) / 2, (stroke[i + 1] + stroke[i + 3]) / 2);
      }
      padContext.lineTo(stroke.at(-2), stroke.at(-1) + (stroke.length === 2 ? 0.1 : 0));
      padContext.stroke();
    }
  }

  function padPoint(event) {
    const rect = signaturePad.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * signaturePad.width,
      ((event.clientY - rect.top) / rect.height) * signaturePad.height
    ];
  }

  function openSignaturePad() {
    padStrokes = [];
    redrawPad();
    signatureDialog.showModal();
  }

  signaturePad.addEventListener("pointerdown", event => {
    signaturePad.setPointerCapture(event.pointerId);
    padStrokes.push(padPoint(event));
    redrawPad();
  });
  signaturePad.addEventListener("pointermove", event => {
    if (!signaturePad.hasPointerCapture(event.pointerId)) {
      return;
    }
    const stroke = padStrokes.at(-1);
    for (const sample of event.getCoalescedEvents?.() || [event]) {
      const [x, y] = padPoint(sample);
      if (Math.hypot(x - stroke.at(-2), y - stroke.at(-1)) > 1) {
        stroke.push(x, y);
      }
    }
    redrawPad();
  });

  signatureDialog.querySelector("#signatureClear").addEventListener("click", () => {
    padStrokes = [];
    redrawPad();
  });

  signatureDialog.querySelector("#signatureSave").addEventListener("click", () => {
    if (!padStrokes.length) {
      toast("Draw your signature first");
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of padStrokes) {
      for (let i = 0; i < stroke.length; i += 2) {
        minX = Math.min(minX, stroke[i]);
        maxX = Math.max(maxX, stroke[i]);
        minY = Math.min(minY, stroke[i + 1]);
        maxY = Math.max(maxY, stroke[i + 1]);
      }
    }

    const width = Math.max(1, maxX - minX);
    signature = {
      aspect: Math.max(1, maxY - minY) / width,
      paths: padStrokes.map(stroke => stroke.map((value, i) => Math.round(((value - (i % 2 === 0 ? minX : minY)) / width) * 1000) / 1000))
    };
    setItem("signature", signature);
    signatureDialog.close();
    setTool("signature");
    toast("Click on the page to place your signature");
  });

  function placeSignature(entry, point) {
    if (!signature) {
      openSignaturePad();
      return;
    }

    const width = Math.min(160, entry.page.width * 0.35);
    const left = point.x - width / 2;
    const top = point.y - (width * signature.aspect) / 2;
    const annotation = {
      id: uid(),
      type: "ink",
      kind: "signature",
      page: entry.page.number,
      color: colors.signature,
      width: 1.4,
      paths: signature.paths.map(path => path.map((value, i) => round((i % 2 === 0 ? left : top) + value * width)))
    };

    commit(() => {
      annotations.push(annotation);
    });
    setTool("select");
    select(annotation.id);
  }

  // ---------- Keyboard ----------

  function handleKeydown(event) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === "z") {
      const handled = event.shiftKey ? redo() : undo();
      if (handled) {
        event.preventDefault();
      }
      return handled;
    }
    if (mod && key === "y" && redo()) {
      event.preventDefault();
      return true;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      deleteSelected();
      return true;
    }
    if (event.key === "Enter" && !mod && findAnnotation(selectedId)?.type === "text") {
      event.preventDefault();
      startEditing(selectedId);
      return true;
    }
    if (event.key === "Escape") {
      if (selectedId) {
        select(null);
        return true;
      }
      if (open && tool !== "select") {
        setTool("select");
        return true;
      }
      return false;
    }
    if (open && !mod && !event.altKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
      return true;
    }
    return false;
  }

  // ---------- Export ----------

  function serialize(annotation, page) {
    const { AnnotationEditorType } = pdfjsLib;
    const pageIndex = page.number - 1;
    const toPdf = (x, y) => page.viewport.convertToPdfPoint(x, y);

    const ink = (paths, color, thickness) => {
      const lines = [];
      const points = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const path of paths) {
        const line = [];
        const flat = [];
        for (let i = 0; i < path.length; i += 2) {
          const [x, y] = toPdf(path[i], path[i + 1]);
          line.push(NaN, NaN, NaN, NaN, x, y);
          flat.push(x, y);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        lines.push(line);
        points.push(flat);
      }

      const pad = thickness / 2 + 1;
      return {
        annotationType: AnnotationEditorType.INK,
        pageIndex,
        rotation: 0,
        color: hexToRgb(color),
        opacity: 1,
        thickness,
        paths: { lines, points },
        rect: [minX - pad, minY - pad, maxX + pad, maxY + pad]
      };
    };

    const { x1, y1, x2, y2 } = annotation;
    switch (annotation.type) {
      case "ink":
        return [ink(annotation.paths, annotation.color, annotation.width)];
      case "rect":
        return [ink([[x1, y1, x2, y1, x2, y2, x1, y2, x1, y1]], annotation.color, annotation.width)];
      case "ellipse":
        return [ink([ellipsePoints(annotation)], annotation.color, annotation.width)];
      case "line":
        return [ink([[x1, y1, x2, y2]], annotation.color, annotation.width)];
      case "arrow": {
        const [a, b] = arrowHead(annotation);
        return [ink([[x1, y1, x2, y2], [a[0], a[1], x2, y2, b[0], b[1]]], annotation.color, annotation.width)];
      }
      case "underline":
      case "strike": {
        const lines = annotation.rects.map(rect => textDecorationLine(annotation.type, rect));
        return [ink(lines.map(line => [line.x1, line.y1, line.x2, line.y2]), annotation.color, lines[0].thickness)];
      }
      case "highlight": {
        const quadPoints = [];
        const outlines = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const [x, y, width, height] of annotation.rects) {
          const [ax, ay] = toPdf(x, y);
          const [bx, by] = toPdf(x + width, y + height);
          const left = Math.min(ax, bx);
          const right = Math.max(ax, bx);
          const bottom = Math.min(ay, by);
          const top = Math.max(ay, by);
          quadPoints.push(left, top, right, top, left, bottom, right, bottom);
          outlines.push([left, bottom, left, top, right, top, right, bottom]);
          minX = Math.min(minX, left);
          minY = Math.min(minY, bottom);
          maxX = Math.max(maxX, right);
          maxY = Math.max(maxY, top);
        }

        return [{
          annotationType: AnnotationEditorType.HIGHLIGHT,
          pageIndex,
          rotation: 0,
          color: highlightRgb(annotation.color),
          opacity: 1,
          quadPoints,
          outlines,
          rect: [minX, minY, maxX, maxY]
        }];
      }
      case "text": {
        const { lines, width, height } = layoutText(annotation);
        const [ax, ay] = toPdf(annotation.x, annotation.y);
        const [bx, by] = toPdf(annotation.x + width, annotation.y + height);
        return [{
          annotationType: AnnotationEditorType.FREETEXT,
          pageIndex,
          rotation: 0,
          color: hexToRgb(annotation.color),
          fontSize: annotation.fontSize,
          value: annotation.width ? lines.join("\n") : annotation.text,
          rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
        }];
      }
      default:
        // Redactions are applied by flattening the page (see the viewer's download), never as annotations.
        return [];
    }
  }

  async function exportPdf(pdfDocument) {
    finishEditing();
    const storage = pdfDocument.annotationStorage;
    const pages = getPages();
    const keys = [];

    try {
      annotations.forEach((annotation, index) => {
        const page = pages[annotation.page - 1];
        if (!page || !isVisible(annotation)) {
          return;
        }
        serialize(annotation, page).forEach((value, part) => {
          const key = `${EDITOR_PREFIX}viewer_${index}_${part}`;
          storage.setValue(key, value);
          keys.push(key);
        });
      });
      return await pdfDocument.saveDocument();
    } finally {
      for (const key of keys) {
        storage.remove(key);
      }
    }
  }

  // ---------- Programmatic API (used by the AI assistant) ----------

  function defaultColor(type) {
    return colors[COLOR_GROUPS[type] || "ink"];
  }

  function addAnnotations(items) {
    const created = items.map(item => {
      const annotation = { ...item, id: uid() };
      if (annotation.rects) {
        annotation.rects = mergeLineRects(annotation.rects).map(rect => rect.map(round));
      }
      if (annotation.layer) {
        annotation.layer = String(annotation.layer).trim().toLowerCase().slice(0, 24) || undefined;
      }
      return annotation;
    });
    commit(() => {
      annotations.push(...created);
    });
    return created.map(annotation => annotation.id);
  }

  function updateAnnotations(ids, patch) {
    const wanted = new Set(ids);
    let touched = 0;
    commit(() => {
      for (const annotation of annotations) {
        if (wanted.has(annotation.id)) {
          Object.assign(annotation, patch);
          touched += 1;
        }
      }
    });
    return touched;
  }

  // Largest font size (down to 5pt) at which `text` wraps inside a width × height box in page units.
  function fitFontSize({ text, width, height, fontSize }) {
    let size = clamp(Math.round((fontSize || height / TEXT_LINE_HEIGHT) * 2) / 2, 5, 48);
    while (size > 5 && wrapText(text, size, width).length * size * TEXT_LINE_HEIGHT > height + 0.5) {
      size -= 0.5;
    }
    return size;
  }

  function countRedactions(status = "approved") {
    return annotations.filter(annotation => annotation.type === "redact" && annotation.status === status).length;
  }

  function removeAnnotations(ids) {
    const doomed = new Set(ids);
    const before = annotations.length;
    commit(() => {
      annotations = annotations.filter(annotation => !doomed.has(annotation.id));
    });
    return before - annotations.length;
  }

  function listAnnotations(pageNumber = 0) {
    return annotations
      .filter(annotation => !pageNumber || annotation.page === pageNumber)
      .map(annotation => ({
        id: annotation.id,
        type: annotation.kind || annotation.type,
        page: annotation.page,
        color: annotation.color,
        text: annotation.text || "",
        layer: annotation.layer,
        status: annotation.status,
        bounds: getBounds(annotation)
      }));
  }

  // Paints markup onto an offscreen page render (page units × scale) so the assistant can see its own edits.
  function drawOnCanvas(context, pageNumber, scale, { forExport = false } = {}) {
    context.save();
    context.scale(scale, scale);
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const annotation of annotations) {
      if (annotation.page !== pageNumber || !isVisible(annotation)) {
        continue;
      }
      if (forExport && annotation.type === "redact" && annotation.status !== "approved") {
        continue;
      }

      if (annotation.type === "redact") {
        const { x1, y1, x2, y2 } = annotation;
        const box = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
        if (annotation.status === "approved") {
          context.fillStyle = "#000000";
          context.fillRect(...box);
        } else {
          context.fillStyle = "rgba(224, 49, 49, 0.18)";
          context.fillRect(...box);
          context.strokeStyle = "#e03131";
          context.lineWidth = 1.5;
          context.setLineDash([4, 3]);
          context.strokeRect(...box);
          context.setLineDash([]);
        }
      } else if (annotation.type === "highlight") {
        context.globalCompositeOperation = "multiply";
        context.fillStyle = rgbCss(highlightRgb(annotation.color));
        for (const [x, y, width, height] of annotation.rects) {
          context.fillRect(x, y, width, height);
        }
        context.globalCompositeOperation = "source-over";
      } else if (annotation.type === "underline" || annotation.type === "strike") {
        context.strokeStyle = annotation.color;
        for (const rect of annotation.rects) {
          const line = textDecorationLine(annotation.type, rect);
          context.lineWidth = line.thickness;
          context.beginPath();
          context.moveTo(line.x1, line.y1);
          context.lineTo(line.x2, line.y2);
          context.stroke();
        }
      } else if (annotation.type === "text") {
        const { lines, width, height } = layoutText(annotation);
        if (annotation.background) {
          context.fillStyle = annotation.background;
          context.fillRect(annotation.x, annotation.y, width, height);
        }
        context.fillStyle = annotation.color;
        context.font = textFont(annotation.fontSize);
        context.textBaseline = "top";
        const leading = ((TEXT_LINE_HEIGHT - 1) / 2) * annotation.fontSize;
        lines.forEach((line, index) => {
          context.fillText(line, annotation.x, annotation.y + leading + index * annotation.fontSize * TEXT_LINE_HEIGHT);
        });
      } else {
        context.strokeStyle = annotation.color;
        context.lineWidth = annotation.width;
        context.stroke(new Path2D(shapePath(annotation)));
      }
    }

    context.restore();
  }

  syncBar();

  return {
    addAnnotations,
    addTextMarkup,
    attachPage,
    count: () => annotations.length,
    countRedactions,
    defaultColor,
    drawOnCanvas,
    exportPdf,
    fitFontSize,
    flush: flushSave,
    getLayers,
    getTool: () => tool,
    handleKeydown,
    isOpen: () => open,
    isTextTool: () => open && TEXT_TOOLS.has(tool),
    listAnnotations,
    removeAnnotations,
    revealAnnotation,
    setDocument,
    setLayerVisible,
    setOpen,
    updateAnnotations,
    updatePageSize
  };
}
