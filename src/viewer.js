import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { createAssistant } from "./ai.js";
import { t, translateDom } from "./i18n.js";
import { createLens } from "./lens.js";
import { createMarkup } from "./markup.js";
import { buildImagePdf, dataUrlToBytes } from "./pdf-writer.js";
import { createReferences } from "./references.js";
import { getItem, removeItem, setItem } from "./store.js";
import { createWorkspace } from "./workspace.js";

const params = new URLSearchParams(window.location.search);
const initialPdfUrl = params.get("src") || "";

translateDom();

const $ = selector => document.querySelector(selector);

const elements = {
  aiPanel: $("#aiPanel"),
  aiResizerX: $("#aiResizerX"),
  aiResizerY: $("#aiResizerY"),
  annotationList: $("#annotationList"),
  appShell: $("#appShell"),
  documentTitle: $("#documentTitle"),
  documentUrl: $("#documentUrl"),
  downloadPdf: $("#downloadPdf"),
  dropOverlay: $("#dropOverlay"),
  emptyOpenFile: $("#emptyOpenFile"),
  emptyState: $("#emptyState"),
  fileInput: $("#fileInput"),
  layerPill: $("#layerPill"),
  markupBar: $("#markupBar"),
  markupToggle: $("#markupToggle"),
  openFile: $("#openFile"),
  outlineList: $("#outlineList"),
  pageCount: $("#pageCount"),
  pageInput: $("#pageInput"),
  pageNext: $("#pageNext"),
  pagePrev: $("#pagePrev"),
  pdfPages: $("#pdfPages"),
  pdfShell: $("#pdfShell"),
  searchBox: $("#searchBox"),
  searchClose: $("#searchClose"),
  searchCount: $("#searchCount"),
  searchInput: $("#searchInput"),
  searchNext: $("#searchNext"),
  searchPrev: $("#searchPrev"),
  searchToggle: $("#searchToggle"),
  selectionPopover: $("#selectionPopover"),
  sidebar: $("#sidebar"),
  sidebarBody: $(".sidebar-body"),
  sidebarClose: $("#sidebarClose"),
  sidebarOpen: $("#sidebarOpen"),
  sidebarResizer: $("#sidebarResizer"),
  sidebarTabs: $("#sidebarTabs"),
  signatureDialog: $("#signatureDialog"),
  thumbnailList: $("#thumbnailList"),
  settingsToggle: $("#settingsToggle"),
  toast: $("#toast"),
  toolDock: $("#toolDock"),
  viewerStage: $("#viewerStage"),
  workspaceSplitter: $("#workspaceSplitter"),
  zoomIn: $("#zoomIn"),
  zoomMenu: $("#zoomMenu"),
  zoomMenuLabel: $("#zoomMenuLabel"),
  zoomOut: $("#zoomOut"),
  zoomReset: $("#zoomReset")
};

pdfjsLib.GlobalWorkerOptions.workerSrc = typeof chrome !== "undefined" && chrome.runtime?.getURL
  ? chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs")
  : new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const CSS_UNITS = 96 / 72;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
// Fraction of the remaining zoom distance covered per 60 Hz frame (in log space, so every step feels equal).
const ZOOM_SMOOTHING = 0.22;
const RENDER_SETTLE_MS = 110;
const MAX_CANVAS_PIXELS = 16_777_216;
const THUMBNAIL_WIDTH = 120;
const AUTO_FIT_MAX_WIDTH = 1080;
const AGENT_GRID = 1000;
const AGENT_IMAGE_LONG_SIDE = 1600;
const REGION_IMAGE_LONG_SIDE = 1200;
const FLATTEN_SCALE = 150 / 72;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const narrowScreen = window.matchMedia("(max-width: 820px)");

const state = {
  doc: null,
  docKey: "",
  fileName: "",
  originalBytes: null,
  pages: [],
  loadToken: 0,
  currentPage: 1,
  zoom: 1,
  zoomMode: "auto",
  aiOutline: null
};

const pageTextPromises = new Map();
const pageTextData = new Map();
const pageByShell = new WeakMap();
const zoomAnimation = { frame: 0, target: 1, focalX: 0, focalY: 0, last: 0 };
const search = { query: "", matches: [], index: -1, token: 0, timer: 0, pendingScroll: false };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

let pageObserver = null;
let thumbnailObserver = null;
let thumbnailQueue = Promise.resolve();
let renderHeld = false;
let renderPending = false;
let renderRunning = false;
let settleTimer = 0;
let scrollFrame = 0;
let toastTimer = 0;
let popoverSelection = null;
let pointerStartedInPages = false;
let dragDepth = 0;
let lastSelectedText = "";
let contentRevision = 0;
const formEdits = new Map();
const fieldIndex = new Map();

// Notebook, to-dos and profile beside the assistant. While it's open, it and the assistant cover the page.
const workspace = createWorkspace({
  toast,
  host: {
    goToPage: number => scrollToPage(number),
    getCurrentPage: () => state.currentPage,
    listHighlights: () => (state.doc ? markup.listAnnotations(0) : [])
      .filter(item => item.text && ["highlight", "underline", "strike"].includes(item.type))
      .map(item => ({ page: item.page, text: item.text, color: item.color }))
  },
  onToggle: open => {
    elements.appShell.classList.toggle("workspace-open", open);
    if (open && !assistant.isOpen()) {
      assistant.open();
    }
  }
});

const markup = createMarkup({
  pdfPages: elements.pdfPages,
  bar: elements.markupBar,
  list: elements.annotationList,
  signatureDialog: elements.signatureDialog,
  getPages: () => state.pages,
  goToPage: scrollToPage,
  toast,
  onChange: () => {
    contentRevision += 1;
    syncLayerPill();
    workspace.markupChanged();
  },
  onVisibilityChange: visible => {
    elements.markupToggle.setAttribute("aria-pressed", String(visible));
    elements.markupToggle.title = visible ? t("Hide markup toolbar") : t("Show markup toolbar");
  }
});

const assistant = createAssistant({
  getSelectedText: () => lastSelectedText,
  toast,
  onClose: () => workspace.close(),
  // Everything the assistant can see or change goes through this host (see "AI agent host" below).
  host: {
    getDocumentInfo: () => ({
      key: state.docKey,
      name: state.fileName,
      pageCount: state.pages.length,
      currentPage: state.currentPage
    }),
    getRevision: () => contentRevision,
    renderPageImage: agentRenderPageImage,
    renderRegionImage: agentRenderRegionImage,
    getPageText: async number => (await getPageText(agentPage(number).number)).readable,
    getPageLayout: agentGetPageLayout,
    searchDocument: agentSearchDocument,
    getOutline: agentGetOutline,
    setOutline: agentSetOutline,
    findText: agentFindText,
    listFormFields: agentListFormFields,
    fillFormFields: agentFillFormFields,
    addText: agentAddText,
    addTextLayer: agentAddTextLayer,
    highlightText: agentHighlightText,
    drawShape: agentDrawShape,
    listMarkup: agentListMarkup,
    deleteMarkup: ids => markup.removeAnnotations(ids),
    revealMarkup: id => markup.revealAnnotation(id),
    revealBox: agentRevealBox,
    proposeRedactions: agentProposeRedactions,
    resolveRedactions: agentResolveRedactions,
    getLayers: () => markup.getLayers(),
    setLayerVisible: (name, visible) => markup.setLayerVisible(name, visible),
    goToPage: number => scrollToPage(agentPage(number).number),
    workspace,
    placeSignature: (number, gridBox) => {
      const page = agentPage(number);
      return markup.placeSignatureInBox(page.number, gridToUnits(page, gridBox));
    },
    // Appearance lives in the assistant's settings sheet, the one settings page in the viewer.
    getTheme: () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    setTheme: theme => {
      applyTheme(theme);
      setItem("theme", theme);
    }
  }
});

// Reference pop-outs ("see Figure 2") and the ⌥ explain lens share the same page helpers.
const pageTools = {
  stage: elements.viewerStage,
  shell: elements.pdfShell,
  pages: () => state.pages,
  currentPage: () => state.currentPage,
  loadToken: () => state.loadToken,
  textGeometry: number => getTextGeometry(number),
  layout: number => pageLayoutBlocks(number),
  outline: () => agentGetOutline(),
  renderRegion: (number, box, options) => renderRegionUnits(state.pages[number - 1], box, options),
  goToPage: (number, offset) => scrollToPage(number, offset),
  flashBox: (number, box) => flashBox(state.pages[number - 1], box),
  toGrid: (number, box) => toGridBox(state.pages[number - 1], box),
  toast
};
const references = createReferences(pageTools, { onExplain: (page, box, text) => lens.explainBox(page, box, text) });
const lens = createLens(pageTools, {
  quickAsk: options => assistant.quickAsk(options),
  openChat: options => assistant.open(options)
});

// ---------- Utilities ----------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatFileName(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return lastSegment || "Document.pdf";
  } catch {
    return "Document.pdf";
  }
}

function formatHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return t("this site");
  }
}

function ensurePdfExtension(name) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select") || target?.isContentEditable);
}

function toast(message, duration = 2400) {
  clearTimeout(toastTimer);
  elements.toast.hidden = true;
  elements.toast.textContent = message;
  void elements.toast.offsetWidth;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, duration);
}

function currentScale() {
  return state.zoom * CSS_UNITS;
}

// ---------- Loading ----------

function resetViewer() {
  state.loadToken += 1;
  clearTimeout(settleTimer);
  cancelZoomAnimation();
  pageObserver?.disconnect();
  thumbnailObserver?.disconnect();
  pageObserver = null;
  thumbnailObserver = null;

  for (const page of state.pages) {
    page.renderTask?.cancel();
  }

  // PDF.js 6 tears a document down through its loading task; the proxy itself has no destroy().
  state.doc?.loadingTask?.destroy().catch(() => {});
  state.doc = null;
  state.pages = [];
  state.originalBytes = null;
  state.currentPage = 1;
  state.aiOutline = null;
  pageTextPromises.clear();
  pageTextData.clear();
  formEdits.clear();
  fieldIndex.clear();
  search.token += 1;
  search.matches = [];
  search.index = -1;
  hidePopover();
  references.reset();
  lens.reset();
  elements.pdfPages.replaceChildren();
  syncLayerPill();
  return state.loadToken;
}

function showEmptyState(title, message) {
  elements.pdfShell.hidden = true;
  elements.emptyState.hidden = false;
  elements.emptyState.querySelector("h2").textContent = title;
  elements.emptyState.querySelector("p").textContent = message;
  elements.thumbnailList.innerHTML = `<div class="sidebar-empty">${t("No document loaded")}</div>`;
  elements.outlineList.innerHTML = `<div class="sidebar-empty">${t("No table of contents")}</div>`;
  elements.documentTitle.textContent = "PaperLens";
  elements.documentUrl.textContent = t("No document loaded");
  elements.pageInput.value = "";
  elements.pageCount.textContent = t("of –");
  elements.downloadPdf.disabled = true;
  elements.appShell.classList.add("no-document");
  closeFlyouts();
}

function prepareLoading(name, status) {
  elements.appShell.classList.remove("no-document");
  elements.emptyState.hidden = true;
  elements.pdfShell.hidden = false;
  elements.documentTitle.textContent = name;
  document.title = name;
  elements.documentUrl.textContent = status;
  elements.thumbnailList.innerHTML = `<div class="sidebar-empty">${t("Loading…")}</div>`;
  elements.outlineList.innerHTML = `<div class="sidebar-empty">${t("Loading…")}</div>`;
  elements.downloadPdf.disabled = true;
}

