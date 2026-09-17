// The workspace beside the assistant: a notebook and a personal profile. Notes, including the
// To-do page the assistant adds actions to, belong to the open document; the profile is shared by
// every document and never leaves this browser. The assistant writes into it with tools; the reader
// can edit everything by hand.

import { checklistSummary, expandTable, renderInline, SEVERITY_ICONS } from "./ai.js";
import { blocksToMarkdown, createBlock, escapeInline, markdownToBlocks } from "./blocks.js";
import { createBlockEditor, EDITOR_ICONS } from "./editor.js";
import { t, tn, uiLanguage } from "./i18n.js";
import { moveOutline, normalizeOutline, outlineChildren, outlineItem as findOutlineItem, outlineParent } from "./outline.js";
import { fillTokens } from "./privacy.js";
import { allFields, applyDetail, emptyProfile, fieldLabel, fieldTemplate, fieldType, findField, isBuiltInSection, loadProfile, MAX_PROFILE_FIELDS, MAX_PROFILE_SECTIONS, newField, newSection, privateEntries, profileAge, profileEntries, sectionTitle } from "./profile.js";
import { getItem, setItem } from "./store.js";
import { mergeTodos, readTodos } from "./todos.js";

const PROFILE_KEY = "profile";
const TABS = ["notes", "profile"];
const MAX_NOTES = 300;
const MAX_NOTE_LENGTH = 20_000;
const MAX_NOTE_TITLE = 50;
const HIGHLIGHTS = "highlights";

const KIND_LABELS = {
  note: "Note",
  flashcards: "Flashcards",
  quiz: "Quiz",
  glossary: "Glossary",
  summary: "Summary",
  "paper-card": "Paper card",
  plan: "Revision plan",
  figures: "Key figures",
  todos: "To-do list"
};

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

