// The workspace beside the assistant: a notebook, a to-do list and a personal profile. Notes and
// to-dos belong to the open document; the profile is shared by every document and never leaves
// this browser. The assistant writes into it with tools; the reader can edit everything by hand.

import { checklistSummary, expandTable, renderInline, renderMarkdown, runBlockAction, SEVERITY_ICONS } from "./ai.js";
import { buildCalendar, isCalendarDate } from "./ics.js";
import { t, tn, uiLanguage } from "./i18n.js";
import { getItem, setItem } from "./store.js";

const PROFILE_KEY = "profile";
const TABS = ["notes", "todos", "profile"];
const MAX_NOTES = 300;
const MAX_TODOS = 300;
const MAX_NOTE_LENGTH = 20_000;

const KIND_LABELS = {
  note: "Note",
  flashcards: "Flashcards",
  quiz: "Quiz",
  glossary: "Glossary",
  summary: "Summary",
  "paper-card": "Paper card",
  plan: "Revision plan",
  figures: "Key figures"
};

const ICONS = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>'
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

function locale() {
  return uiLanguage === "zh" ? "zh-CN" : undefined;
}

function formatDay(time) {
  try {
    return new Date(time).toLocaleDateString(locale(), { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function formatDue(date) {
  try {
    const day = new Date(`${date}T00:00:00`);
    const sameYear = day.getFullYear() === new Date().getFullYear();
    return day.toLocaleDateString(locale(), sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return date;
  }
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function pageNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function safeColor(value) {
  return /^#[0-9a-f]{3,8}$/i.test(String(value ?? "")) ? value : "#fcc419";
}

export function createWorkspace({ host, toast, onToggle }) {
  const $ = selector => document.querySelector(selector);
  const el = {
    panel: $("#workspace"),
    tabs: $("#workspaceTabs"),
    body: $("#workspaceBody"),
    exportButton: $("#workspaceExport"),
    close: $("#workspaceClose"),
    toggle: $("#aiWorkspaceToggle")
  };

  let isShown = false;
  let tab = "notes";
  let docKey = "";
  let docName = "";
  let data = { notes: [], todos: [] };
  let profile = [];
  let editingId = null;
  // A table or checklist opened from the chat, shown full-size in place of the tabs until the reader goes back.
  let view = null;
  // Set when something changed while the reader was typing in a note; the page re-renders once they stop.
  let pendingRender = false;
  let returnTab = "notes";
  let loadToken = 0;
  let saveTimer = 0;
  let pendingSave = null;
  let profileTimer = 0;

  el.panel.inert = true;
  const profileReady = getItem(PROFILE_KEY, []).then(saved => {
    profile = (Array.isArray(saved) ? saved : [])
      .filter(field => field && typeof field.label === "string")
      .map(field => ({ id: field.id || uid("field"), label: field.label, value: String(field.value ?? "") }));
  });

  // ---------- Storage ----------

  function save() {
    if (!docKey) {
      return;
    }
    pendingSave = { key: `workspace:${docKey}`, value: data };
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 250);
  }

  function flush() {
    clearTimeout(saveTimer);
    if (pendingSave) {
      setItem(pendingSave.key, pendingSave.value);
      pendingSave = null;
    }
  }

  function saveProfile() {
    clearTimeout(profileTimer);
    profileTimer = window.setTimeout(() => setItem(PROFILE_KEY, profile), 300);
  }

  async function setDocument(key, name = "") {
    flush();
    docKey = key || "";
    docName = name || "";
    editingId = null;
    if (view) {
      view = null;
      tab = returnTab;
    }
    data = { notes: [], todos: [] };
    const token = ++loadToken;
    if (docKey) {
      const saved = await getItem(`workspace:${docKey}`, null);
      if (token !== loadToken) {
        return;
      }
      data = {
        notes: Array.isArray(saved?.notes) ? saved.notes : [],
        todos: Array.isArray(saved?.todos) ? saved.todos : []
      };
    }
    render();
  }

  function baseName() {
    return (docName || "document").replace(/\.pdf$/i, "");
  }

  // ---------- Opening ----------

  function setOpen(open, nextTab) {
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

  function render() {
    for (const button of el.tabs.querySelectorAll("[data-workspace-tab]")) {
      const active = button.dataset.workspaceTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    el.exportButton.hidden = tab === "profile" || tab === "view";
    if (!isShown) {
      return;
    }
    if (tab === "view" && view) {
      renderView();
    } else if (tab === "notes") {
      if (isTypingInNotes()) {
        pendingRender = true;
        return;
      }
      renderNotes();
    } else if (tab === "todos") {
      renderTodos();
    } else {
      renderProfile();
    }
  }

  function pageButton(page) {
    return page ? `<button type="button" class="ws-page" data-ws="page" data-page="${page}">${escapeHtml(t("p. {page}", { page }))}</button>` : "";
  }

  // ---------- Notebook ----------
  // One Notion-like page per document. Titles are always editable; clicking a note's text turns it into
  // its Markdown source, which saves as you type and renders again when you click away.

  function noteBodyHtml(note) {
    return note.content.trim()
      ? renderMarkdown(note.content)
      : `<p class="nb-placeholder">${escapeHtml(t("Click to write…"))}</p>`;
  }

  function renderNote(note) {
    const meta = [t(KIND_LABELS[note.kind] || "Note"), formatDay(note.createdAt)].filter(Boolean).join(" · ");
    return `
      <section class="nb-note" data-note="${escapeHtml(note.id)}">
        <div class="nb-note-tools">
          <button type="button" class="ws-icon-button" data-ws="copy-note" title="${escapeHtml(t("Copy"))}" aria-label="${escapeHtml(t("Copy"))}">${ICONS.copy}</button>
          <button type="button" class="ws-icon-button" data-ws="delete-note" title="${escapeHtml(t("Delete"))}" aria-label="${escapeHtml(t("Delete"))}">${ICONS.trash}</button>
        </div>
        <input class="nb-note-title" type="text" value="${escapeHtml(note.title)}" placeholder="${escapeHtml(t("Untitled"))}" aria-label="${escapeHtml(t("Title"))}">
        <div class="nb-note-meta"><span>${escapeHtml(meta)}</span>${pageButton(note.page)}</div>
        <div class="nb-note-body msg assistant" data-note-body>${noteBodyHtml(note)}</div>
      </section>`;
  }

  function isTypingInNotes() {
    const active = document.activeElement;
    return Boolean(active && el.body.contains(active) && active.matches(".nb-editor, .nb-note-title"));
  }

  function autoGrow(editor) {
    editor.style.height = "auto";
    editor.style.height = `${editor.scrollHeight}px`;
  }

  function startEditing(body) {
    const note = findNote(body);
    if (!note) {
      return;
    }
    const editor = document.createElement("textarea");
    editor.className = "nb-editor";
    editor.value = note.content;
    editor.placeholder = t("Write in Markdown…");
    editor.dataset.noteEditor = note.id;
    editingId = note.id;
    body.replaceWith(editor);
    autoGrow(editor);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function finishEditing(editor) {
    const note = data.notes.find(entry => entry.id === editor.dataset.noteEditor);
    editingId = null;
    if (note && editor.isConnected) {
      const body = document.createElement("div");
      body.className = "nb-note-body msg assistant";
      body.dataset.noteBody = "";
      body.innerHTML = noteBodyHtml(note);
      editor.replaceWith(body);
    }
  }

  // Deferred refresh once focus has settled somewhere outside the note being typed in.
  function flushPendingRender() {
    window.setTimeout(() => {
      if (pendingRender && !isTypingInNotes()) {
        pendingRender = false;
        render();
      }
    }, 0);
  }

  function highlights() {
    try {
      return host.listHighlights();
    } catch {
      return [];
    }
  }

  function renderNotes() {
    if (!docKey) {
      el.body.innerHTML = `<p class="ws-empty">${escapeHtml(t("Open a PDF to keep notes next to it."))}</p>`;
      return;
    }
    // Oldest first, like a document: what the assistant saves next lands at the bottom.
    const notes = data.notes.slice().sort((a, b) => a.createdAt - b.createdAt);
    const marks = highlights();
    let html = `
      <header class="nb-header">
        <div class="nb-icon" aria-hidden="true">${ICONS.book}</div>
        <h1 class="nb-title">${escapeHtml(baseName())}</h1>
        <p class="nb-meta">${escapeHtml(t("Notebook"))} · ${escapeHtml(tn(notes.length, "{count} note", "{count} notes"))}</p>
      </header>`;
    if (!notes.length) {
      html += `<p class="nb-empty">${escapeHtml(t("Notes, flashcards, quizzes and summaries the assistant saves appear here, next to this document."))}</p>`;
    }
    html += notes.map(renderNote).join("");
    html += `<button type="button" class="nb-add" data-ws="new-note">${ICONS.plus}<span>${escapeHtml(t("Add a note"))}</span></button>`;
    if (marks.length) {
      html += `<h2 class="nb-section-title">${escapeHtml(t("Your highlights"))}<span>${marks.length}</span></h2><ul class="nb-highlights">`;
      html += marks.map(mark => `
        <li>
          <button type="button" class="nb-highlight" data-ws="page" data-page="${mark.page}" style="--c:${safeColor(mark.color)}">
            <span>${escapeHtml(mark.text)}</span>
            <em>${escapeHtml(t("p. {page}", { page: mark.page }))}</em>
          </button>
        </li>`).join("");
      html += "</ul>";
    }
    el.body.innerHTML = html;
  }

  function sortedTodos() {
    return data.todos.slice().sort((a, b) =>
      Number(a.done) - Number(b.done)
      || (a.due || "9999").localeCompare(b.due || "9999")
      || a.createdAt - b.createdAt);
  }

  function renderTodos() {
    if (!docKey) {
      el.body.innerHTML = `<p class="ws-empty">${escapeHtml(t("Open a PDF to track to-dos for it."))}</p>`;
      return;
    }
    const todos = sortedTodos();
    const done = todos.filter(todo => todo.done).length;
    const now = today();
    let html = `
      <form class="ws-add" data-ws-form="todo">
        <input name="text" type="text" placeholder="${escapeHtml(t("Add a to-do…"))}" autocomplete="off">
        <input name="due" type="date" aria-label="${escapeHtml(t("Due date"))}">
        <button type="submit" class="ws-icon-button" title="${escapeHtml(t("Add"))}" aria-label="${escapeHtml(t("Add"))}">${ICONS.plus}</button>
      </form>`;
    if (todos.length) {
      html += `<div class="ws-toolbar"><span>${escapeHtml(t("{done} of {total} done", { done, total: todos.length }))}</span></div>`;
    } else {
      html += `<p class="ws-empty">${escapeHtml(t("Deadlines, risks and documents to prepare that the assistant finds are listed here. You can add your own too."))}</p>`;
    }
    html += '<ul class="ws-todos">' + todos.map(todo => {
      const overdue = todo.due && !todo.done && todo.due < now;
      const due = todo.due
        ? `<span class="ws-due${overdue ? " is-overdue" : ""}" title="${overdue ? escapeHtml(t("Overdue")) : ""}">${escapeHtml(formatDue(todo.due))}</span>`
        : "";
      return `
        <li class="ws-todo${todo.done ? " is-done" : ""}" data-todo="${escapeHtml(todo.id)}">
          <label class="ws-check"><input type="checkbox" data-ws="toggle-todo" ${todo.done ? "checked" : ""}><span>${escapeHtml(todo.text)}</span></label>
          <span class="ws-todo-meta">${due}${pageButton(todo.page)}</span>
          <button type="button" class="ws-icon-button ws-delete" data-ws="delete-todo" title="${escapeHtml(t("Delete"))}" aria-label="${escapeHtml(t("Delete"))}">${ICONS.trash}</button>
        </li>`;
    }).join("") + "</ul>";
    el.body.innerHTML = html;
  }

  function renderProfile() {
    let html = `<p class="ws-empty">${escapeHtml(t("Saved only in this browser. The assistant reads these details when it fills in forms, and asks before saving anything new."))}</p>`;
    html += '<div class="ws-profile">' + profile.map(field => `
      <div class="ws-field" data-field="${escapeHtml(field.id)}">
        <input class="ws-field-label" type="text" data-ws-input="label" value="${escapeHtml(field.label)}" placeholder="${escapeHtml(t("Label"))}">
        <input class="ws-field-value" type="text" data-ws-input="value" value="${escapeHtml(field.value)}" placeholder="${escapeHtml(t("Value"))}">
        <button type="button" class="ws-icon-button ws-delete" data-ws="delete-field" title="${escapeHtml(t("Delete"))}" aria-label="${escapeHtml(t("Delete"))}">${ICONS.trash}</button>
      </div>`).join("") + "</div>";
    html += `<button type="button" class="ws-text-button" data-ws="add-field">${ICONS.plus}${escapeHtml(t("Add field"))}</button>`;
    el.body.innerHTML = html;
  }

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
    editingId = null;
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

  function exportNotes() {
    const lines = [`# ${docName || t("Notebook")}`, ""];
    for (const note of data.notes.slice().sort((a, b) => a.createdAt - b.createdAt)) {
      const meta = [t(KIND_LABELS[note.kind] || "Note"), note.page ? t("p. {page}", { page: note.page }) : ""].filter(Boolean).join(" · ");
      lines.push(`## ${note.title || t("Untitled")}`, `*${meta}*`, "", note.content, "");
    }
    const marks = highlights();
    if (marks.length) {
      lines.push(`## ${t("Your highlights")}`, "", ...marks.map(mark => `- “${mark.text}” (${t("p. {page}", { page: mark.page })})`), "");
    }
    downloadFile(`${baseName()} notes.md`, lines.join("\n"), "text/markdown");
  }

  function exportTodos() {
    const dated = data.todos.filter(todo => isCalendarDate(todo.due) && !todo.done);
    if (dated.length) {
      const events = dated.map(todo => ({
        title: todo.text,
        date: todo.due,
        description: [docName, todo.page ? t("p. {page}", { page: todo.page }) : ""].filter(Boolean).join(" · ")
      }));
      downloadFile(`${baseName()} to-dos.ics`, buildCalendar(events), "text/calendar");
      return;
    }
    const lines = sortedTodos().map(todo => `- [${todo.done ? "x" : " "}] ${todo.text}${todo.page ? ` (${t("p. {page}", { page: todo.page })})` : ""}`);
    downloadFile(`${baseName()} to-dos.md`, `${lines.join("\n")}\n`, "text/markdown");
    toast(t("No dated to-dos — exported a checklist instead."));
  }

  // ---------- Reader actions ----------

  function findNote(target) {
    const id = target.closest("[data-note]")?.dataset.note;
    return data.notes.find(note => note.id === id);
  }

  function findTodo(target) {
    const id = target.closest("[data-todo]")?.dataset.todo;
    return data.todos.find(todo => todo.id === id);
  }

  async function handleAction(button) {
    const action = button.dataset.ws;
    if (action === "back") {
      view = null;
      tab = returnTab;
      render();
    } else if (action === "copy-table") {
      try {
        await navigator.clipboard.writeText(expandTable(view).csv);
        toast(t("Copied"));
      } catch {
        toast(t("Couldn't copy"));
      }
    } else if (action === "save-table") {
      try {
        addNote({ title: view.title, content: expandTable(view).markdown, kind: "note" });
        toast(t("Saved to the notebook"));
      } catch (error) {
        toast(error.message);
      }
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
      try {
        await navigator.clipboard.writeText(`${view.card.title}\n${checklistMarkdown(view.card)}`);
        toast(t("Copied"));
      } catch {
        toast(t("Couldn't copy"));
      }
    } else if (action === "checklist-todos") {
      try {
        const items = view.card.items.filter(item => !item.done).map(item => ({ text: item.text, page: item.page }));
        const added = addTodos(items, { quiet: true });
        toast(tn(added.length, "Added {count} to-do", "Added {count} to-dos"));
      } catch (error) {
        toast(error.message);
      }
    } else if (action === "save-checklist") {
      try {
        addNote({ title: view.card.title, content: checklistMarkdown(view.card), kind: "note" });
        toast(t("Saved to the notebook"));
      } catch (error) {
        toast(error.message);
      }
    } else if (action === "page") {
      host.goToPage(Number(button.dataset.page));
    } else if (action === "new-note") {
      const note = { id: uid("note"), kind: "note", title: "", content: "", page: null, createdAt: Date.now() };
      data.notes.push(note);
      save();
      render();
      el.body.querySelector(`[data-note="${note.id}"] .nb-note-title`)?.focus();
    } else if (action === "copy-note") {
      const note = findNote(button);
      try {
        await navigator.clipboard.writeText(note ? `${note.title}\n\n${note.content}` : "");
        toast(t("Copied"));
      } catch {
        toast(t("Couldn't copy"));
      }
    } else if (action === "delete-note") {
      const note = findNote(button);
      data.notes = data.notes.filter(entry => entry !== note);
      save();
      render();
      toast(t("Note deleted"));
    } else if (action === "delete-todo") {
      const todo = findTodo(button);
      data.todos = data.todos.filter(entry => entry !== todo);
      save();
      render();
    } else if (action === "add-field") {
      profile.push({ id: uid("field"), label: "", value: "" });
      render();
      el.body.querySelector(".ws-field:last-child .ws-field-label")?.focus();
    } else if (action === "delete-field") {
      const id = button.closest("[data-field]")?.dataset.field;
      profile = profile.filter(field => field.id !== id);
      saveProfile();
      render();
    }
  }

  el.body.addEventListener("click", event => {
    const noteBody = event.target.closest("[data-note-body]");
    if (noteBody && !event.target.closest("button, a, input")) {
      startEditing(noteBody);
      return;
    }
    const button = event.target.closest("button");
    if (!button) {
      return;
    }
    if (button.dataset.ws) {
      handleAction(button);
    } else if (button.dataset.blockAction) {
      runBlockAction(button, { baseName: baseName(), toast });
    } else if (button.classList.contains("cite")) {
      host.goToPage(Number(button.dataset.page));
    }
  });

  el.body.addEventListener("change", event => {
    if (event.target.dataset.ws === "toggle-todo") {
      const todo = findTodo(event.target);
      if (todo) {
        todo.done = event.target.checked;
        save();
        render();
      }
    }
  });

  el.body.addEventListener("focusout", event => {
    if (event.target.matches(".nb-editor")) {
      finishEditing(event.target);
    }
    if (event.target.matches(".nb-editor, .nb-note-title")) {
      flushPendingRender();
    }
  });

  el.body.addEventListener("keydown", event => {
    if (event.key === "Escape" && event.target.matches(".nb-editor")) {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === "Enter" && !event.isComposing && event.target.matches(".nb-note-title")) {
      event.preventDefault();
      const body = event.target.closest("[data-note]")?.querySelector("[data-note-body]");
      if (body) {
        startEditing(body);
      }
    }
  });

  el.body.addEventListener("input", event => {
    if (event.target.matches(".nb-editor")) {
      const note = data.notes.find(entry => entry.id === event.target.dataset.noteEditor);
      if (note) {
        note.content = event.target.value.slice(0, MAX_NOTE_LENGTH);
        note.updatedAt = Date.now();
        save();
      }
      autoGrow(event.target);
      return;
    }
    if (event.target.matches(".nb-note-title")) {
      const note = findNote(event.target);
      if (note) {
        note.title = event.target.value.slice(0, 120);
        note.updatedAt = Date.now();
        save();
      }
      return;
    }
    const key = event.target.dataset.wsInput;
    const field = profile.find(entry => entry.id === event.target.closest("[data-field]")?.dataset.field);
    if (key && field) {
      field[key] = event.target.value;
      saveProfile();
    }
  });

  el.body.addEventListener("submit", event => {
    if (event.target.dataset.wsForm !== "todo") {
      return;
    }
    event.preventDefault();
    const form = event.target;
    const text = form.elements.text.value.trim();
    if (!text) {
      form.elements.text.focus();
      return;
    }
    addTodos([{ text, due: form.elements.due.value }], { quiet: true });
    render();
    el.body.querySelector('.ws-add input[name="text"]')?.focus();
  });

  el.tabs.addEventListener("click", event => {
    const button = event.target.closest("[data-workspace-tab]");
    if (button) {
      editingId = null;
      view = null;
      setOpen(true, button.dataset.workspaceTab);
    }
  });
  el.exportButton.addEventListener("click", () => (tab === "todos" ? exportTodos() : exportNotes()));
  el.close.addEventListener("click", () => setOpen(false));
  el.toggle?.addEventListener("click", () => setOpen(!isShown));

  // ---------- For the assistant ----------

  function requireDocument() {
    if (!docKey) {
      throw new Error("No PDF is open.");
    }
  }

  function addNote({ title, content, kind, page } = {}) {
    requireDocument();
    const text = String(content ?? "").trim();
    if (!text) {
      throw new Error("The note is empty.");
    }
    const note = {
      id: uid("note"),
      kind: KIND_LABELS[kind] ? kind : "note",
      title: String(title ?? "").trim().slice(0, 120) || t("Untitled"),
      content: text.slice(0, MAX_NOTE_LENGTH),
      page: pageNumber(page),
      createdAt: Date.now()
    };
    data.notes = [...data.notes, note].slice(-MAX_NOTES);
    save();
    notify("notes");
    return note;
  }

  function addTodos(items, { quiet = false } = {}) {
    requireDocument();
    const added = (Array.isArray(items) ? items : [])
      .map(item => ({
        id: uid("todo"),
        text: String(item?.text ?? "").trim().slice(0, 300),
        due: isCalendarDate(item?.due) ? item.due : "",
        page: pageNumber(item?.page),
        done: false,
        createdAt: Date.now()
      }))
      .filter(item => item.text);
    if (!added.length) {
      throw new Error("Pass at least one to-do with text.");
    }
    data.todos = [...data.todos, ...added].slice(-MAX_TODOS);
    save();
    if (!quiet) {
      notify("todos");
    }
    return added;
  }

  function snapshot() {
    return {
      notes: data.notes.map(({ id, kind, title, page }) => ({ id, kind, title, page })),
      todos: data.todos.map(({ id, text, due, page, done }) => ({ id, text, due, page, done }))
    };
  }

  async function getProfile() {
    await profileReady;
    return profile
      .filter(field => field.label.trim() && field.value.trim())
      .map(({ label, value }) => ({ label, value }));
  }

  async function saveProfileFields(fields) {
    await profileReady;
    let count = 0;
    for (const entry of Array.isArray(fields) ? fields : []) {
      const label = String(entry?.label ?? "").trim().slice(0, 80);
      const value = String(entry?.value ?? "").trim().slice(0, 500);
      if (!label || !value) {
        continue;
      }
      const existing = profile.find(field => field.label.trim().toLowerCase() === label.toLowerCase());
      if (existing) {
        existing.value = value;
      } else {
        profile.push({ id: uid("field"), label, value });
      }
      count += 1;
    }
    if (!count) {
      throw new Error("Pass at least one field with a label and a value.");
    }
    setItem(PROFILE_KEY, profile);
    notify("profile");
    return count;
  }

  function markupChanged() {
    if (isShown && tab === "notes") {
      render();
    }
  }

  return {
    addNote,
    addTodos,
    close: () => setOpen(false),
    flush,
    getProfile,
    isOpen: () => isShown,
    markupChanged,
    open: nextTab => setOpen(true, nextTab),
    openChecklist,
    openTable,
    saveProfileFields,
    setDocument,
    snapshot,
    toggle: () => setOpen(!isShown)
  };
}