function describeLoadError(error, fallback) {
  if (error?.name === "PasswordException") {
    return t("This PDF is password-protected, which this viewer doesn't support yet.");
  }
  if (error?.name === "InvalidPDFException") {
    return t("This file doesn't look like a valid PDF.");
  }
  return fallback;
}

async function loadFromUrl(url) {
  const token = resetViewer();
  const name = formatFileName(url);
  prepareLoading(name, t("Loading from {host}…", { host: formatHost(url) }));

  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (token !== state.loadToken) {
      return;
    }

    await openDocument(bytes, { token, name, key: url });
  } catch (error) {
    if (token !== state.loadToken) {
      return;
    }
    console.error(error);
    resetViewer();
    showEmptyState(t("Couldn't open this PDF"), describeLoadError(error, t("The file from {host} couldn't be loaded ({error}). Some sites block access to their files.", { host: formatHost(url), error: error.message })));
  }
}

async function loadFromFile(file) {
  const token = resetViewer();
  prepareLoading(file.name, t("Opening…"));

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (token !== state.loadToken) {
      return;
    }

    await openDocument(bytes, {
      token,
      name: file.name,
      key: `file:${file.name}:${file.size}:${file.lastModified}`
    });
  } catch (error) {
    if (token !== state.loadToken) {
      return;
    }
    console.error(error);
    resetViewer();
    showEmptyState(t("Couldn't open this PDF"), describeLoadError(error, t("Something went wrong while reading this file.")));
  }
}

async function openDocument(bytes, { token, name, key }) {
  state.originalBytes = bytes.slice();
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;

  if (token !== state.loadToken) {
    doc.loadingTask?.destroy().catch(() => {});
    return;
  }

  state.doc = doc;
  state.docKey = key;
  state.fileName = ensurePdfExtension(name);

  const firstPage = await doc.getPage(1);
  await markup.setDocument(key);
  const savedForms = await getItem(`forms:${key}`, null);
  if (token !== state.loadToken) {
    return;
  }
  for (const [id, value] of Object.entries(savedForms || {})) {
    doc.annotationStorage.setValue(id, { value });
    formEdits.set(id, value);
  }

  const firstViewport = firstPage.getViewport({ scale: 1 });
  state.pages = Array.from({ length: doc.numPages }, (_, index) => createPage(index + 1, firstViewport));
  state.pages[0].pdfPage = firstPage;

  elements.pdfPages.replaceChildren(...state.pages.map(page => page.shell));
  elements.thumbnailList.replaceChildren(...state.pages.map(page => page.thumbnail));
  for (const page of state.pages) {
    markup.attachPage(page);
  }

  elements.pageCount.textContent = t("of {count}", { count: doc.numPages });
  elements.downloadPdf.disabled = false;

  state.zoomMode = "auto";
  zoomAnimation.target = computeFitZoom("auto");
  applyZoom(zoomAnimation.target);
  updateZoomLabel(state.zoom);
  elements.pdfShell.scrollTo(0, 0);

  setCurrentPage(1);
  observePages();
  observeThumbnails();
  assistant.setDocument(key);
  workspace.setDocument(key, state.fileName);
  buildOutline(token);
  loadPageSizes(token);

  if (elements.searchInput.value.trim()) {
    runSearch(elements.searchInput.value);
  }
}

// ---------- Pages ----------

function createPage(number, viewport) {
  const shell = document.createElement("div");
  shell.className = "pdf-page-shell";
  shell.dataset.pageNumber = String(number);
  shell.setAttribute("aria-label", t("Page {page}", { page: number }));

  const page = {
    number,
    shell,
    thumbnail: buildThumbnail(number),
    viewport,
    width: 0,
    height: 0,
    pdfPage: null,
    canvas: null,
    renderedScale: 0,
    failedScale: 0,
    renderTask: null,
    near: false,
    textLayer: null,
    textLayerStarted: false,
    linksStarted: false,
    formLayer: null,
    formLayerStarted: false,
    highlightedDivs: []
  };

  pageByShell.set(shell, page);
  setPageViewport(page, viewport);
  return page;
}

function setPageViewport(page, viewport) {
  page.viewport = viewport;
  page.width = viewport.width;
  page.height = viewport.height;

  const { style } = page.shell;
  style.width = `calc(var(--total-scale-factor) * ${page.width}px)`;
  style.height = `calc(var(--total-scale-factor) * ${page.height}px)`;
  // Match PDF.js's text layer sizing exactly when round() is supported.
  style.width = `round(down, var(--total-scale-factor) * ${page.width}px, var(--scale-round-x))`;
  style.height = `round(down, var(--total-scale-factor) * ${page.height}px, var(--scale-round-y))`;
  page.thumbnail.querySelector(".thumbnail-preview").style.aspectRatio = `${page.width} / ${page.height}`;
}

function syncPageViewport(page) {
  const viewport = page.pdfPage.getViewport({ scale: 1 });
  const changed = Math.abs(viewport.width - page.width) > 0.5 ||
    Math.abs(viewport.height - page.height) > 0.5 ||
    viewport.rotation !== page.viewport.rotation;

  if (changed) {
    setPageViewport(page, viewport);
    markup.updatePageSize(page);
  } else {
    page.viewport = viewport;
  }
}

async function loadPageSizes(token) {
  try {
    for (const page of state.pages.slice(1)) {
      if (token !== state.loadToken) {
        return;
      }
      page.pdfPage ||= await state.doc.getPage(page.number);
      if (token !== state.loadToken) {
        return;
      }
      syncPageViewport(page);
    }
  } catch {
    // The document was closed while sizes were loading.
  }
}

function observePages() {
  pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const page = pageByShell.get(entry.target);
      if (!page) {
        continue;
      }
      page.near = entry.isIntersecting;
      if (!page.near) {
        releasePage(page);
      }
    }
    scheduleRender();
  }, {
    root: elements.pdfShell,
    rootMargin: "100% 25%"
  });

  for (const page of state.pages) {
    pageObserver.observe(page.shell);
  }
}

// A page that scrolled far away gives back its bitmap and DOM layers; they are rebuilt when it
// comes near again, so a 500-page document costs about as much as a 10-page one.
function releasePage(page) {
  page.renderTask?.cancel();
  page.renderTask = null;

  if (page.canvas) {
    page.canvas.width = 0;
    page.canvas.height = 0;
    page.canvas.remove();
    page.canvas = null;
  }

  page.textLayer?.cancel();
  page.textLayerDiv?.remove();
  page.textLayerDiv = null;
  page.textLayer = null;
  page.highlightedDivs = [];
  page.textLayerStarted = false;
  page.linkLayer?.remove();
  page.linkLayer = null;
  page.linksStarted = false;
  references.release(page);

  // The form layer stays while a field on it has focus (a keyboard scroll shouldn't eat the caret).
  if (page.formLayer && !page.formLayer.contains(document.activeElement)) {
    rebuildFormLayer(page);
  }

  page.renderedScale = 0;
}

function scheduleRender() {
  if (renderPending) {
    return;
  }

  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    pumpRenderQueue();
  });
}

async function pumpRenderQueue() {
  if (renderRunning) {
    return;
  }

  renderRunning = true;
  const token = state.loadToken;

  try {
    while (token === state.loadToken && !renderHeld && !zoomAnimation.frame) {
      const page = nextPageToRender();
      if (!page) {
        break;
      }
      await renderPage(page, token);
    }
  } finally {
    renderRunning = false;
  }
}

function nextPageToRender() {
  const scale = currentScale();
  const viewport = elements.pdfShell.getBoundingClientRect();
  const centerY = viewport.top + viewport.height / 2;
  let best = null;
  let bestScore = Infinity;

  for (const page of state.pages) {
    if (!page.near || page.renderedScale === scale || page.failedScale === scale) {
      continue;
    }

    const rect = page.shell.getBoundingClientRect();
    const outside = rect.bottom < viewport.top
      ? viewport.top - rect.bottom
      : rect.top > viewport.bottom ? rect.top - viewport.bottom : 0;
    const score = outside * 10 + Math.abs(rect.top + rect.height / 2 - centerY) * 0.001;

    if (score < bestScore) {
      best = page;
      bestScore = score;
    }
  }

  return best;
}

async function renderPage(page, token) {
  let task = null;

  try {
    page.pdfPage ||= await state.doc.getPage(page.number);
    if (token !== state.loadToken) {
      return;
    }

    syncPageViewport(page);

    const scale = currentScale();
    const cssArea = page.width * scale * page.height * scale;
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / cssArea));
    const viewport = page.pdfPage.getViewport({ scale: scale * ratio });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    // Form fields are drawn as real inputs by the form layer, so the bitmap leaves them out.
    task = page.pdfPage.render({
      canvas,
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS
    });
    page.renderTask = task;
    await task.promise;

    if (token !== state.loadToken || !page.near) {
      canvas.width = 0;
      return;
    }

    // Swap in the sharp bitmap only once it is fully painted, so zooming never flashes blank pages.
    if (page.canvas) {
      const previous = page.canvas;
      previous.replaceWith(canvas);
      previous.width = 0;
    } else {
      page.shell.prepend(canvas);
    }

    page.canvas = canvas;
    page.renderedScale = scale;
    ensureTextLayer(page, token);
    ensureLinkLayer(page, token);
    ensureFormLayer(page, token);
  } catch (error) {
    if (error?.name !== "RenderingCancelledException" && token === state.loadToken) {
      page.failedScale = currentScale();
      console.error(error);
    }
  } finally {
    if (task && page.renderTask === task) {
      page.renderTask = null;
    }
  }
}

async function ensureTextLayer(page, token) {
  if (page.textLayerStarted) {
    return;
  }
  page.textLayerStarted = true;

  try {
    const { content } = await getPageText(page.number);
    if (token !== state.loadToken) {
      return;
    }

    const container = document.createElement("div");
    container.className = "textLayer";
    page.shell.append(container);
    page.textLayerDiv = container;

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: content,
      container,
      viewport: page.viewport
    });
    await textLayer.render();
    if (token !== state.loadToken) {
      return;
    }

    const endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    container.append(endOfContent);
    page.textLayer = textLayer;
    applySearchHighlights(page);
    references.attach(page, token);
  } catch (error) {
    if (token === state.loadToken) {
      console.warn(`Text layer for page ${page.number} failed`, error);
    }
  }
}

// Annotations are fetched once per page and shared by the link layer, form layer and form tools.
function pageAnnotations(page) {
  if (!page.annotationsPromise) {
    page.annotationsPromise = page.pdfPage.getAnnotations({ intent: "display" }).catch(error => {
      page.annotationsPromise = null;
      throw error;
    });
  }
  return page.annotationsPromise;
}