const ICONS = {
  ...EDITOR_ICONS,
  back: svg('<path d="m15 18-6-6 6-6"></path>'),
  book: svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path>'),
  sparkle: svg('<path d="M12 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z"></path><path d="M18.5 15.5c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5Z"></path>'),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path>'),
  page: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>'),
  note: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M9 13h6M9 17h4"></path>'),
  quiz: svg('<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"></path>'),
  glossary: svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path><path d="m9 13 2.5-6 2.5 6M9.8 11h3.4"></path>'),
  summary: svg('<path d="M4 6h16M4 10h16M4 14h10M4 18h7"></path>'),
  "paper-card": svg('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h5M7 13h10M7 16h7"></path>'),
  plan: svg('<rect x="3" y="4" width="18" height="17" rx="2"></rect><path d="M8 2v4M16 2v4M3 10h18"></path>'),
  figures: svg('<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"></path>'),
  highlighter: svg('<path d="m9 11-6 6v3h9l3-3"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle>'),
  eyeOff: svg('<path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"></path><path d="m2 2 20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>'),
  todos: svg('<path d="M9 6h11M9 12h11M9 18h11"></path><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"></path>'),
  user: svg('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>')
};

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatDay(time) {
  try {
    return new Date(time).toLocaleDateString(uiLanguage === "zh" ? "zh-CN" : undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function pageNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function shortTitle(value) {
  return Array.from(String(value ?? "").replace(/\n/g, " ")).slice(0, MAX_NOTE_TITLE).join("");
}

function safeColor(value) {
  return /^#[0-9a-f]{3,8}$/i.test(String(value ?? "")) ? value : "#fcc419";
}

// Notes saved before the block editor kept Markdown in `content`.
function normalizeNote(note) {
  if (!note || typeof note !== "object") {
    return null;
  }
  const blocks = (Array.isArray(note.blocks) ? note.blocks : markdownToBlocks(note.content || ""))
    .map(block => block?.type === "page" ? { id: block.id, type: "paragraph", text: `[p. ${pageNumber(block.page) || 1}]` } : block);
  const { content, ...rest } = note;
  return { ...rest, id: note.id || uid("note"), title: shortTitle(note.title), blocks, createdAt: note.createdAt || Date.now() };
}

export function createWorkspace({ host, toast, onToggle }) {
  const $ = selector => document.querySelector(selector);
  const el = {
    panel: $("#workspace"),
    head: $("#workspaceHead"),
    tabs: $("#workspaceTabs"),
    copyButton: $("#workspaceCopy"),
    deleteButton: $("#workspaceDelete"),
    body: $("#workspaceBody"),
    exportButton: $("#workspaceExport"),
    close: $("#workspaceClose"),
    toggle: $("#aiWorkspaceToggle")
  };

  let isShown = false;
  let tab = "notes";
  let docKey = "";
  let docName = "";
  let data = { notes: [], folders: [] };
  let profile = emptyProfile();
  let selectedNoteId = null;
  let navOpen = false;
  let navCollapsed = false;
  let addMenuOpen = false;
  let folderNameOpen = false;
  let draggedItemId = null;
  let dropProposal = null;
  let dropKey = "";
  let folderOpenTimer = 0;
  let autoScrollFrame = 0;
  const collapsedFolders = new Set();
  let editor = null;
  // A table or checklist opened from the chat, shown full-size in place of the tabs until the reader goes back.
  let view = null;
  let returnTab = "notes";
  let loadToken = 0;
  let saveTimer = 0;
  let pendingSave = null;
  let profileTimer = 0;

  el.panel.inert = true;
  const profileReady = getItem(PROFILE_KEY, null).then(saved => {
    profile = loadProfile(saved);
    if (saved && saved.version !== profile.version) {
      setItem(PROFILE_KEY, profile);
    }
  });

  // ---------- Storage ----------

  function save() {
    if (!docKey) {
      return;
    }
    pendingSave = { key: `workspace:${docKey}`, value: data };
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 300);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (pendingSave) {
      setItem(pendingSave.key, pendingSave.value);
      pendingSave = null;
    }
    clearTimeout(profileTimer);
    if (profileTimer) {
      profileTimer = 0;
      setItem(PROFILE_KEY, profile);
    }
  }

  function saveProfile() {
    clearTimeout(profileTimer);
    profileTimer = window.setTimeout(() => {
      profileTimer = 0;
      setItem(PROFILE_KEY, profile);
    }, 300);
  }

  async function setDocument(key, name = "") {
    flush();
    destroyEditor();
    docKey = key || "";
    docName = name || "";
    selectedNoteId = null;
    if (view) {
      view = null;
      tab = returnTab;
    }
    data = { notes: [], folders: [] };
    const token = ++loadToken;
    if (docKey) {
      const saved = await getItem(`workspace:${docKey}`, null);
      if (token !== loadToken) {
        return;
      }
      data = {
        notes: (Array.isArray(saved?.notes) ? saved.notes : []).map(normalizeNote).filter(Boolean),
        folders: (Array.isArray(saved?.folders) ? saved.folders : []).filter(folder => folder && typeof folder.id === "string" && typeof folder.name === "string")
      };
      initializeOutline();
      migrateTodos(saved?.todos);
    }
    syncHighlights();
    render();
  }

  function baseName() {
    return (docName || "document").replace(/\.pdf$/i, "");
  }

  // ---------- Opening ----------

  function setOpen(open, nextTab) {
    // "todos" means the notebook's To-do page: the add_todos step's Open button asks for it.
    if (nextTab === "todos") {
      nextTab = "notes";
      selectedNoteId = todoPage()?.id || selectedNoteId;
    }
    if (nextTab && TABS.includes(nextTab)) {
      tab = nextTab;
    }
    if (open !== isShown) {
      isShown = open;
      el.panel.inert = !open;
      el.toggle?.setAttribute("aria-pressed", String(open));
      onToggle?.(open);
    }
    if (open) {
      el.toggle?.classList.remove("has-update");
      render();
    } else {
      destroyEditor();
    }
  }

  // Refresh what's on screen; while the workspace is closed, mark its toggle instead.
  function notify(changedTab) {
    if (!isShown) {
      el.toggle?.classList.add("has-update");
    } else if (tab === changedTab) {
      render();
    }
  }

  // ---------- Rendering ----------

  function destroyEditor() {
    editor?.destroy();
    editor = null;
  }

  function isEditingNote() {
    const active = document.activeElement;
    return Boolean(active && el.body.querySelector(".nb-main")?.contains(active) && (active.isContentEditable || active.matches("input, textarea")));
  }

  function render() {
    for (const button of el.tabs.querySelectorAll("[data-workspace-tab]")) {
      const active = button.dataset.workspaceTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    el.exportButton.hidden = tab === "profile" || tab === "view" || !docKey;
    el.body.dataset.tab = tab;
    renderHeader();
    if (!isShown) {
      return;
    }
    if (tab === "notes" && editor && isEditingNote()) {
      // Never pull a page out from under the reader's cursor; the page list is safe to refresh.
      renderNoteNav();
      return;
    }
    destroyEditor();
    if (tab === "view" && view) {
      renderView();
    } else if (tab === "notes") {
      renderNotes();
    } else {
      renderProfile();
    }
  }

  // The notebook mark pressed into the panel, like the assistant's empty PDF mark.
  function notebookMark(id, extraClass = "") {
    return `<div class="ai-empty-mark nb-empty-mark${extraClass}" aria-hidden="true">
      <svg viewBox="0 0 880 1000">
        <mask id="${id}">
          <rect width="880" height="1000" style="fill:#fff"></rect>
          <rect x="188" y="0" width="34" height="1000" style="fill:#000"></rect>
          <rect x="330" y="250" width="400" height="74" rx="37" style="fill:#000"></rect>
          <rect x="330" y="400" width="280" height="74" rx="37" style="fill:#000"></rect>
        </mask>
        <rect mask="url(#${id})" x="40" y="20" width="800" height="960" rx="110"></rect>
      </svg>
    </div>`;
  }

  function emptyState(title, text, action = "") {
    return `<div class="ws-blank">
      ${notebookMark("wsBlankMarkCutout", " ws-blank-icon")}
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(text)}</p>
      ${action}
    </div>`;
  }

  function pageChip(page, extraClass = "") {
    return page
      ? `<button type="button" class="ws-chip${extraClass}" data-ws="page" data-page="${page}" title="${escapeHtml(t("Go to page {page}", { page }))}">${ICONS.page}<span>${escapeHtml(t("p. {page}", { page }))}</span></button>`
      : "";
  }

  function goToPdfPage(page) {
    const number = pageNumber(page);
    if (!number) return;
    setOpen(false);
    requestAnimationFrame(() => host.goToPage(number));
  }

  // ---------- Notebook ----------
  // Pages on the left, one page open on the right, edited in place like Notion.

  function sortedNotes() {
    return data.notes.filter(note => note.id !== HIGHLIGHTS).sort((a, b) => b.createdAt - a.createdAt);
  }

  function outlineItem(id) {
    return findOutlineItem(data, id);
  }

  function itemParent(item) {
    return outlineParent(item);
  }

  function orderedChildren(parentId = null) {
    return outlineChildren(data, parentId);
  }

  function initializeOutline() {
    normalizeOutline(data, HIGHLIGHTS);
  }

  function nextOrder(parentId = null) {
    return orderedChildren(parentId).length;
  }

  function moveOutlineItem(id, parentId, beforeId = null) {
    if (!moveOutline(data, id, parentId, beforeId)) return false;
    if (parentId) collapsedFolders.delete(parentId);
    save();
    renderNoteNav();
    return true;
  }

  function findNoteById(id) {
    return data.notes.find(note => note.id === id);
  }

  function highlights() {
    try {
      return host.listHighlights();
    } catch {
      return [];
    }
  }

  function ensureSelection() {
    if (selectedNoteId === HIGHLIGHTS || findNoteById(selectedNoteId)) {
      return;
    }
    selectedNoteId = sortedNotes()[0]?.id || null;
  }

  function renderNotes() {
    if (!docKey) {
      el.body.innerHTML = `
        <div class="nb-empty">
          ${notebookMark("nbEmptyMarkCutout")}
          <strong>${escapeHtml(t("No document open"))}</strong>
          <p>${escapeHtml(t("Open a PDF to keep notes next to it."))}</p>
        </div>`;
      return;
    }
    ensureSelection();
    el.body.innerHTML = `
      <div class="nb${navOpen ? " is-nav-open" : ""}${navCollapsed ? " is-nav-collapsed" : ""}">
        <div class="nb-side">
          <nav class="nb-nav" aria-label="${escapeHtml(t("Pages"))}"></nav>
        </div>
        <button type="button" class="nb-scrim" data-ws="toggle-nav" tabindex="-1" aria-label="${escapeHtml(t("Close"))}"></button>
        <div class="nb-main"></div>
        <button type="button" class="nb-nav-expand ws-icon-button" data-ws="collapse-nav" title="${escapeHtml(t("Pages"))}" aria-label="${escapeHtml(t("Pages"))}">${ICONS.sidebar}</button>
      </div>`;
    renderNoteNav();
    renderNotePage();
  }

  function renderNoteNav() {
    const nav = el.body.querySelector(".nb-nav");
    if (!nav) {
      return;
    }
    const marks = highlights();
    const outlineHtml = (parentId = null) => orderedChildren(parentId).map(item => {
      if (data.folders.includes(item)) {
        return `<li class="nb-entry nb-folder" data-outline-id="${escapeHtml(item.id)}"><div class="nb-folder-head"><button type="button" draggable="true" class="nb-nav-item nb-folder-button" data-ws="toggle-folder" data-folder-id="${escapeHtml(item.id)}" title="${escapeHtml(item.name)}" aria-expanded="${!collapsedFolders.has(item.id)}"><span class="nb-nav-icon">${ICONS.book}</span><span class="nb-nav-title">${escapeHtml(item.name)}</span></button></div>${collapsedFolders.has(item.id) ? "" : `<ul class="nb-nav-list nb-folder-pages">${outlineHtml(item.id)}</ul>`}</li>`;
      }
      const label = item.id === HIGHLIGHTS ? item.title || `${baseName()} Highlights` : item.title || t("Untitled");
      return `<li class="nb-entry nb-note" data-outline-id="${escapeHtml(item.id)}"><button type="button" draggable="true" class="nb-nav-item${item.id === selectedNoteId ? " is-active" : ""}" data-ws="select-note" data-note-id="${escapeHtml(item.id)}" title="${escapeHtml(label)}"><span class="nb-nav-icon">${item.id === HIGHLIGHTS ? ICONS.highlighter : ICONS[item.kind] || ICONS.note}</span><span class="nb-nav-title${item.title ? "" : " is-untitled"}">${escapeHtml(label)}</span>${item.id === HIGHLIGHTS && marks.length ? `<span class="nb-nav-count">${marks.length}</span>` : item.source === "ai" ? `<span class="nb-nav-badge">${ICONS.sparkle}</span>` : ""}</button></li>`;
    }).join("");
    nav.innerHTML = `
      <div class="nb-nav-head">
        <button type="button" class="ws-icon-button" data-ws="collapse-nav" title="${escapeHtml(t("Collapse sidebar"))}" aria-label="${escapeHtml(t("Collapse sidebar"))}">${ICONS.sidebar}</button>
        <button type="button" class="ws-icon-button" data-ws="toggle-add-menu" aria-expanded="${addMenuOpen}" title="${escapeHtml(t("Add"))}" aria-label="${escapeHtml(t("Add"))}">${ICONS.plus}</button>
      </div>
      ${addMenuOpen ? `<div class="nb-add-popover glass" role="dialog" aria-label="${escapeHtml(t("Add to Pages"))}">${folderNameOpen ? `<form data-ws-form="folder"><div class="nb-add-field"><span aria-hidden="true">${ICONS.book}</span><input id="nb-folder-name" class="flyout-input" name="folderName" maxlength="80" autocomplete="off" placeholder="${escapeHtml(t("Folder name"))}" aria-label="${escapeHtml(t("Folder name"))}" required></div><div class="nb-popover-actions"><button type="button" data-ws="cancel-add">${escapeHtml(t("Cancel"))}</button><button type="submit">${escapeHtml(t("Create"))}</button></div></form>` : `<button type="button" data-ws="new-note">${ICONS.note}<span>${escapeHtml(t("New page"))}</span></button><button type="button" data-ws="new-folder">${ICONS.book}<span>${escapeHtml(t("New folder"))}</span></button>`}</div>` : ""}
      <div class="nb-nav-scroll">
        ${data.notes.length || data.folders.length ? `<ul class="nb-nav-list nb-root-list" data-outline-root>${outlineHtml()}</ul>` : `<p class="nb-nav-empty" data-outline-root>${escapeHtml(t("No pages yet"))}</p>`}
      </div>`;
  }

  // The workspace has one bar, so the open page's actions live in it beside the tabs.
  function renderHeader() {
    const onNotes = tab === "notes" && Boolean(docKey);
    const note = onNotes && selectedNoteId !== HIGHLIGHTS ? findNoteById(selectedNoteId) : null;
    el.copyButton.hidden = !note;
    el.deleteButton.hidden = !note;
  }

  function renderNotePage() {
    const main = el.body.querySelector(".nb-main");
    if (!main) {
      return;
    }
    destroyEditor();
    // The page is picked by now, so the bar can show the actions that belong to it.
    renderHeader();
    if (selectedNoteId === HIGHLIGHTS) {
      syncHighlights();
      renderHighlightsPage(main);
      return;
    }
    const note = findNoteById(selectedNoteId);
    if (!note) {
      main.innerHTML = emptyState(
        t("No pages yet"),
        t("Notes, flashcards, quizzes and summaries the assistant saves appear here as pages. You can also start your own."),
        `<button type="button" class="ws-button" data-ws="new-note">${ICONS.plus}<span>${escapeHtml(t("New page"))}</span></button>`
      );
      return;
    }
    const meta = [
      `<span class="nb-meta-kind">${ICONS[note.kind] || ICONS.note}${escapeHtml(t(KIND_LABELS[note.kind] || "Note"))}</span>`,
      note.source === "ai" ? `<span class="nb-meta-ai">${ICONS.sparkle}${escapeHtml(t("Saved by the assistant"))}</span>` : "",
      `<span>${escapeHtml(formatDay(note.createdAt))}</span>`,
      pageChip(note.page)
    ].filter(Boolean).join('<span class="nb-meta-dot" aria-hidden="true"></span>');
    main.innerHTML = `
      <article class="nb-page">
        <h1 class="nb-page-title" contenteditable="plaintext-only" spellcheck="false" data-note-title data-placeholder="${escapeHtml(t("Untitled"))}">${escapeHtml(note.title)}</h1>
        <div class="nb-page-meta">${meta}</div>
        <div class="nb-editor"></div>
      </article>`;
    editor = createBlockEditor({
      root: main.querySelector(".nb-editor"),
      blocks: note.blocks,
      toast,
      onCite: goToPdfPage,
      getCurrentPage: () => host.getCurrentPage?.(),
      onExitTop: () => focusTitle(false),
      onChange: blocks => {
        note.blocks = blocks;
        note.updatedAt = Date.now();
        save();
      }
    });
  }

  function focusTitle(atStart = true) {
    const title = el.body.querySelector("[data-note-title]");
    if (!title) {
      return;
    }
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    range.collapse(atStart);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function renderHighlightsPage(main) {
    const marks = highlights();
    const note = data.notes.find(entry => entry.id === HIGHLIGHTS);
    const title = note?.title || `${baseName()} Highlights`;
    main.innerHTML = `
      <article class="nb-page">
        <h1 class="nb-page-title is-static">${escapeHtml(title)}</h1>
        <div class="nb-page-meta"><span>${escapeHtml(tn(marks.length, "{count} highlight", "{count} highlights"))}</span></div>
        <div class="nb-editor"></div>
      </article>`;
    editor = createBlockEditor({ root: main.querySelector(".nb-editor"), blocks: note.blocks, toast,
      onCite: goToPdfPage,
      getCurrentPage: () => host.getCurrentPage?.(),
      onChange: blocks => { note.blocks = blocks; note.updatedAt = Date.now(); save(); }
    });
  }

  function syncHighlights() {
    if (!docKey) return;
    const marks = highlights();
    let note = data.notes.find(entry => entry.id === HIGHLIGHTS);
    if (!note) {
      note = { id: HIGHLIGHTS, kind: "note", title: shortTitle(`${baseName()} Highlights`), blocks: [], source: "user", order: nextOrder(null), createdAt: Date.now() };
      data.notes.push(note);
    }
    // Each PDF mark is imported once, as a bullet. Afterwards its block is freely editable or removable.
    const known = new Set(note.importedHighlights || []);
    // Pages from before highlights were bulleted hold them as paragraphs; those become bullets once.
    let changed = false;
    if (!note.bulletedHighlights) {
      const imported = new Set([...known].map(key => {
        const split = key.indexOf(":");
        return `${key.slice(split + 1).replace(/\n+/g, " ")} [p. ${key.slice(0, split)}]`;
      }));
      for (const block of note.blocks) {
        if (block.type === "paragraph" && imported.has(block.text)) {
          block.type = "bullet";
          block.indent = 0;
        }
      }
      note.bulletedHighlights = true;
      changed = known.size > 0;
    }
    for (const mark of marks) {
      const key = `${mark.page}:${mark.text}`;
      if (known.has(key)) continue;
      note.blocks.push(createBlock("bullet", { text: `${escapeInline(mark.text.replace(/\s+/g, " ").trim())} [p. ${mark.page}]` }));
      known.add(key);
      changed = true;
    }
    note.importedHighlights = [...known];
    if (changed) save();
  }

  function selectNote(id) {
    if (id === HIGHLIGHTS) syncHighlights();
    selectedNoteId = id;
    navOpen = false;
    el.body.querySelector(".nb")?.classList.remove("is-nav-open");
    renderNoteNav();
    renderNotePage();
    renderHeader();
    el.body.querySelector(".nb-main")?.scrollTo(0, 0);
  }

  // ---------- Profile ----------
  // Groups of label/value rows. Group titles and field names can be edited, every group takes more
  // fields, and the eye on a row decides whether the detail is private: hidden here (shown only
  // while being edited) and never given to the assistant, which gets a token to fill forms with.

  function defaultLabel(field) {
    const template = fieldTemplate(field);
    return template ? t(template.label) : "";
  }

  function shownLabel(field) {
    return String(field.label ?? "").trim() || defaultLabel(field);
  }

  function shownTitle(section) {
    return String(section.title ?? "").trim() || (isBuiltInSection(section) ? t(sectionTitle(section)) : "");
  }

  function ageText(value) {
    const age = profileAge(value);
    return age === null ? "" : tn(age, "{count} year old", "{count} years old");
  }

  function profileRowHtml(field) {
    const type = fieldType(field);
    const value = String(field.value ?? "");
    const stacked = type === "multiline";
    const placeholder = type === "date" ? "YYYY-MM-DD" : type === "gender" ? t("Enter gender") : fieldTemplate(field)?.placeholder || t("Value");
    const shown = type === "gender" ? ({ male: t("Male"), female: t("Female"), other: t("Other") }[value] || value) : value;
    const valueClass = `pf-value${field.private ? " is-private" : ""}`;
    const control = stacked
      ? `<textarea rows="2" class="${valueClass}" data-field-value placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(shownLabel(field) || t("Value"))}" autocomplete="off" spellcheck="false">${escapeHtml(shown)}</textarea>`
      : `<input type="text" class="${valueClass}" data-field-value value="${escapeHtml(shown)}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(shownLabel(field) || t("Value"))}" autocomplete="off" spellcheck="false">`;
    const hint = field.key === "birthDate" ? `<span class="pf-hint" data-age>${escapeHtml(field.private ? "" : ageText(value))}</span>` : "";
    const eyeLabel = field.private ? t("Private: hidden here and from the assistant") : t("Visible to the assistant");
    return `
      <div class="settings-row pf-row${stacked ? " is-stacked" : ""}" data-field="${escapeHtml(field.id)}">
        <input type="text" class="pf-label" data-field-label value="${escapeHtml(shownLabel(field))}" placeholder="${escapeHtml(t("Field name"))}" aria-label="${escapeHtml(t("Field name"))}" autocomplete="off" spellcheck="false">
        <span class="settings-field">
          ${control}${hint}
          <button type="button" class="field-button pf-eye" data-ws="profile-private" aria-pressed="${field.private}" title="${escapeHtml(eyeLabel)}" aria-label="${escapeHtml(eyeLabel)}">${field.private ? ICONS.eyeOff : ICONS.eye}</button>
          <button type="button" class="field-button pf-tool" data-ws="profile-copy" title="${escapeHtml(t("Copy"))}" aria-label="${escapeHtml(t("Copy"))}">${ICONS.copy}</button>
          <button type="button" class="field-button pf-tool" data-ws="profile-delete-field" title="${escapeHtml(t("Delete"))}" aria-label="${escapeHtml(t("Delete"))}">${ICONS.trash}</button>
        </span>
      </div>`;
  }

  function renderProfile() {
    const groups = profile.sections.map(section => `
      <section class="settings-group pf-group" data-section="${escapeHtml(section.id)}">
        <div class="pf-group-head">
          <input type="text" class="pf-title" data-section-title value="${escapeHtml(shownTitle(section))}" placeholder="${escapeHtml(t("Group name"))}" aria-label="${escapeHtml(t("Group name"))}" autocomplete="off" spellcheck="false">
          ${isBuiltInSection(section) ? "" : `<button type="button" class="ws-icon-button" data-ws="profile-delete-section" title="${escapeHtml(t("Delete group"))}" aria-label="${escapeHtml(t("Delete group"))}">${ICONS.trash}</button>`}
        </div>
        <div class="settings-card">
          ${section.fields.map(profileRowHtml).join("")}
          ${section.fields.some(field => field.key === "birthDate") ? `<p class="settings-help">${escapeHtml(t("Age is worked out from this date"))}</p>` : ""}
          ${section.id === "other" && !section.fields.length ? `<p class="settings-help">${escapeHtml(t("Anything else forms ask for, such as school, occupation or an emergency contact."))}</p>` : ""}
          <button type="button" class="pf-add" data-ws="profile-add-field">${ICONS.plus}<span>${escapeHtml(t("Add field"))}</span></button>
        </div>
      </section>`).join("");
    el.body.innerHTML = `
      <div class="pf">
        <p class="settings-intro">${escapeHtml(t("Saved only in this browser. Close the eye on a detail to keep it private: it stays hidden here, and the assistant only gets a placeholder it can fill forms with, never the detail itself."))}</p>
        ${groups}
        <button type="button" class="pf-add pf-add-group" data-ws="profile-add-section">${ICONS.plus}<span>${escapeHtml(t("Add group"))}</span></button>
      </div>`;
  }

  function profileTarget(element) {
    const section = profile.sections.find(entry => entry.id === element.closest("[data-section]")?.dataset.section) || null;
    const field = section?.fields.find(entry => entry.id === element.closest("[data-field]")?.dataset.field) || null;
    return { section, field };
  }

  // ---------- Tables and checklists opened from the chat ----------

  function renderView() {
    if (view.type === "checklist") {
      renderChecklistView();
      return;
    }
    const table = expandTable(view);
    el.body.innerHTML = `
      <div class="ws-view-head">
        <button type="button" class="ws-text-button" data-ws="back">${ICONS.back}${escapeHtml(t("Back"))}</button>
        <strong>${escapeHtml(view.title)}</strong>
        <div class="ws-view-actions">
          <button type="button" class="ws-text-button" data-ws="copy-table">${escapeHtml(t("Copy CSV"))}</button>
          <button type="button" class="ws-text-button" data-ws="save-table">${escapeHtml(t("Save to notebook"))}</button>
        </div>
      </div>
      <div class="ws-table">${table.html}</div>`;
  }

  function renderChecklistView() {
    const { card } = view;
    const done = card.items.filter(item => item.done).length;
    el.body.innerHTML = `
      <div class="ws-view-head">
        <button type="button" class="ws-text-button" data-ws="back">${ICONS.back}${escapeHtml(t("Back"))}</button>
        <strong>${escapeHtml(card.title)}</strong>
        <div class="ws-view-actions">
          <button type="button" class="ws-text-button" data-ws="copy-checklist">${escapeHtml(t("Copy as list"))}</button>
          <button type="button" class="ws-text-button" data-ws="checklist-todos">${escapeHtml(t("Add to to-dos"))}</button>
          <button type="button" class="ws-text-button" data-ws="save-checklist">${escapeHtml(t("Save to notebook"))}</button>
        </div>
      </div>
      <p class="ws-view-summary">${escapeHtml(`${checklistSummary(card)} · ${t("{done} of {total} done", { done, total: card.items.length })}`)}</p>
      <ul class="ws-checklist">${card.items.map((item, index) => `
        <li class="ws-check-item is-${escapeHtml(item.severity)}${item.done ? " is-done" : ""}">
          <button type="button" class="ws-check-toggle" data-ws="toggle-check" data-index="${index}" title="${escapeHtml(t("Mark as done"))}" aria-pressed="${Boolean(item.done)}">${item.done ? SEVERITY_ICONS.ok : SEVERITY_ICONS[item.severity] || SEVERITY_ICONS.info}</button>
          <span class="ws-check-text">${renderInline(item.text)}</span>
          <button type="button" class="ws-page" data-ws="reveal-check" data-index="${index}">${escapeHtml(t("p. {page}", { page: item.page }))}</button>
        </li>`).join("")}
      </ul>`;
  }

  function showView(next) {
    if (tab !== "view") {
      returnTab = tab;
    }
    view = next;
    tab = "view";
    if (isShown) {
      render();
    } else {
      setOpen(true);
    }
  }

  function openTable(block) {
    showView({ type: "table", kind: block.kind, text: block.text, title: block.title || t("Table") });
  }

  // onChange runs after the reader ticks an item, so the reply the checklist came from stays in step.
  function openChecklist({ card, onChange, onReveal }) {
    showView({ type: "checklist", card, onChange, onReveal, title: card.title });
  }

  function checklistMarkdown(card) {
    return card.items.map(item => `- [${item.done ? "x" : " "}] ${item.text} [p. ${item.page}]`).join("\n");
  }

  // ---------- Export ----------

  function noteMarkdown(note) {
    return `# ${note.title || t("Untitled")}\n\n${blocksToMarkdown(note.blocks)}`;
  }

  function exportNotes() {
    const parts = [`# ${docName || t("Notebook")}`];
    for (const note of data.notes.slice().sort((a, b) => a.createdAt - b.createdAt)) {
      parts.push(`## ${note.title || t("Untitled")}\n\n${blocksToMarkdown(note.blocks).replace(/^(#{1,5}) /gm, "#$1 ")}`);
    }
    const marks = highlights();
    if (marks.length) {
      parts.push(`## ${t("Your highlights")}\n\n${marks.map(mark => `- “${mark.text}” (${t("p. {page}", { page: mark.page })})`).join("\n")}`);
    }
    downloadFile(`${baseName()} notes.md`, `${parts.join("\n\n")}\n`, "text/markdown");
  }

  // ---------- Reader actions ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("Copied"));
    } catch {
      toast(t("Couldn't copy"));
    }
  }

  async function handleAction(button) {
    const action = button.dataset.ws;
    if (action === "back") {
      view = null;
      tab = returnTab;
      render();
    } else if (action === "copy-table") {
      copyText(expandTable(view).csv);
    } else if (action === "save-table") {
      saveFromView(view.title, expandTable(view).markdown);
    } else if (action === "toggle-check") {
      const item = view.card.items[Number(button.dataset.index)];
      if (item) {
        item.done = !item.done;
        view.onChange?.();
        render();
      }
    } else if (action === "reveal-check") {
      const item = view.card.items[Number(button.dataset.index)];
      if (item) {
        view.onReveal?.(item);
      }
    } else if (action === "copy-checklist") {
      copyText(`${view.card.title}\n${checklistMarkdown(view.card)}`);
    } else if (action === "checklist-todos") {
      try {
        const items = view.card.items.filter(item => !item.done).map(item => ({ text: item.text, page: item.page }));
        const added = addTodos(items, { quiet: true, source: "ai" });
        toast(tn(added.length, "Added {count} to-do", "Added {count} to-dos"));
      } catch (error) {
        toast(error.message);
      }
    } else if (action === "save-checklist") {
      saveFromView(view.card.title, checklistMarkdown(view.card));
    } else if (action === "page") {
      goToPdfPage(Number(button.dataset.page));
    } else if (action === "collapse-nav") {
      // Wide enough for two columns: collapse the list. Narrow: the list is an overlay instead.
      if (el.body.clientWidth < 640) {
        navOpen = !navOpen;
        el.body.querySelector(".nb")?.classList.toggle("is-nav-open", navOpen);
      } else {
        navCollapsed = !navCollapsed;
        el.body.querySelector(".nb")?.classList.toggle("is-nav-collapsed", navCollapsed);
      }
    } else if (action === "toggle-add-menu") {
      addMenuOpen = !addMenuOpen;
      folderNameOpen = false;
      renderNoteNav();
    } else if (action === "new-folder") {
      folderNameOpen = true;
      renderNoteNav();
      el.body.querySelector("#nb-folder-name")?.focus();
    } else if (action === "cancel-add") {
      addMenuOpen = false;
      folderNameOpen = false;
      renderNoteNav();
    } else if (action === "toggle-folder") {
      const id = button.dataset.folderId;
      collapsedFolders.has(id) ? collapsedFolders.delete(id) : collapsedFolders.add(id);
      renderNoteNav();
    } else if (action === "toggle-nav") {
      navOpen = !navOpen;
      el.body.querySelector(".nb")?.classList.toggle("is-nav-open", navOpen);
    } else if (action === "select-note") {
      selectNote(button.dataset.noteId);
    } else if (action === "new-note") {
      addMenuOpen = false;
      // A new page joins the folder the open page sits in, so the plus on every folder isn't needed.
      const open = findNoteById(selectedNoteId);
      const folderId = open?.folderId && data.folders.some(folder => folder.id === open.folderId) ? open.folderId : null;
      const note = { id: uid("note"), kind: "note", title: "", blocks: markdownToBlocks(""), folderId, order: folderId ? nextOrder(folderId) : -1, page: null, source: "user", createdAt: Date.now() };
      data.notes.push(note);
      initializeOutline();
      save();
      selectNote(note.id);
      focusTitle();
    } else if (action === "copy-note") {
      const note = findNoteById(selectedNoteId);
      if (note) {
        copyText(noteMarkdown(note));
      }
    } else if (action === "delete-note") {
      const note = findNoteById(selectedNoteId);
      if (note) {
        data.notes = data.notes.filter(entry => entry !== note);
        selectedNoteId = null;
        save();
        render();
        toast(t("Page deleted"));
      }
    } else if (action === "highlights-to-note") {
      const marks = highlights();
      const note = addNote({
        title: t("Highlights from {name}", { name: baseName() }),
        content: marks.map(mark => `> ${mark.text.replace(/\n+/g, " ")} [p. ${mark.page}]`).join("\n\n"),
        kind: "note",
        source: "user"
      }, { select: true });
      if (note) {
        render();
      }
    } else if (action === "profile-private") {
      const { field } = profileTarget(button);
      if (field) {
        field.private = !field.private;
        saveProfile();
        render();
        el.body.querySelector(`[data-field="${CSS.escape(field.id)}"] [data-ws="profile-private"]`)?.focus();
      }
    } else if (action === "profile-copy") {
      const value = String(profileTarget(button).field?.value ?? "").trim();
      if (value) {
        copyText(value);
      }
    } else if (action === "profile-delete-field") {
      const { section, field } = profileTarget(button);
      if (section && field) {
        section.fields = section.fields.filter(entry => entry !== field);
        saveProfile();
        render();
      }
    } else if (action === "profile-add-field") {
      const { section } = profileTarget(button);
      if (section) {
        if (allFields(profile).length >= MAX_PROFILE_FIELDS) {
          toast(t("The profile has reached its field limit"));
          return;
        }
        const field = newField();
        section.fields.push(field);
        saveProfile();
        render();
        el.body.querySelector(`[data-field="${CSS.escape(field.id)}"] [data-field-label]`)?.focus();
      }
    } else if (action === "profile-add-section") {
      if (profile.sections.length >= MAX_PROFILE_SECTIONS || allFields(profile).length >= MAX_PROFILE_FIELDS) {
        toast(t("The profile has reached its group limit"));
        return;
      }
      const section = newSection();
      profile.sections.push(section);
      saveProfile();
      render();
      el.body.querySelector(`[data-section="${CSS.escape(section.id)}"] [data-section-title]`)?.focus();
    } else if (action === "profile-delete-section") {
      const { section } = profileTarget(button);
      const filled = section?.fields.some(field => String(field.value ?? "").trim());
      if (section && !isBuiltInSection(section) && (!filled || window.confirm(t("Delete this group and the details in it?")))) {
        profile.sections = profile.sections.filter(entry => entry !== section);
        saveProfile();
        render();
      }
    }
  }

  function saveFromView(title, content) {
    try {
      addNote({ title, content, kind: "note", source: "user" });
      toast(t("Saved to the notebook"));
    } catch (error) {
      toast(error.message);
    }
  }

  // The one bar sits outside the workspace body, so its buttons need their own handler.
  el.head.addEventListener("click", event => {
    const button = event.target.closest("button[data-ws]");
    if (button) {
      handleAction(button);
    }
  });

  el.body.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.closest(".be")) {
      return;
    }
    if (button.dataset.ws) {
      handleAction(button);
    } else if (button.classList.contains("cite")) {
      goToPdfPage(Number(button.dataset.page));
    }
  });

  el.body.addEventListener("keydown", event => {
    const target = event.target;
    if (target.matches("[data-note-title]")) {
      if ((event.key === "Enter" && !event.isComposing) || event.key === "ArrowDown") {
        event.preventDefault();
        editor?.focusStart();
      }
    }
  });

  el.body.addEventListener("input", event => {
    const target = event.target;
    if (target.matches("[data-note-title]")) {
      const note = findNoteById(selectedNoteId);
      if (note) {
        note.title = shortTitle(target.textContent);
        if (Array.from(target.textContent).length > MAX_NOTE_TITLE) {
          target.textContent = note.title;
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        note.updatedAt = Date.now();
        if (!target.textContent) {
          target.innerHTML = "";
        }
        const navTitle = el.body.querySelector(`.nb-nav-item[data-note-id="${CSS.escape(note.id)}"] .nb-nav-title`);
        if (navTitle) {
          navTitle.textContent = note.title || t("Untitled");
          navTitle.classList.toggle("is-untitled", !note.title);
        }
        save();
      }
    } else if (target.matches("[data-field-value]")) {
      const { field } = profileTarget(target);
      if (field) {
        field.value = target.value.slice(0, 500);
        saveProfile();
        const hint = target.parentElement.querySelector("[data-age]");
        if (hint) {
          hint.textContent = field.private ? "" : ageText(field.value);
        }
      }
    } else if (target.matches("[data-field-label]")) {
      const { field } = profileTarget(target);
      if (field) {
        // Typing the built-in name back (or clearing it) returns to the default, which stays translated.
        const text = target.value.trim();
        field.label = !text || text === defaultLabel(field) ? "" : target.value.slice(0, 80);
        saveProfile();
      }
    } else if (target.matches("[data-section-title]")) {
      const { section } = profileTarget(target);
      if (section) {
        const text = target.value.trim();
        section.title = isBuiltInSection(section) && (!text || text === t(sectionTitle({ id: section.id }))) ? "" : target.value.slice(0, 80);
        saveProfile();
      }
    }
  });

  el.body.addEventListener("submit", event => {
    if (event.target.dataset.wsForm === "folder") {
      event.preventDefault();
      const name = event.target.elements.folderName.value.trim().slice(0, 80);
      if (name) {
        data.folders.push({ id: uid("folder"), name, parentId: null, order: nextOrder(null), createdAt: Date.now() });
        save();
      }
      addMenuOpen = false;
      folderNameOpen = false;
      renderNoteNav();
    }
  });

  // Dragging a page or a folder. The target is recomputed on every pointer move but the indicator
  // only changes when the target really changes, so nothing flickers under the cursor.
  function clearDropMarks() {
    for (const marked of el.body.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-inside, .is-drop-root")) {
      marked.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside", "is-drop-root");
    }
  }

  function stopDragging() {
    clearTimeout(folderOpenTimer);
    cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = 0;
    draggedItemId = null;
    dropProposal = null;
    dropKey = "";
    clearDropMarks();
    el.body.querySelector(".nb")?.classList.remove("is-sorting");
    for (const item of el.body.querySelectorAll(".is-dragging")) {
      item.classList.remove("is-dragging");
    }
  }

  // Holding a page near the top or bottom edge keeps the list scrolling.
  function autoScrollNav(clientY) {
    const scroller = el.body.querySelector(".nb-nav-scroll");
    cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = 0;
    if (!scroller || !draggedItemId) {
      return;
    }
    const box = scroller.getBoundingClientRect();
    const speed = clientY < box.top + 40 ? -9 : clientY > box.bottom - 40 ? 9 : 0;
    if (!speed) {
      return;
    }
    const step = () => {
      scroller.scrollTop += speed;
      autoScrollFrame = requestAnimationFrame(step);
    };
    autoScrollFrame = requestAnimationFrame(step);
  }

  el.body.addEventListener("dragstart", event => {
    const item = event.target.closest(".nb-entry [draggable='true']");
    if (!item) return;
    draggedItemId = item.closest(".nb-entry")?.dataset.outlineId;
    if (!draggedItemId) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedItemId);
    // Carry the row itself, held where it was picked up, instead of a snapshot of the whole entry.
    event.dataTransfer.setDragImage(item, 14, item.offsetHeight / 2);
    dropKey = "";
    item.classList.add("is-dragging");
    el.body.querySelector(".nb")?.classList.add("is-sorting");
  });

  el.body.addEventListener("dragover", event => {
    if (!draggedItemId) return;
    const entry = event.target.closest(".nb-entry");
    const root = event.target.closest("[data-outline-root]");
    if (!entry && !root) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    autoScrollNav(event.clientY);

    let next = null;
    let key = "none";
    let mark = null;
    if (!entry) {
      next = { parentId: null, beforeId: null };
      key = "root";
      mark = { element: root, className: "is-drop-root" };
    } else {
      const item = outlineItem(entry.dataset.outlineId);
      const row = entry.querySelector(":scope > .nb-nav-item, :scope > .nb-folder-head");
      const rect = row?.getBoundingClientRect();
      const fraction = rect ? (event.clientY - rect.top) / rect.height : 0.5;
      if (item && item.id !== draggedItemId) {
        if (data.folders.includes(item) && fraction >= 0.28 && fraction <= 0.72) {
          next = { parentId: item.id, beforeId: null };
          key = `inside:${item.id}`;
          mark = { element: entry, className: "is-drop-inside" };
        } else {
          const parentId = itemParent(item);
          const siblings = orderedChildren(parentId).filter(sibling => sibling.id !== draggedItemId);
          const index = siblings.findIndex(sibling => sibling.id === item.id);
          const before = fraction < 0.5;
          next = { parentId, beforeId: before ? item.id : siblings[index + 1]?.id || null };
          key = `${before ? "before" : "after"}:${item.id}`;
          mark = { element: entry, className: before ? "is-drop-before" : "is-drop-after" };
        }
      }
    }
    if (key === dropKey) {
      return;
    }
    dropKey = key;
    dropProposal = next;
    clearDropMarks();
    clearTimeout(folderOpenTimer);
    mark?.element.classList.add(mark.className);
    // Hold a page over a closed folder and it opens, so it can be dropped straight inside.
    if (next?.parentId && collapsedFolders.has(next.parentId)) {
      const folderId = next.parentId;
      folderOpenTimer = window.setTimeout(() => {
        collapsedFolders.delete(folderId);
        renderNoteNav();
        el.body.querySelector(`.nb-entry[data-outline-id="${CSS.escape(folderId)}"]`)?.classList.add("is-drop-inside");
      }, 600);
    }
  });

  el.body.addEventListener("drop", event => {
    if (!dropProposal || !draggedItemId) return;
    event.preventDefault();
    const movedId = draggedItemId;
    const { parentId, beforeId } = dropProposal;
    stopDragging();
    if (!moveOutlineItem(movedId, parentId, beforeId)) {
      return;
    }
    // A short flash on the row that landed, so the eye can follow where it went.
    const entry = el.body.querySelector(`.nb-entry[data-outline-id="${CSS.escape(movedId)}"]`);
    const landed = entry?.querySelector(":scope > .nb-nav-item, :scope > .nb-folder-head");
    landed?.classList.add("is-just-moved");
    window.setTimeout(() => landed?.classList.remove("is-just-moved"), 700);
  });

  el.body.addEventListener("dragend", stopDragging);

  document.addEventListener("pointerdown", event => {
    if (!addMenuOpen || !isShown) return;
    if (event.target.closest(".nb-add-popover, [data-ws='toggle-add-menu']")) return;
    addMenuOpen = false;
    folderNameOpen = false;
    renderNoteNav();
  });
  el.body.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !addMenuOpen) return;
    event.preventDefault();
    addMenuOpen = false;
    folderNameOpen = false;
    renderNoteNav();
  });

  el.tabs.addEventListener("click", event => {
    const button = event.target.closest("[data-workspace-tab]");
    if (button) {
      view = null;
      setOpen(true, button.dataset.workspaceTab);
    }
  });
  el.exportButton.addEventListener("click", exportNotes);
  el.close.addEventListener("click", () => setOpen(false));
  el.toggle?.addEventListener("click", () => setOpen(!isShown));

  // ---------- For the assistant ----------

  function requireDocument() {
    if (!docKey) {
      throw new Error("No PDF is open.");
    }
  }

  function addNote({ title, content, kind, page, source = "ai" } = {}, { select = false } = {}) {
    requireDocument();
    const text = String(content ?? "").trim();
    if (!text) {
      throw new Error("The note is empty.");
    }
    const note = {
      id: uid("note"),
      kind: KIND_LABELS[kind] ? kind : "note",
      title: shortTitle(String(title ?? "").trim()) || t("Untitled"),
      blocks: markdownToBlocks(text.slice(0, MAX_NOTE_LENGTH)),
      page: pageNumber(page),
      order: -1,
      source: source === "user" ? "user" : "ai",
      createdAt: Date.now()
    };
    data.notes = [...data.notes, note].slice(-MAX_NOTES);
    initializeOutline();
    save();
    // Show the new page, unless the reader is in the middle of writing on another one.
    if (select || !(isShown && tab === "notes" && editor && isEditingNote())) {
      selectedNoteId = note.id;
    }
    notify("notes");
    return note;
  }

  // Every document has one To-do page in the notebook; it is made the first time something is added.
  function todoPage() {
    return data.notes.find(note => note.kind === "todos") || null;
  }

  function addTodos(items, { quiet = false, source = "ai" } = {}) {
    requireDocument();
    let note = todoPage();
    const { blocks, added } = mergeTodos(note?.blocks, items);
    if (!added.length) {
      if (Array.isArray(items) && items.some(item => String(item?.text ?? "").trim())) {
        return added;
      }
      throw new Error("Pass at least one to-do with text.");
    }
    if (!note) {
      note = { id: uid("note"), kind: "todos", title: t("To-do"), blocks: [], page: null, order: -1, source, createdAt: Date.now() };
      data.notes.push(note);
      initializeOutline();
    }
    note.blocks = blocks;
    note.updatedAt = Date.now();
    save();
    if (!isShown || tab !== "notes" || !(editor && isEditingNote())) {
      selectedNoteId = note.id;
    }
    if (!quiet) {
      notify("notes");
    } else if (isShown && tab === "notes") {
      render();
    }
    return added;
  }

  // Before to-dos became a notebook page they were a separate list; move any saved ones over once.
  function migrateTodos(legacy) {
    const items = (Array.isArray(legacy) ? legacy : [])
      .filter(todo => todo && String(todo.text ?? "").trim())
      .map(todo => ({ text: String(todo.text), page: todo.page, done: Boolean(todo.done) }));
    if (!items.length) {
      return;
    }
    const note = todoPage() || { id: uid("note"), kind: "todos", title: t("To-do"), blocks: [], page: null, order: -1, source: "user", createdAt: Date.now() };
    note.blocks = mergeTodos(note.blocks, items).blocks;
    if (!data.notes.includes(note)) {
      data.notes.push(note);
      initializeOutline();
    }
    save();
  }

  function snapshot() {
    const page = todoPage();
    return {
      notes: data.notes.filter(note => note.kind !== "todos").map(({ id, kind, title, page: notePage }) => ({ id, kind, title, page: notePage })),
      todo_page: page ? { id: page.id, title: page.title, todos: readTodos(page.blocks) } : null
    };
  }

  async function getProfile() {
    await profileReady;
    return profileEntries(profile);
  }

  // The private values, for masking what goes to the assistant. Before the profile has loaded
  // nothing can have been filled from it yet.
  function privateDetails() {
    return privateEntries(profile);
  }

  // Swaps profile tokens the assistant passed back for the real values.
  async function fillProfileTokens(text) {
    await profileReady;
    return fillTokens(text, id => {
      const field = findField(profile, id);
      return field && { label: fieldLabel(field), value: field.value };
    });
  }

  async function saveProfileFields(fields) {
    await profileReady;
    let count = 0;
    for (const entry of Array.isArray(fields) ? fields : []) {
      if (String(entry?.label ?? "").trim() && String(entry?.value ?? "").trim() && applyDetail(profile, entry.label, entry.value)) {
        count += 1;
      }
    }
    if (!count) {
      throw new Error("Pass at least one field with a label and a value.");
    }
    clearTimeout(profileTimer);
    setItem(PROFILE_KEY, profile);
    notify("profile");
    return count;
  }

  function markupChanged() {
    syncHighlights();
    if (!isShown || tab !== "notes") {
      return;
    }
    renderNoteNav();
    if (selectedNoteId === HIGHLIGHTS) {
      renderNotePage();
    }
  }

  return {
    addNote: args => addNote(args),
    addTodos: items => addTodos(items),
    close: () => setOpen(false),
    fillProfileTokens,
    flush,
    getProfile,
    isOpen: () => isShown,
    markupChanged,
    open: nextTab => setOpen(true, nextTab),
    openChecklist,
    openTable,
    privateDetails,
    saveProfileFields,
    setDocument,
    snapshot,
    toggle: () => setOpen(!isShown)
  };
}