async function ensureLinkLayer(page, token) {
  if (page.linksStarted) {
    return;
  }
  page.linksStarted = true;

  try {
    const annotations = await pageAnnotations(page);
    if (token !== state.loadToken) {
      return;
    }

    const links = annotations.filter(annotation => annotation.subtype === "Link" && (annotation.url || annotation.dest));
    if (!links.length) {
      return;
    }

    const layer = document.createElement("div");
    layer.className = "link-layer";
    page.linkLayer = layer;

    for (const annotation of links) {
      const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(annotation.rect);
      const [ax, ay] = page.viewport.convertToViewportPoint(x1, y1);
      const [bx, by] = page.viewport.convertToViewportPoint(x2, y2);
      const link = document.createElement("a");
      link.style.left = `${(Math.min(ax, bx) / page.width) * 100}%`;
      link.style.top = `${(Math.min(ay, by) / page.height) * 100}%`;
      link.style.width = `${(Math.abs(bx - ax) / page.width) * 100}%`;
      link.style.height = `${(Math.abs(by - ay) / page.height) * 100}%`;

      if (annotation.url) {
        link.href = annotation.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = annotation.url;
      } else {
        link.href = "#";
        link.addEventListener("click", event => {
          event.preventDefault();
          goToDestination(annotation.dest);
        });
      }

      layer.append(link);
    }

    page.shell.append(layer);
  } catch {
    // Links are a convenience; a page without them still renders fine.
  }
}

// ---------- Form fields ----------
// Real PDF form fields are rendered by PDF.js's annotation layer as native inputs, sharing one
// annotation storage with the assistant's fill tool, so both the reader and the AI can edit them.

const formLinkService = {
  eventBus: null,
  externalLinkEnabled: true,
  isInPresentationMode: false,
  getDestinationHash: () => "#",
  getAnchorUrl: () => "#",
  goToDestination: dest => goToDestination(dest),
  addLinkAttributes(link, url) {
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  },
  executeNamedAction() {},
  executeSetOCGState() {}
};

function indexFormFields(page, annotations) {
  for (const annotation of annotations) {
    if (formFieldType(annotation)) {
      fieldIndex.set(annotation.id, { annotation, page: page.number });
    }
  }
}

async function ensureFormLayer(page, token) {
  if (page.formLayerStarted) {
    return;
  }
  page.formLayerStarted = true;

  try {
    const annotations = await pageAnnotations(page);
    if (token !== state.loadToken) {
      return;
    }
    indexFormFields(page, annotations);

    const widgets = annotations.filter(annotation => annotation.subtype === "Widget" && annotation.fieldType && !annotation.hidden);
    if (!widgets.length) {
      return;
    }

    const div = document.createElement("div");
    div.className = "annotationLayer";
    page.shell.append(div);

    const layer = new pdfjsLib.AnnotationLayer({
      div,
      page: page.pdfPage,
      viewport: page.viewport,
      annotationStorage: state.doc.annotationStorage,
      linkService: formLinkService
    });
    await layer.render({ annotations: widgets, renderForms: true, enableScripting: false, hasJSActions: false });
    if (token !== state.loadToken) {
      div.remove();
      return;
    }

    page.formLayer = div;
    const onEdit = () => syncFormEditsFromStorage(page.number);
    div.addEventListener("input", onEdit);
    div.addEventListener("change", onEdit);
  } catch (error) {
    if (token === state.loadToken) {
      console.warn(`Form layer for page ${page.number} failed`, error);
    }
  }
}

function rebuildFormLayer(page) {
  page.formLayer?.remove();
  page.formLayer = null;
  page.formLayerStarted = false;
}

let formPersistTimer = 0;

// Typing fires an input event per keystroke; the saved copy only needs to catch up once it settles.
function persistFormEdits({ immediate = false } = {}) {
  clearTimeout(formPersistTimer);
  const write = () => {
    const key = `forms:${state.docKey}`;
    if (formEdits.size) {
      setItem(key, Object.fromEntries(formEdits));
    } else {
      removeItem(key);
    }
  };
  if (immediate) {
    write();
  } else {
    formPersistTimer = window.setTimeout(write, 400);
  }
}

// The reader typed into a field: mirror PDF.js's storage into our saved edits and refresh previews.
function syncFormEditsFromStorage(pageNumber) {
  const storage = state.doc?.annotationStorage;
  if (!storage) {
    return;
  }
  for (const [id, entry] of fieldIndex) {
    if (entry.page !== pageNumber) {
      continue;
    }
    const value = storage.getRawValue(id)?.value;
    if (value === undefined) {
      formEdits.delete(id);
    } else {
      formEdits.set(id, value);
    }
  }
  contentRevision += 1;
  persistFormEdits();

  const page = state.pages[pageNumber - 1];
  const token = state.loadToken;
  clearTimeout(page.thumbnailTimer);
  page.thumbnailTimer = window.setTimeout(() => {
    thumbnailQueue = thumbnailQueue.then(() => renderThumbnail(page, token)).catch(() => {});
  }, 600);
}

function getPageText(number) {
  if (!pageTextPromises.has(number)) {
    const doc = state.doc;
    const promise = doc.getPage(number)
      .then(pdfPage => pdfPage.getTextContent())
      .then(content => {
        const items = [];
        const strings = [];
        const starts = [];
        let text = "";
        let readable = "";

        for (const item of content.items) {
          if (item.str === undefined) {
            continue;
          }
          starts.push(text.length);
          items.push(item);
          strings.push(item.str);
          text += item.str + (item.hasEOL ? " " : "");
          readable += item.str + (item.hasEOL ? "\n" : "");
        }

        const data = { content, items, strings, starts, text, lower: text.toLowerCase(), readable };
        if (doc === state.doc) {
          pageTextData.set(number, data);
        }
        return data;
      });
    pageTextPromises.set(number, promise);
  }

  return pageTextPromises.get(number);
}

// ---------- Thumbnails & outline ----------

function buildThumbnail(number) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumbnail-item";
  button.dataset.pageNumber = String(number);
  button.setAttribute("aria-label", t("Go to page {page}", { page: number }));

  const preview = document.createElement("span");
  preview.className = "thumbnail-preview";

  const label = document.createElement("span");
  label.className = "thumbnail-label";
  label.textContent = String(number);

  button.append(preview, label);
  button.addEventListener("click", () => scrollToPage(number));
  return button;
}

function observeThumbnails() {
  const token = state.loadToken;
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      thumbnailObserver.unobserve(entry.target);
      const page = state.pages[Number(entry.target.dataset.pageNumber) - 1];
      thumbnailQueue = thumbnailQueue.then(() => renderThumbnail(page, token)).catch(() => {});
    }
  }, {
    root: elements.sidebarBody,
    rootMargin: "400px 0px"
  });

  for (const page of state.pages) {
    thumbnailObserver.observe(page.thumbnail);
  }
}

async function renderThumbnail(page, token) {
  if (!page || token !== state.loadToken) {
    return;
  }

  page.pdfPage ||= await state.doc.getPage(page.number);
  if (token !== state.loadToken) {
    return;
  }

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.pdfPage.getViewport({ scale: (THUMBNAIL_WIDTH / page.width) * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  await page.pdfPage.render({
    canvas,
    canvasContext: canvas.getContext("2d", { alpha: false }),
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE
  }).promise;

  if (token === state.loadToken) {
    page.thumbnail.querySelector(".thumbnail-preview").replaceChildren(canvas);
  }
}

function outlineButton(title, depth, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline-item";
  button.style.setProperty("--depth", String(depth));
  button.textContent = title || t("Untitled");
  button.title = title || "";
  button.addEventListener("click", onClick);
  return button;
}

// Shown when the PDF has no bookmarks: the assistant can build a table of contents from the text.
function renderOutlineEmpty() {
  elements.outlineList.innerHTML = `
    <div class="sidebar-empty outline-empty">
      <span>${t("This PDF has no table of contents")}</span>
      <button type="button" class="text-button" data-outline-action="generate">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path></svg>
        ${t("Ask AI to build one")}
      </button>
    </div>`;
}

// An outline the assistant built (set_outline): flat entries with page numbers, kept per document.
function renderAiOutline(entries) {
  const items = entries.map(entry => outlineButton(entry.title, entry.depth || 0, () => scrollToPage(entry.page)));
  const note = document.createElement("div");
  note.className = "outline-note";
  note.innerHTML = `<span>${t("Built by AI from the text")}</span><button type="button" data-outline-action="generate">${t("Rebuild")}</button>`;
  elements.outlineList.replaceChildren(note, ...items);
}

async function buildOutline(token) {
  let outline = null;
  try {
    outline = await state.doc.getOutline();
  } catch {
    outline = null;
  }

  if (token !== state.loadToken) {
    return;
  }

  if (!outline?.length) {
    const saved = await getItem(`outline:${state.docKey}`, null);
    if (token !== state.loadToken) {
      return;
    }
    state.aiOutline = Array.isArray(saved) && saved.length ? saved : null;
    if (state.aiOutline) {
      renderAiOutline(state.aiOutline);
    } else {
      renderOutlineEmpty();
    }
    return;
  }

  const items = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      items.push(outlineButton(node.title, depth, () => {
        if (node.dest) {
          goToDestination(node.dest);
        } else if (node.url) {
          window.open(node.url, "_blank", "noopener");
        }
      }));
      if (node.items?.length && depth < 6) {
        walk(node.items, depth + 1);
      }
    }
  };

  walk(outline, 0);
  elements.outlineList.replaceChildren(...items);
}

function agentSetOutline(entries) {
  if (!state.doc) {
    throw new Error("No PDF is open.");
  }
  const clean = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      title: String(entry?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      page: clamp(Math.round(Number(entry?.page)) || 1, 1, state.pages.length),
      depth: clamp(Math.round(Number(entry?.depth)) || 0, 0, 5)
    }))
    .filter(entry => entry.title)
    .slice(0, 400);
  if (!clean.length) {
    throw new Error("Pass at least one entry with a title and page.");
  }
  state.aiOutline = clean;
  setItem(`outline:${state.docKey}`, clean);
  renderAiOutline(clean);
  showSidebarPanel("outline");
  if (elements.appShell.classList.contains("sidebar-collapsed") && !narrowScreen.matches) {
    setSidebarCollapsed(false);
  }
  return clean.length;
}

async function goToDestination(dest) {
  try {
    const explicit = typeof dest === "string" ? await state.doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) {
      return;
    }

    const [ref, mode, ...args] = explicit;
    const pageIndex = Number.isInteger(ref) ? ref : await state.doc.getPageIndex(ref);
    const page = state.pages[pageIndex];
    if (!page) {
      return;
    }

    let top = null;
    if (mode?.name === "XYZ") {
      top = args[1];
    } else if (mode?.name === "FitH" || mode?.name === "FitBH") {
      top = args[0];
    }

    const offset = typeof top === "number" ? page.viewport.convertToViewportPoint(0, top)[1] : 0;
    scrollToPage(pageIndex + 1, Math.max(0, offset));
  } catch {
    toast(t("Couldn't follow that link"));
  }
}

// ---------- Navigation ----------

function setCurrentPage(number) {
  const page = state.pages[number - 1];
  if (!page) {
    return;
  }

  const previous = state.pages[state.currentPage - 1];
  previous?.thumbnail.classList.remove("is-selected");
  state.currentPage = number;
  page.thumbnail.classList.add("is-selected");

  if (document.activeElement !== elements.pageInput) {
    elements.pageInput.value = String(number);
  }
  elements.documentUrl.textContent = t("Page {page} of {total}", { page: number, total: state.pages.length });
}

function scrollToPage(number, offsetInPoints = 0, behavior = "smooth") {
  const page = state.pages[clamp(Math.round(number), 1, state.pages.length) - 1];
  if (!page) {
    return;
  }

  const shellRect = elements.pdfShell.getBoundingClientRect();
  const pageRect = page.shell.getBoundingClientRect();
  const top = elements.pdfShell.scrollTop + pageRect.top - shellRect.top + offsetInPoints * currentScale() - 16;

  elements.pdfShell.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? "auto" : behavior });
  setCurrentPage(page.number);
}

function findPageNear(clientY) {
  const near = state.pages.filter(page => page.near);
  const candidates = near.length ? near : [state.pages[state.currentPage - 1]].filter(Boolean);
  let best = null;
  let bestDistance = Infinity;

  for (const page of candidates) {
    const rect = page.shell.getBoundingClientRect();
    const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (distance < bestDistance) {
      best = page;
      bestDistance = distance;
      if (distance === 0) {
        break;
      }
    }
  }

  return best;
}

function updateCurrentPageFromScroll() {
  if (!state.pages.length) {
    return;
  }

  const shell = elements.pdfShell;
  if (shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 2) {
    const lastNear = state.pages.findLast(page => page.near);
    if (lastNear) {
      setCurrentPage(lastNear.number);
      return;
    }
  }

  const rect = shell.getBoundingClientRect();
  const page = findPageNear(rect.top + Math.min(rect.height * 0.4, 280));
  if (page && page.number !== state.currentPage) {
    setCurrentPage(page.number);
  }
}

// ---------- Zoom ----------

function updateZoomLabel(value) {
  const percent = `${Math.round(value * 100)}%`;
  elements.zoomMenuLabel.textContent = percent;
  elements.zoomReset.title = t("Zoom options ({percent})", { percent });
  elements.zoomReset.setAttribute("aria-label", t("Zoom options, currently {percent}", { percent }));

  for (const option of elements.zoomMenu.querySelectorAll("[data-zoom]")) {
    const preset = Number(option.dataset.zoom);
    const current = Number.isNaN(preset)
      ? option.dataset.zoom === state.zoomMode
      : !state.zoomMode && Math.abs(preset - value) < 0.005;
    option.classList.toggle("is-current", current);
  }
}

function computeFitZoom(mode) {
  const page = state.pages[state.currentPage - 1] || state.pages[0];
  if (!page) {
    return 1;
  }

  const styles = getComputedStyle(elements.pdfShell);
  const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const availableWidth = Math.max(160, elements.pdfShell.clientWidth - paddingX);
  let zoom = availableWidth / (page.width * CSS_UNITS);

  if (mode === "auto") {
    zoom = Math.min(availableWidth, AUTO_FIT_MAX_WIDTH) / (page.width * CSS_UNITS);
  } else if (mode === "fit-page") {
    zoom = Math.min(zoom, (elements.pdfShell.clientHeight - 48) / (page.height * CSS_UNITS));
  }

  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

function setZoom(value, { focalX, focalY, animate = true, mode = null } = {}) {
  if (!state.pages.length) {
    return;
  }

  const rect = elements.pdfShell.getBoundingClientRect();
  state.zoomMode = mode;
  zoomAnimation.target = clamp(value, MIN_ZOOM, MAX_ZOOM);
  zoomAnimation.focalX = focalX ?? rect.left + rect.width / 2;
  zoomAnimation.focalY = focalY ?? rect.top + rect.height / 2;
  updateZoomLabel(zoomAnimation.target);
  hidePopover();
  holdRendering();

  if (!animate || reducedMotion.matches) {
    cancelZoomAnimation();
    applyZoom(zoomAnimation.target);
    return;
  }

  if (!zoomAnimation.frame) {
    zoomAnimation.last = performance.now();
    zoomAnimation.frame = requestAnimationFrame(stepZoom);
  }
}

function stepZoom(now) {
  const elapsed = Math.min(50, now - zoomAnimation.last);
  zoomAnimation.last = now;

  const progress = 1 - Math.pow(1 - ZOOM_SMOOTHING, elapsed / 16.67);
  const from = Math.log(state.zoom);
  const to = Math.log(zoomAnimation.target);
  let next = Math.exp(from + (to - from) * progress);
  const done = Math.abs(to - Math.log(next)) < 0.002;

  if (done) {
    next = zoomAnimation.target;
  }

  applyZoom(next);

  if (done) {
    zoomAnimation.frame = 0;
    holdRendering();
  } else {
    zoomAnimation.frame = requestAnimationFrame(stepZoom);
  }
}

function cancelZoomAnimation() {
  if (zoomAnimation.frame) {
    cancelAnimationFrame(zoomAnimation.frame);
  }
  zoomAnimation.frame = 0;
}

// Layout scales instantly through one CSS variable (canvases stretch on the GPU);
// sharp re-rendering waits until the zoom has come to rest.
function applyZoom(next) {
  const { focalX, focalY } = zoomAnimation;
  const anchor = findPageNear(focalY);
  let relativeX = 0;
  let relativeY = 0;

  if (anchor) {
    const rect = anchor.shell.getBoundingClientRect();
    relativeX = (focalX - rect.left) / rect.width;
    relativeY = (focalY - rect.top) / rect.height;
  }

  state.zoom = next;
  elements.pdfPages.style.setProperty("--total-scale-factor", String(next * CSS_UNITS));

  if (anchor) {
    const rect = anchor.shell.getBoundingClientRect();
    elements.pdfShell.scrollLeft += rect.left + relativeX * rect.width - focalX;
    elements.pdfShell.scrollTop += rect.top + relativeY * rect.height - focalY;
  }
}

function holdRendering() {
  for (const page of state.pages) {
    page.renderTask?.cancel();
  }

  renderHeld = true;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    if (zoomAnimation.frame) {
      holdRendering();
      return;
    }
    renderHeld = false;
    scheduleRender();
    updateCurrentPageFromScroll();
  }, RENDER_SETTLE_MS);
}

function zoomStep(direction) {
  const base = zoomAnimation.frame ? zoomAnimation.target : state.zoom;
  const next = direction > 0
    ? ZOOM_PRESETS.find(zoom => zoom > base * 1.01) ?? MAX_ZOOM
    : ZOOM_PRESETS.findLast(zoom => zoom < base / 1.01) ?? MIN_ZOOM;
  setZoom(next);
}

// ---------- Search ----------

// Flyouts open to the left of the tool dock, vertically centered on the button that opened them.
function positionFlyout(flyout, anchor) {
  const stage = elements.viewerStage.getBoundingClientRect();
  const dock = elements.toolDock.getBoundingClientRect();
  const button = anchor.getBoundingClientRect();
  const top = button.top - stage.top + button.height / 2 - flyout.offsetHeight / 2;
  flyout.style.right = `${stage.right - dock.left + 8}px`;
  flyout.style.top = `${clamp(top, 8, stage.height - flyout.offsetHeight - 8)}px`;
}

function closeFlyouts(except = null) {
  if (except !== elements.searchBox && !elements.searchBox.hidden) {
    closeSearch();
  }
  if (except !== elements.zoomMenu) {
    elements.zoomMenu.hidden = true;
  }
}

function repositionFlyouts() {
  if (!elements.searchBox.hidden) {
    positionFlyout(elements.searchBox, elements.searchToggle);
  }
  if (!elements.zoomMenu.hidden) {
    positionFlyout(elements.zoomMenu, elements.zoomReset);
  }
}

function openSearch() {
  if (elements.appShell.classList.contains("no-document")) {
    return;
  }
  closeFlyouts(elements.searchBox);
  elements.searchBox.hidden = false;
  positionFlyout(elements.searchBox, elements.searchToggle);
  elements.searchToggle.setAttribute("aria-pressed", "true");
  elements.searchInput.focus();
  elements.searchInput.select();
}

function closeSearch() {
  elements.searchBox.hidden = true;
  elements.searchToggle.setAttribute("aria-pressed", "false");
  elements.searchInput.value = "";
  elements.searchInput.blur();
  search.token += 1;
  search.query = "";
  search.matches = [];
  search.index = -1;
  for (const page of state.pages) {
    clearHighlights(page);
  }
  updateSearchCount();
}

function normalizeQuery(value) {
  return value.replace(/\s+/g, " ").trim();
}

function updateSearchCount(pending = false) {
  if (!search.query) {
    elements.searchCount.textContent = "";
  } else if (!search.matches.length) {
    elements.searchCount.textContent = pending ? "…" : "0";
  } else {
    elements.searchCount.textContent = `${Math.max(search.index + 1, 1)}/${search.matches.length}${pending ? "+" : ""}`;
  }
}

async function runSearch(rawQuery) {
  const query = normalizeQuery(rawQuery);
  const token = ++search.token;

  for (const page of state.pages) {
    clearHighlights(page);
  }

  const matches = [];
  search.query = query;
  search.matches = matches;
  search.index = -1;

  if (!query || !state.doc) {
    updateSearchCount();
    return;
  }

  updateSearchCount(true);
  const needle = query.toLowerCase();

  for (const page of state.pages) {
    let data;
    try {
      data = await getPageText(page.number);
    } catch {
      continue;
    }

    if (token !== search.token) {
      return;
    }

    const firstOnPage = matches.length;
    let index = data.lower.indexOf(needle);
    while (index !== -1) {
      matches.push({ page: page.number, start: index, end: index + needle.length });
      index = data.lower.indexOf(needle, index + needle.length);
    }

    if (matches.length > firstOnPage) {
      if (search.index === -1 && page.number >= state.currentPage) {
        goToMatch(firstOnPage);
      } else {
        applySearchHighlights(page);
      }
    }
    updateSearchCount(true);
  }

  if (search.index === -1 && matches.length) {
    goToMatch(0);
  }
  updateSearchCount();
}

function goToMatch(index) {
  const count = search.matches.length;
  if (!count) {
    return;
  }

  const previous = search.matches[search.index];
  search.index = ((index % count) + count) % count;
  const match = search.matches[search.index];
  updateSearchCount();

  if (previous && previous.page !== match.page) {
    applySearchHighlights(state.pages[previous.page - 1]);
  }

  const page = state.pages[match.page - 1];
  search.pendingScroll = true;

  if (page.textLayer) {
    applySearchHighlights(page);
  } else {
    scrollToPage(match.page, 0, "auto");
  }
}

function clearHighlights(page) {
  if (!page?.textLayer || !page.highlightedDivs.length) {
    return;
  }

  const { textDivs, textContentItemsStr } = page.textLayer;
  for (const index of page.highlightedDivs) {
    textDivs[index].textContent = textContentItemsStr[index];
  }
  page.highlightedDivs = [];
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

function applySearchHighlights(page) {
  if (!page?.textLayer) {
    return;
  }

  clearHighlights(page);
  const data = pageTextData.get(page.number);
  if (!data || !search.matches.length) {
    return;
  }

  const segments = new Map();
  search.matches.forEach((match, matchIndex) => {
    if (match.page !== page.number) {
      return;
    }

    for (let item = findItemIndex(data.starts, match.start); item < data.starts.length && data.starts[item] < match.end; item += 1) {
      const itemStart = data.starts[item];
      const from = Math.max(match.start, itemStart) - itemStart;
      const to = Math.min(match.end, itemStart + data.strings[item].length) - itemStart;
      if (to > from) {
        if (!segments.has(item)) {
          segments.set(item, []);
        }
        segments.get(item).push({ from, to, selected: matchIndex === search.index });
      }
    }
  });

  const { textDivs, textContentItemsStr } = page.textLayer;
  let selectedNode = null;

  for (const [item, parts] of segments) {
    const div = textDivs[item];
    const text = textContentItemsStr[item];
    if (!div) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const part of parts.sort((a, b) => a.from - b.from)) {
      if (part.from > cursor) {
        fragment.append(text.slice(cursor, part.from));
      }
      const mark = document.createElement("span");
      mark.className = part.selected ? "highlight selected" : "highlight";
      mark.textContent = text.slice(Math.max(part.from, cursor), part.to);
      fragment.append(mark);
      if (part.selected && !selectedNode) {
        selectedNode = mark;
      }
      cursor = Math.max(cursor, part.to);
    }
    if (cursor < text.length) {
      fragment.append(text.slice(cursor));
    }

    div.replaceChildren(fragment);
    page.highlightedDivs.push(item);
  }

  if (selectedNode && search.pendingScroll) {
    search.pendingScroll = false;
    revealNode(selectedNode);
  }
}

function revealNode(node) {
  const shell = elements.pdfShell;
  const shellRect = shell.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const comfortablyVisible = rect.top >= shellRect.top + 60 && rect.bottom <= shellRect.bottom - 60 &&
    rect.left >= shellRect.left && rect.right <= shellRect.right;

  if (!comfortablyVisible) {
    shell.scrollTo({
      top: shell.scrollTop + rect.top - shellRect.top - shellRect.height / 3,
      left: shell.scrollLeft + rect.left - shellRect.left - shellRect.width / 2,
      behavior: reducedMotion.matches ? "auto" : "smooth"
    });
  }
}

// ---------- Selection popover ----------

function getPdfSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!elements.pdfPages.contains(range.commonAncestorContainer)) {
    return null;
  }

  const text = selection.toString().trim();
  return text ? { range, text } : null;
}

function handleSelectionEnd() {
  const selection = getPdfSelection();
  if (!selection) {
    hidePopover();
    return;
  }

  if (markup.isTextTool()) {
    markup.addTextMarkup(markup.getTool(), selection.range);
    hidePopover();
    return;
  }

  showPopover(selection);
}

function showPopover({ range, text }) {
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  if (!rects.length) {
    return;
  }

  popoverSelection = { range: range.cloneRange(), text };
  lastSelectedText = text;
  const popover = elements.selectionPopover;
  const stage = elements.viewerStage.getBoundingClientRect();
  popover.hidden = false;

  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const first = rects[0];
  const last = rects.at(-1);
  let top = first.top - stage.top - height - 10;
  if (top < 8) {
    top = last.bottom - stage.top + 10;
  }

  popover.style.left = `${clamp(first.left - stage.left, 8, stage.width - width - 8)}px`;
  popover.style.top = `${clamp(top, 8, stage.height - height - 8)}px`;
}

function hidePopover() {
  elements.selectionPopover.hidden = true;
  popoverSelection = null;
}

// ---------- AI agent host ----------
// The assistant sees and edits the PDF only through these functions. Page coordinates use a
// 0–1000 grid over the page as displayed (x from the left edge, y from the top edge).

function agentPage(number) {
  if (!state.doc) {
    throw new Error("No PDF is open.");
  }
  const page = state.pages[Number(number) - 1];
  if (!page) {
    throw new Error(`Page ${number} doesn't exist; this PDF has ${state.pages.length} pages.`);
  }
  return page;
}

function toGridBox(page, { x, y, width, height }) {
  return {
    x: Math.round((x / page.width) * AGENT_GRID),
    y: Math.round((y / page.height) * AGENT_GRID),
    w: Math.round((width / page.width) * AGENT_GRID),
    h: Math.round((height / page.height) * AGENT_GRID)
  };
}

function fromGrid(page, x, y) {
  return {
    x: Math.round((clamp(Number(x) || 0, 0, AGENT_GRID) / AGENT_GRID) * page.width * 100) / 100,
    y: Math.round((clamp(Number(y) || 0, 0, AGENT_GRID) / AGENT_GRID) * page.height * 100) / 100
  };
}

function unionBox(rects) {
  const left = Math.min(...rects.map(rect => rect[0]));
  const top = Math.min(...rects.map(rect => rect[1]));
  const right = Math.max(...rects.map(rect => rect[0] + rect[2]));
  const bottom = Math.max(...rects.map(rect => rect[1] + rect[3]));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// A faint labelled grid on page images lets vision models read positions directly.
function drawCoordinateGrid(context, width, height) {
  context.save();
  context.lineWidth = 1;
  context.font = "600 12px Helvetica, Arial, sans-serif";

  for (let value = 100; value < AGENT_GRID; value += 100) {
    const x = Math.round((value / AGENT_GRID) * width) + 0.5;
    const y = Math.round((value / AGENT_GRID) * height) + 0.5;
    context.strokeStyle = "rgba(0, 110, 255, 0.14)";
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();

    context.fillStyle = "rgba(0, 90, 220, 0.75)";
    context.textBaseline = "top";
    context.fillText(String(value), x + 3, 3);
    context.textBaseline = "middle";
    context.fillText(String(value), 3, y);
  }

  context.restore();
}

async function agentRenderPageImage(number) {
  const page = agentPage(number);
  page.pdfPage ||= await state.doc.getPage(page.number);

  const scale = AGENT_IMAGE_LONG_SIDE / Math.max(page.width, page.height);
  const viewport = page.pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });

  await page.pdfPage.render({
    canvas,
    canvasContext: context,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE
  }).promise;
  markup.drawOnCanvas(context, page.number, scale);
  drawCoordinateGrid(context, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  canvas.width = 0;
  return dataUrl;
}

async function getTextGeometry(number) {
  const page = agentPage(number);
  const data = await getPageText(page.number);

  if (!data.boxes) {
    page.pdfPage ||= await state.doc.getPage(page.number);
    const viewport = page.pdfPage.getViewport({ scale: 1 });
    data.boxes = data.items.map(item => {
      const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(matrix[2], matrix[3]) || item.height || 1;
      return { x: matrix[4], y: matrix[5] - fontHeight * 0.82, width: item.width, height: fontHeight };
    });
  }

  return { page, data };
}

async function matchPageText(number, query) {
  const needle = String(query ?? "").trim();
  if (!needle) {
    throw new Error("The text to find is empty.");
  }

  const { page, data } = await getTextGeometry(number);
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "gi");
  const matches = [];

  for (const match of data.text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const rects = [];

    for (let item = findItemIndex(data.starts, start); item < data.starts.length && data.starts[item] < end; item += 1) {
      const length = data.strings[item].length;
      const from = Math.max(start, data.starts[item]) - data.starts[item];
      const to = Math.min(end, data.starts[item] + length) - data.starts[item];
      if (!length || to <= from) {
        continue;
      }
      const box = data.boxes[item];
      rects.push([box.x + (box.width * from) / length, box.y, (box.width * (to - from)) / length, box.height]);
    }

    if (rects.length) {
      matches.push({ text: match[0], rects });
    }
    if (matches.length >= 40) {
      break;
    }
  }

  return { page, data, matches };
}

async function agentFindText(number, query) {
  const { page, data, matches } = await matchPageText(number, query);
  return {
    page: page.number,
    hasTextLayer: data.strings.some(text => text.trim()),
    matches: matches.map(match => ({ text: match.text, box: toGridBox(page, unionBox(match.rects)) }))
  };
}

function formFieldType(annotation) {
  if (annotation.subtype !== "Widget" || !annotation.fieldName || annotation.readOnly || annotation.hidden) {
    return null;
  }
  if (annotation.fieldType === "Tx") {
    return "text";
  }
  if (annotation.fieldType === "Btn") {
    return annotation.checkBox ? "checkbox" : annotation.radioButton ? "radio" : null;
  }
  return annotation.fieldType === "Ch" ? "choice" : null;
}

async function agentListFormFields(pageNumbers) {
  const pages = pageNumbers?.length ? pageNumbers.map(agentPage) : state.pages;
  const storage = state.doc.annotationStorage;
  const fields = [];

  for (const page of pages) {
    page.pdfPage ||= await state.doc.getPage(page.number);
    for (const annotation of await pageAnnotations(page)) {
      const type = formFieldType(annotation);
      if (!type) {
        continue;
      }
      fieldIndex.set(annotation.id, { annotation, page: page.number });

      const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(annotation.rect);
      const [ax, ay] = page.viewport.convertToViewportPoint(x1, y1);
      const [bx, by] = page.viewport.convertToViewportPoint(x2, y2);
      const stored = storage.getRawValue(annotation.id)?.value;
      const field = {
        id: annotation.id,
        label: annotation.alternativeText || annotation.fieldName,
        type,
        page: page.number,
        box: toGridBox(page, { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) })
      };

      if (type === "text") {
        field.value = stored ?? annotation.fieldValue ?? "";
        if (annotation.multiLine) {
          field.multiline = true;
        }
        if (annotation.maxLen) {
          field.maxLength = annotation.maxLen;
        }
      } else if (type === "checkbox") {
        field.checked = stored ?? (Boolean(annotation.fieldValue) && annotation.fieldValue !== "Off");
      } else if (type === "radio") {
        field.group = annotation.fieldName;
        field.option = annotation.buttonValue;
        field.checked = stored ?? annotation.fieldValue === annotation.buttonValue;
      } else {
        field.options = (annotation.options || []).map(option => option.displayValue ?? option.exportValue);
        field.value = stored ?? annotation.fieldValue;
      }

      fields.push(field);
    }
  }

  return fields;
}

function storeFieldValue(id, value, undoLog) {
  const storage = state.doc.annotationStorage;
  if (undoLog && !undoLog.has(id)) {
    undoLog.set(id, storage.getRawValue(id)?.value);
  }
  if (value === undefined) {
    storage.remove(id);
    formEdits.delete(id);
  } else {
    storage.setValue(id, { value });
    formEdits.set(id, value);
  }
}

// Form values live in PDF.js's annotation storage: pages re-render with them and Download writes them into the file.
function afterFormChange(pageNumbers) {
  contentRevision += 1;
  const token = state.loadToken;
  for (const number of pageNumbers) {
    const page = state.pages[number - 1];
    if (page) {
      rebuildFormLayer(page);
      page.renderedScale = 0;
      thumbnailQueue = thumbnailQueue.then(() => renderThumbnail(page, token)).catch(() => {});
    }
  }
  scheduleRender();
  persistFormEdits({ immediate: true });
}

async function agentFillFormFields(entries) {
  if (!fieldIndex.size) {
    await agentListFormFields();
  }

  const undoLog = new Map();
  const pages = new Set();
  const filled = [];
  const errors = [];
  const isOn = value => value === true || /^(true|yes|on|checked|1|x|✓)$/i.test(String(value).trim());

  for (const { id, value } of entries) {
    const entry = fieldIndex.get(String(id));
    if (!entry) {
      errors.push(`No form field with id "${id}"`);
      continue;
    }

    const { annotation } = entry;
    const type = formFieldType(annotation);
    if (type === "text") {
      const text = String(value ?? "");
      storeFieldValue(annotation.id, annotation.maxLen ? text.slice(0, annotation.maxLen) : text, undoLog);
    } else if (type === "checkbox") {
      storeFieldValue(annotation.id, isOn(value), undoLog);
    } else if (type === "radio") {
      for (const [otherId, other] of fieldIndex) {
        if (other.annotation.radioButton && other.annotation.fieldName === annotation.fieldName) {
          storeFieldValue(otherId, isOn(value) && otherId === annotation.id, undoLog);
          pages.add(other.page);
        }
      }
    } else {
      const wanted = String(value ?? "").trim().toLowerCase();
      const option = (annotation.options || []).find(item =>
        String(item.displayValue ?? "").toLowerCase() === wanted || String(item.exportValue ?? "").toLowerCase() === wanted);
      if (!option) {
        errors.push(`"${value}" isn't an option for ${annotation.fieldName}`);
        continue;
      }
      storeFieldValue(annotation.id, [option.exportValue], undoLog);
    }

    pages.add(entry.page);
    filled.push({ id: annotation.id, label: annotation.alternativeText || annotation.fieldName, value });
  }

  if (filled.length) {
    afterFormChange(pages);
  }

  return {
    filled,
    errors,
    undo: () => {
      for (const [id, previous] of undoLog) {
        storeFieldValue(id, previous);
      }
      afterFormChange(pages);
    }
  };
}

function agentAddText({ page: number, x, y, text, fontSize, color, width, background, layer }) {
  const page = agentPage(number);
  const content = String(text ?? "").replace(/\\n/g, "\n").trim();
  if (!content) {
    throw new Error("The text is empty.");
  }

  const point = fromGrid(page, x, y);
  const annotation = {
    type: "text",
    page: page.number,
    x: point.x,
    y: point.y,
    fontSize: clamp(Number(fontSize) || 11, 6, 48),
    color: color || markup.defaultColor("text"),
    text: content
  };
  if (Number(width) > 0) {
    annotation.width = Math.max(10, Math.min(page.width - point.x, (clamp(Number(width), 1, AGENT_GRID) / AGENT_GRID) * page.width));
  }
  if (background) {
    annotation.background = background;
  }
  if (layer) {
    annotation.layer = layer;
  }
  return markup.addAnnotations([annotation])[0];
}

// A whole overlay layer at once (translations): each item is a box on the grid that the text is fitted into.
function agentAddTextLayer({ page: number, layer, items, background }) {
  const page = agentPage(number);
  const annotations = [];

  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.text ?? "").replace(/\\n/g, "\n").trim();
    if (!text) {
      continue;
    }
    const topLeft = fromGrid(page, item.x, item.y);
    const bottomRight = fromGrid(page, Number(item.x) + Number(item.w), Number(item.y) + Number(item.h));
    const width = Math.max(10, bottomRight.x - topLeft.x);
    const height = Math.max(6, bottomRight.y - topLeft.y);
    annotations.push({
      type: "text",
      page: page.number,
      x: topLeft.x,
      y: topLeft.y,
      width,
      height,
      text,
      fontSize: markup.fitFontSize({ text, width, height, fontSize: Number(item.font_size) || 0 }),
      color: "#1f1f1f",
      background: background === "none" ? undefined : "#ffffff",
      layer: layer || "translation"
    });
  }

  if (!annotations.length) {
    throw new Error("Pass at least one item with text and a box.");
  }
  return markup.addAnnotations(annotations);
}

async function agentHighlightText({ page: number, text, style, occurrence, color }) {
  const { page, matches } = await matchPageText(number, text);
  if (!matches.length) {
    throw new Error(`"${text}" isn't in page ${number}'s text layer. Use a shorter, exact phrase from the page.`);
  }

  const type = ["highlight", "underline", "strike"].includes(style) ? style : "highlight";
  const chosen = occurrence ? [matches[clamp(Math.round(occurrence), 1, matches.length) - 1]] : matches;
  const ids = markup.addAnnotations(chosen.map(match => ({
    type,
    page: page.number,
    rects: match.rects,
    text: match.text.replace(/\s+/g, " ").slice(0, 280),
    color: color || markup.defaultColor(type)
  })));

  return { ids, count: chosen.length, total: matches.length };
}

function agentDrawShape({ page: number, shape, x1, y1, x2, y2, width, color }) {
  const page = agentPage(number);
  const start = fromGrid(page, x1, y1);
  const end = fromGrid(page, x2, y2);
  const base = { page: page.number, color: color || markup.defaultColor("pen"), width: clamp(Number(width) || 2, 0.5, 8) };

  if (shape === "check" || shape === "cross") {
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x) || 10;
    const h = Math.abs(end.y - start.y) || 10;
    const paths = shape === "check"
      ? [[left + w * 0.15, top + h * 0.55, left + w * 0.42, top + h * 0.82, left + w * 0.88, top + h * 0.18]]
      : [[left + w * 0.18, top + h * 0.18, left + w * 0.82, top + h * 0.82], [left + w * 0.82, top + h * 0.18, left + w * 0.18, top + h * 0.82]];
    return markup.addAnnotations([{ ...base, type: "ink", paths: paths.map(path => path.map(value => Math.round(value * 100) / 100)) }])[0];
  }

  const type = { rectangle: "rect", oval: "ellipse", line: "line", arrow: "arrow" }[shape];
  if (!type) {
    throw new Error(`Unknown shape "${shape}".`);
  }
  return markup.addAnnotations([{ ...base, type, x1: start.x, y1: start.y, x2: end.x, y2: end.y }])[0];
}

function agentListMarkup(number) {
  const pageNumber = number ? agentPage(number).number : 0;
  return markup.listAnnotations(pageNumber).map(item => ({
    id: item.id,
    type: item.type,
    page: item.page,
    text: item.text,
    layer: item.layer,
    status: item.status,
    box: toGridBox(state.pages[item.page - 1], item.bounds)
  }));
}

// ---------- Regions, layout, search, outline ----------

function gridToUnits(page, { x1, y1, x2, y2 }) {
  const a = fromGrid(page, x1, y1);
  const b = fromGrid(page, x2, y2);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

// Renders one rectangle of a page (page units) with markup on top; optional coordinate grid for the assistant.
async function renderRegionUnits(page, box, { grid = false, longSide = REGION_IMAGE_LONG_SIDE, pad = 0 } = {}) {
  if (!page) {
    throw new Error("No PDF is open.");
  }
  page.pdfPage ||= await state.doc.getPage(page.number);

  const x = clamp(box.x - pad, 0, page.width);
  const y = clamp(box.y - pad, 0, page.height);
  const width = clamp(box.width + pad * 2, 8, page.width - x);
  const height = clamp(box.height + pad * 2, 8, page.height - y);
  const scale = clamp(longSide / Math.max(width, height), 1, 6);

  const viewport = page.pdfPage.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { alpha: false });

  await page.pdfPage.render({
    canvas,
    canvasContext: context,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE
  }).promise;

  context.save();
  context.translate(-x * scale, -y * scale);
  markup.drawOnCanvas(context, page.number, scale);
  context.restore();

  if (grid) {
    context.save();
    context.lineWidth = 1;
    context.font = "600 12px Helvetica, Arial, sans-serif";
    for (let value = 100; value < AGENT_GRID; value += 100) {
      const gx = ((value / AGENT_GRID) * page.width - x) * scale;
      const gy = ((value / AGENT_GRID) * page.height - y) * scale;
      context.strokeStyle = "rgba(0, 110, 255, 0.14)";
      context.fillStyle = "rgba(0, 90, 220, 0.75)";
      if (gx > 0 && gx < canvas.width) {
        context.beginPath();
        context.moveTo(Math.round(gx) + 0.5, 0);
        context.lineTo(Math.round(gx) + 0.5, canvas.height);
        context.stroke();
        context.textBaseline = "top";
        context.fillText(String(value), gx + 3, 3);
      }
      if (gy > 0 && gy < canvas.height) {
        context.beginPath();
        context.moveTo(0, Math.round(gy) + 0.5);
        context.lineTo(canvas.width, Math.round(gy) + 0.5);
        context.stroke();
        context.textBaseline = "middle";
        context.fillText(String(value), 3, gy);
      }
    }
    context.restore();
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  canvas.width = 0;
  return { dataUrl, box: { x, y, width, height } };
}

async function agentRenderRegionImage(number, gridBox) {
  const page = agentPage(number);
  const { dataUrl } = await renderRegionUnits(page, gridToUnits(page, gridBox), { grid: true });
  return dataUrl;
}

// Groups the text layer into lines and paragraph-like blocks (page units).
async function pageLayoutBlocks(number) {
  const { page, data } = await getTextGeometry(number);
  if (data.layout) {
    return { page, blocks: data.layout };
  }
  const items = data.strings
    .map((text, index) => ({ text, box: data.boxes[index] }))
    .filter(item => item.text.trim() && item.box.width > 0 && item.box.height > 0)
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  const lines = [];
  for (const item of items) {
    const line = lines.find(candidate => {
      const overlap = Math.min(candidate.y + candidate.height, item.box.y + item.box.height) - Math.max(candidate.y, item.box.y);
      return overlap > Math.min(candidate.height, item.box.height) * 0.5;
    });
    if (line) {
      line.items.push(item);
      line.x = Math.min(line.x, item.box.x);
      line.right = Math.max(line.right, item.box.x + item.box.width);
      line.y = Math.min(line.y, item.box.y);
      line.height = Math.max(line.height, item.box.height);
    } else {
      lines.push({ items: [item], x: item.box.x, right: item.box.x + item.box.width, y: item.box.y, height: item.box.height });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.box.x - b.box.x);
    line.text = line.items.map(item => item.text).join(" ").replace(/\s+/g, " ").trim();
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);

  const blocks = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    const lastLine = last?.lines.at(-1);
    const gap = lastLine ? line.y - (lastLine.y + lastLine.height) : Infinity;
    const overlapX = lastLine ? Math.min(last.right, line.right) - Math.max(last.x, line.x) : 0;
    // Headings have a clearly different size from body text; keep them as their own block.
    const similar = lastLine && Math.abs(lastLine.height - line.height) < Math.max(lastLine.height, line.height) * 0.2;
    if (last && gap < line.height * 0.9 && gap > -line.height * 0.5 && overlapX > 0 && similar) {
      last.lines.push(line);
      last.x = Math.min(last.x, line.x);
      last.right = Math.max(last.right, line.right);
      last.bottom = Math.max(last.bottom, line.y + line.height);
    } else {
      blocks.push({ lines: [line], x: line.x, right: line.right, y: line.y, bottom: line.y + line.height });
    }
  }

  data.layout = blocks.map(block => ({
    text: block.lines.map(line => line.text).join(" "),
    box: { x: block.x, y: block.y, width: block.right - block.x, height: block.bottom - block.y },
    lineCount: block.lines.length,
    fontSize: Math.round(block.lines.reduce((sum, line) => sum + line.height, 0) / block.lines.length * 10) / 10
  }));
  return { page, blocks: data.layout };
}

async function agentGetPageLayout(number) {
  const { page, blocks } = await pageLayoutBlocks(number);
  return blocks.slice(0, 120).map((block, index) => ({
    id: index + 1,
    text: block.text.length > 400 ? `${block.text.slice(0, 399)}…` : block.text,
    box: toGridBox(page, block.box),
    lines: block.lineCount,
    font_size: block.fontSize
  }));
}

async function agentSearchDocument(query, limit = 30) {
  const needle = String(query ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) {
    throw new Error("The search text is empty.");
  }
  const results = [];
  for (const page of state.pages) {
    let data;
    try {
      data = await getPageText(page.number);
    } catch {
      continue;
    }
    let index = data.lower.indexOf(needle);
    while (index !== -1 && results.length < limit) {
      const start = Math.max(0, index - 80);
      const end = Math.min(data.text.length, index + needle.length + 80);
      results.push({ page: page.number, snippet: `${start ? "…" : ""}${data.text.slice(start, end).replace(/\s+/g, " ")}${end < data.text.length ? "…" : ""}` });
      index = data.lower.indexOf(needle, index + needle.length);
    }
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

async function agentGetOutline() {
  if (!state.doc) {
    throw new Error("No PDF is open.");
  }
  let outline = null;
  try {
    outline = await state.doc.getOutline();
  } catch {
    outline = null;
  }
  const entries = [];
  const walk = async (nodes, depth) => {
    for (const node of nodes) {
      if (entries.length >= 300) {
        return;
      }
      let page = null;
      try {
        const dest = typeof node.dest === "string" ? await state.doc.getDestination(node.dest) : node.dest;
        if (Array.isArray(dest)) {
          page = (Number.isInteger(dest[0]) ? dest[0] : await state.doc.getPageIndex(dest[0])) + 1;
        }
      } catch {
        page = null;
      }
      entries.push({ title: node.title || "Untitled", page, depth });
      if (node.items?.length && depth < 6) {
        await walk(node.items, depth + 1);
      }
    }
  };
  await walk(outline || [], 0);
  if (!entries.length && state.aiOutline) {
    return state.aiOutline.map(entry => ({ ...entry, source: "ai" }));
  }
  return entries;
}

// ---------- Reveal, redactions, layers ----------

function flashBox(page, box) {
  if (!page) {
    return;
  }
  const flash = document.createElement("div");
  flash.className = "region-flash";
  flash.style.left = `${(box.x / page.width) * 100}%`;
  flash.style.top = `${(box.y / page.height) * 100}%`;
  flash.style.width = `${(box.width / page.width) * 100}%`;
  flash.style.height = `${(box.height / page.height) * 100}%`;
  page.shell.append(flash);
  window.setTimeout(() => flash.remove(), 1800);
}

function agentRevealBox(number, gridBox) {
  const page = agentPage(number);
  const box = gridBox ? gridToUnits(page, gridBox) : null;
  scrollToPage(page.number, box ? Math.max(0, box.y - 60) : 0);
  if (box) {
    window.setTimeout(() => flashBox(page, box), 350);
  }
}

function agentProposeRedactions({ page: number, boxes }) {
  const page = agentPage(number);
  const annotations = [];
  for (const item of Array.isArray(boxes) ? boxes : []) {
    const box = gridToUnits(page, item);
    if (box.width < 2 || box.height < 2) {
      continue;
    }
    annotations.push({
      type: "redact",
      status: "pending",
      page: page.number,
      color: "#000000",
      width: 0,
      x1: box.x,
      y1: box.y,
      x2: box.x + box.width,
      y2: box.y + box.height,
      reason: String(item.reason || "").slice(0, 120),
      text: String(item.reason || "")
    });
  }
  if (!annotations.length) {
    throw new Error("Pass at least one box to redact.");
  }
  return markup.addAnnotations(annotations);
}

function agentResolveRedactions(ids, approve) {
  if (approve) {
    return markup.updateAnnotations(ids, { status: "approved", text: "" });
  }
  return markup.removeAnnotations(ids);
}

function syncLayerPill() {
  const pill = elements.layerPill;
  const layers = state.doc ? markup.getLayers() : [];
  if (!layers.length) {
    pill.hidden = true;
    pill.replaceChildren();
    return;
  }
  pill.hidden = false;
  pill.replaceChildren(...layers.map(layer => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = layer.visible ? "is-on" : "";
    button.setAttribute("aria-pressed", String(layer.visible));
    button.title = t(layer.visible ? "Hide the {layer} layer" : "Show the {layer} layer", { layer: layer.label.toLowerCase() });
    const dot = document.createElement("span");
    dot.className = "pill-dot";
    button.append(dot, layer.label);
    button.addEventListener("click", () => markup.setLayerVisible(layer.name, !layer.visible));
    return button;
  }));
}

// Pages with approved redactions are flattened to images so the text underneath is really removed.
async function flattenToImagePdf() {
  const pages = [];
  for (const page of state.pages) {
    page.pdfPage ||= await state.doc.getPage(page.number);
    const viewport = page.pdfPage.getViewport({ scale: FLATTEN_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    await page.pdfPage.render({ canvas, canvasContext: context, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    markup.drawOnCanvas(context, page.number, FLATTEN_SCALE, { forExport: true });
    pages.push({
      jpeg: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.9)),
      width: page.width,
      height: page.height,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height
    });
    canvas.width = 0;
  }
  return buildImagePdf(pages, { title: state.fileName.replace(/\.pdf$/i, "") });
}

// ---------- Download & files ----------

async function downloadPdf() {
  if (!state.doc || !state.originalBytes) {
    return;
  }

  elements.downloadPdf.disabled = true;
  try {
    let bytes = state.originalBytes;
    if (markup.countRedactions("approved") > 0) {
      try {
        bytes = await flattenToImagePdf();
        toast(t("Downloaded as an image-only PDF so the redacted text is really removed."));
      } catch (error) {
        console.error(error);
        toast(t("Couldn't apply the redactions — download cancelled."));
        return;
      }
    } else if (markup.count() > 0 || formEdits.size > 0) {
      try {
        bytes = await markup.exportPdf(state.doc);
      } catch (error) {
        console.error(error);
        toast(t("Couldn't save your changes into the PDF — downloaded the original file."));
      }
    }

    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = state.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } finally {
    elements.downloadPdf.disabled = !state.doc;
  }
}

function isPdfFile(file) {
  return file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

// ---------- Sidebar ----------

function setSidebarCollapsed(collapsed, persist = true) {
  elements.appShell.classList.toggle("sidebar-collapsed", collapsed);
  elements.sidebar.inert = collapsed;
  if (persist && !narrowScreen.matches) {
    setItem("sidebarCollapsed", collapsed);
  }
}

function showSidebarPanel(name) {
  for (const tab of elements.sidebarTabs.querySelectorAll("[data-panel]")) {
    const active = tab.dataset.panel === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const body of elements.sidebarBody.querySelectorAll("[data-panel-body]")) {
    body.hidden = body.dataset.panelBody !== name;
  }
}

// ---------- Panel resizing ----------

const SIDEBAR_WIDTH_DEFAULT = 224;
// Matches --ai-split-width, so opening the workspace doesn't resize the assistant.
const AI_WIDTH_DEFAULT = 440;
const AI_SPLIT_DEFAULT = 440;
const AI_TOP_DEFAULT = 8;
const SIDEBAR_WIDTH_BOUNDS = { min: () => 180, max: () => Math.min(480, window.innerWidth * 0.5) };
const AI_WIDTH_BOUNDS = { min: () => 300, max: () => Math.min(720, window.innerWidth * 0.6) };
const AI_TOP_BOUNDS = { min: () => 8, max: () => Math.max(8, window.innerHeight - 8 - 240) };
// With the workspace open, the assistant and the workspace share the window; neither gets too narrow.
const AI_SPLIT_BOUNDS = { min: () => 300, max: () => Math.max(300, window.innerWidth - 24 - 360) };
const halfSplit = () => Math.round((window.innerWidth - 24) / 2);
// How close a drag has to land to the default size before it locks onto it.
const SNAP_ZONE = 10;

function clampToBounds(value, bounds) {
  return Math.min(bounds.max(), Math.max(bounds.min(), value));
}

function cssVarPx(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

function setCssVarPx(name, px) {
  document.documentElement.style.setProperty(name, `${Math.round(px)}px`);
}

// A single edge strip drives one CSS custom property, clamped to `bounds`, persisted on release.
// Tracking the drag on `document` (rather than pointer capture on the handle) keeps it working
// even if the pointer briefly leaves the thin strip while dragging fast. Landing within
// SNAP_ZONE of `snapTo` locks the value there and flashes the handle, standing in for a
// haptic "click" so the reader can feel their way back to the default size.
function initResizeHandle(handle, { axis, bounds, cssVar, storageKey, invert = false, snapTo }) {
  let startClient = 0;
  let startValue = 0;
  let snapped = false;

  const onMove = event => {
    const client = axis === "x" ? event.clientX : event.clientY;
    const delta = (client - startClient) * (invert ? -1 : 1);
    let next = clampToBounds(startValue + delta, bounds);

    // Every handle sticks the same way: land within SNAP_ZONE of one of its presets and the drag
    // locks onto it. The stickiness is the whole feedback — nothing lights up.
    const targets = typeof snapTo === "function" ? snapTo() : snapTo;
    const nearest = (Array.isArray(targets) ? targets : [targets])
      .filter(value => value != null)
      .find(value => Math.abs(next - value) <= SNAP_ZONE);
    if (nearest != null) {
      next = nearest;
    }
    if (nearest != null && !snapped) {
      navigator.vibrate?.(8);
    }
    snapped = nearest != null;

    setCssVarPx(cssVar, next);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    handle.classList.remove("is-active");
    elements.appShell.classList.remove("no-transition");
    setItem(storageKey, cssVarPx(cssVar));
  };

  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    startClient = axis === "x" ? event.clientX : event.clientY;
    startValue = cssVarPx(cssVar);
    snapped = false;
    handle.classList.add("is-active");
    elements.appShell.classList.add("no-transition");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

initResizeHandle(elements.sidebarResizer, {
  axis: "x",
  bounds: SIDEBAR_WIDTH_BOUNDS,
  cssVar: "--sidebar-width",
  storageKey: "sidebarWidth",
  snapTo: SIDEBAR_WIDTH_DEFAULT
});

initResizeHandle(elements.aiResizerX, {
  axis: "x",
  invert: true,
  bounds: AI_WIDTH_BOUNDS,
  cssVar: "--ai-width",
  storageKey: "aiWidth",
  snapTo: AI_WIDTH_DEFAULT
});

initResizeHandle(elements.aiResizerY, {
  axis: "y",
  bounds: AI_TOP_BOUNDS,
  cssVar: "--ai-top",
  storageKey: "aiTop",
  snapTo: AI_TOP_DEFAULT
});

// The bar between the workspace and the assistant sticks at the assistant's default width and at an
// even split; a double-click sets the even split outright.
initResizeHandle(elements.workspaceSplitter, {
  axis: "x",
  invert: true,
  bounds: AI_SPLIT_BOUNDS,
  cssVar: "--ai-split-width",
  storageKey: "aiSplitWidth",
  snapTo: () => [AI_SPLIT_DEFAULT, halfSplit()]
});
elements.workspaceSplitter.addEventListener("dblclick", () => {
  setCssVarPx("--ai-split-width", clampToBounds(halfSplit(), AI_SPLIT_BOUNDS));
  setItem("aiSplitWidth", cssVarPx("--ai-split-width"));
});

// ---------- Events ----------

elements.sidebarClose.addEventListener("click", () => setSidebarCollapsed(true));
elements.sidebarOpen.addEventListener("click", () => setSidebarCollapsed(false));

// On narrow screens the sidebar is a drawer: close it after navigating or when tapping outside it.
elements.sidebarBody.addEventListener("click", event => {
  if (narrowScreen.matches && event.target.closest(".thumbnail-item, .outline-item, .annotation-item")) {
    setSidebarCollapsed(true);
  }
});
document.addEventListener("pointerdown", event => {
  const drawerOpen = narrowScreen.matches && !elements.appShell.classList.contains("sidebar-collapsed");
  if (drawerOpen && !elements.sidebar.contains(event.target) && !elements.sidebarOpen.contains(event.target)) {
    setSidebarCollapsed(true);
  }
});
elements.outlineList.addEventListener("click", event => {
  if (event.target.closest("[data-outline-action=\"generate\"]")) {
    assistant.open();
    assistant.useCommand("outline", { sendNow: true });
  }
});
elements.sidebarTabs.addEventListener("click", event => {
  const panel = event.target.closest("[data-panel]")?.dataset.panel;
  if (panel) {
    showSidebarPanel(panel);
  }
});

elements.pdfShell.addEventListener("scroll", () => {
  hidePopover();
  if (!scrollFrame) {
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateCurrentPageFromScroll();
    });
  }
}, { passive: true });

elements.pdfShell.addEventListener("wheel", event => {
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }

  event.preventDefault();
  const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
  const factor = Math.exp(-clamp(pixels, -50, 50) * 0.0065);
  const base = zoomAnimation.frame ? zoomAnimation.target : state.zoom;
  setZoom(base * factor, { focalX: event.clientX, focalY: event.clientY });
}, { passive: false });

// Keep ctrl/pinch gestures elsewhere in the window from triggering browser page zoom.
window.addEventListener("wheel", event => {
  if ((event.ctrlKey || event.metaKey) && !elements.pdfShell.contains(event.target)) {
    event.preventDefault();
  }
}, { passive: false });

// Keeps a fitted zoom fitted when the reading area changes: the window resizing, and side panels
// opening or closing. Panels change the page's padding rather than the container's size, which a
// ResizeObserver doesn't reliably report, so class changes on the shell trigger a refit too.
function refitZoom() {
  repositionFlyouts();
  if (!state.pages.length || !state.zoomMode || zoomAnimation.frame) {
    return;
  }

  const next = computeFitZoom(state.zoomMode);
  if (Math.abs(next - state.zoom) < 0.001) {
    return;
  }

  const rect = elements.pdfShell.getBoundingClientRect();
  setZoom(next, { animate: false, mode: state.zoomMode, focalX: rect.left + rect.width / 2, focalY: rect.top + 1 });
}

new ResizeObserver(refitZoom).observe(elements.pdfShell);
new MutationObserver(() => requestAnimationFrame(refitZoom)).observe(elements.appShell, { attributes: true, attributeFilter: ["class"] });

elements.zoomIn.addEventListener("click", () => zoomStep(1));
elements.zoomOut.addEventListener("click", () => zoomStep(-1));
elements.zoomReset.addEventListener("click", () => {
  const opening = elements.zoomMenu.hidden;
  elements.zoomMenu.hidden = !opening;
  if (opening) {
    closeFlyouts(elements.zoomMenu);
    positionFlyout(elements.zoomMenu, elements.zoomReset);
  }
});
elements.toolDock.addEventListener("transitionend", repositionFlyouts);
elements.zoomMenu.addEventListener("click", event => {
  const value = event.target.closest("[data-zoom]")?.dataset.zoom;
  if (!value) {
    return;
  }

  elements.zoomMenu.hidden = true;
  if (value.startsWith("fit")) {
    setZoom(computeFitZoom(value), { mode: value });
  } else {
    setZoom(Number(value));
  }
});

elements.pageInput.addEventListener("focus", () => elements.pageInput.select());
elements.pageInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    const number = parseInt(elements.pageInput.value, 10);
    if (Number.isFinite(number)) {
      scrollToPage(number);
    }
    elements.pageInput.select();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
elements.pagePrev.addEventListener("click", () => scrollToPage(state.currentPage - 1));
elements.pageNext.addEventListener("click", () => scrollToPage(state.currentPage + 1));
elements.pageInput.addEventListener("blur", () => {
  elements.pageInput.value = state.pages.length ? String(state.currentPage) : "";
});

elements.searchToggle.addEventListener("click", () => {
  if (elements.searchBox.hidden) {
    openSearch();
  } else {
    closeSearch();
  }
});
elements.searchClose.addEventListener("click", closeSearch);
elements.searchInput.addEventListener("input", () => {
  clearTimeout(search.timer);
  search.timer = window.setTimeout(() => runSearch(elements.searchInput.value), 180);
});
elements.searchInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (normalizeQuery(elements.searchInput.value) !== search.query) {
      clearTimeout(search.timer);
      runSearch(elements.searchInput.value);
    } else {
      goToMatch(search.index + (event.shiftKey ? -1 : 1));
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
elements.searchBox.addEventListener("focusout", event => {
  if (event.relatedTarget === elements.searchToggle) {
    return;
  }
  window.setTimeout(() => {
    if (!elements.searchBox.hidden && !elements.searchBox.contains(document.activeElement) && !elements.searchInput.value) {
      closeSearch();
    }
  }, 150);
});
elements.searchPrev.addEventListener("click", () => goToMatch(search.index - 1));
elements.searchNext.addEventListener("click", () => goToMatch(search.index + 1));

elements.markupToggle.addEventListener("click", () => markup.setOpen(!markup.isOpen()));
elements.downloadPdf.addEventListener("click", downloadPdf);
elements.settingsToggle.addEventListener("click", () => assistant.openSettings());

for (const button of [elements.openFile, elements.emptyOpenFile]) {
  button.addEventListener("click", () => elements.fileInput.click());
}
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (isPdfFile(file)) {
    loadFromFile(file);
  }
  elements.fileInput.value = "";
});

elements.pdfPages.addEventListener("pointerdown", event => {
  pointerStartedInPages = true;
  hidePopover();
  event.target.closest?.(".textLayer")?.classList.add("selecting");
});

document.addEventListener("pointerup", () => {
  for (const layer of elements.pdfPages.querySelectorAll(".textLayer.selecting")) {
    layer.classList.remove("selecting");
  }
  if (pointerStartedInPages) {
    pointerStartedInPages = false;
    window.setTimeout(handleSelectionEnd, 0);
  }
});

document.addEventListener("pointerdown", event => {
  if (!elements.zoomMenu.hidden && !event.target.closest("#zoomMenu, #zoomReset")) {
    elements.zoomMenu.hidden = true;
  }
});

elements.selectionPopover.addEventListener("pointerdown", event => event.preventDefault());
elements.selectionPopover.addEventListener("click", async event => {
  const action = event.target.closest("button")?.dataset.action;
  if (!action || !popoverSelection) {
    return;
  }

  const { range, text } = popoverSelection;
  hidePopover();

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("Copied"));
    } catch {
      toast(t("Couldn't copy"));
    }
    window.getSelection()?.removeAllRanges();
  } else if (action === "ask") {
    window.getSelection()?.removeAllRanges();
    assistant.open({ quote: text });
  } else if (action === "explain" || action === "translate") {
    const region = selectionRegion(range);
    window.getSelection()?.removeAllRanges();
    if (region) {
      lens.explainBox(region.page, region.box, text, action);
    } else {
      assistant.open({ quote: text, draft: action === "translate" ? t("Translate this passage.") : t("Explain this passage.") });
    }
  } else {
    markup.addTextMarkup(action, range);
  }
});

// Page and box (page units) covered by a text selection, for the explain bubble.
function selectionRegion(range) {
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0.5 && rect.height > 0.5);
  if (!rects.length) {
    return null;
  }
  const first = rects[0];
  const page = findPageNear(first.top + first.height / 2);
  if (!page) {
    return null;
  }
  const shell = page.shell.getBoundingClientRect();
  const onPage = rects.filter(rect => rect.bottom > shell.top && rect.top < shell.bottom);
  const left = Math.min(...onPage.map(rect => rect.left));
  const top = Math.min(...onPage.map(rect => rect.top));
  const right = Math.max(...onPage.map(rect => rect.right));
  const bottom = Math.max(...onPage.map(rect => rect.bottom));
  const scaleX = page.width / shell.width;
  const scaleY = page.height / shell.height;
  return {
    page: page.number,
    box: {
      x: (left - shell.left) * scaleX,
      y: (top - shell.top) * scaleY,
      width: (right - left) * scaleX,
      height: (bottom - top) * scaleY
    }
  };
}

window.addEventListener("dragenter", event => {
  if (!hasDraggedFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth += 1;
  elements.dropOverlay.hidden = false;
});
window.addEventListener("dragover", event => {
  if (hasDraggedFiles(event)) {
    event.preventDefault();
  }
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    elements.dropOverlay.hidden = true;
  }
});
window.addEventListener("drop", event => {
  if (!hasDraggedFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.hidden = true;

  const file = [...event.dataTransfer.files].find(isPdfFile);
  if (file) {
    loadFromFile(file);
  } else {
    toast(t("That isn't a PDF file"));
  }
});

document.addEventListener("keydown", event => {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && key === "f") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (mod && (key === "=" || key === "+")) {
    event.preventDefault();
    zoomStep(1);
    return;
  }
  if (mod && key === "-") {
    event.preventDefault();
    zoomStep(-1);
    return;
  }
  if (mod && key === "0") {
    event.preventDefault();
    setZoom(1);
    return;
  }

  if (isTypingTarget(event.target) || event.defaultPrevented) {
    return;
  }

  if (markup.handleKeydown(event)) {
    return;
  }

  if (event.key === "Escape") {
    closeFlyouts();
    hidePopover();
    return;
  }

  const fitsHorizontally = elements.pdfShell.scrollWidth <= elements.pdfShell.clientWidth + 1;
  if (!mod && fitsHorizontally && state.pages.length && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    scrollToPage(state.currentPage + (event.key === "ArrowRight" ? 1 : -1));
  }
});

window.addEventListener("pagehide", () => {
  markup.flush();
  workspace.flush();
});

// ---------- Start ----------

elements.appShell.classList.add("no-transition");
getItem("theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light").then(applyTheme);
Promise.all([
  getItem("sidebarWidth", null),
  getItem("aiWidth", null),
  getItem("aiTop", null),
  getItem("aiSplitWidth", null)
]).then(([sidebarWidth, aiWidth, aiTop, aiSplitWidth]) => {
  if (aiSplitWidth != null) {
    setCssVarPx("--ai-split-width", clampToBounds(aiSplitWidth, AI_SPLIT_BOUNDS));
  }
  if (sidebarWidth != null) {
    setCssVarPx("--sidebar-width", clampToBounds(sidebarWidth, SIDEBAR_WIDTH_BOUNDS));
  }
  if (aiWidth != null) {
    setCssVarPx("--ai-width", clampToBounds(aiWidth, AI_WIDTH_BOUNDS));
  }
  if (aiTop != null) {
    setCssVarPx("--ai-top", clampToBounds(aiTop, AI_TOP_BOUNDS));
  }
});
setSidebarCollapsed(narrowScreen.matches, false);
getItem("sidebarCollapsed", false).then(collapsed => {
  if (!narrowScreen.matches) {
    setSidebarCollapsed(Boolean(collapsed), false);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => elements.appShell.classList.remove("no-transition")));
});

updateZoomLabel(1);
if (initialPdfUrl) {
  loadFromUrl(initialPdfUrl);
} else {
  showEmptyState(t("Open a PDF"), t("Browse to a PDF on the web and it opens here — or drop a file anywhere in this window."));
}
