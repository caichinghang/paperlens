// The explain lens: hold ⌥ (Option/Alt) and point at a formula, table, chart or paragraph.
// The area under the cursor is outlined; after a short dwell (or an ⌥-click) a cropped image of just
// that area is sent to the model and a small bubble explains it, without opening the chat.

import { renderMarkdown } from "./ai.js";
import { replyLanguageName, t, translationDirection } from "./i18n.js";

const DWELL_MS = 650;
const OUTLINE_PAD = 4;
const FALLBACK_WIDTH = 0.42;
const FALLBACK_HEIGHT = 0.22;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createLens(host, { quickAsk, openChat }) {
  const layoutCache = new Map();
  let altHeld = false;
  let pointer = null;
  let target = null;
  let outline = null;
  let bubble = null;
  let dwellTimer = 0;
  let controller = null;
  let bubbleContext = null;

  // ---------- Finding what's under the cursor ----------

  function pageAt(clientX, clientY) {
    for (const page of host.pages()) {
      if (!page.near) {
        continue;
      }
      const rect = page.shell.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return { page, rect };
      }
    }
    return null;
  }

  function blocksFor(page) {
    if (!layoutCache.has(page.number)) {
      layoutCache.set(page.number, host.layout(page.number).then(result => result.blocks).catch(() => []));
    }
    return layoutCache.get(page.number);
  }

  async function locate(clientX, clientY) {
    const hit = pageAt(clientX, clientY);
    if (!hit) {
      return null;
    }
    const { page, rect } = hit;
    const x = ((clientX - rect.left) / rect.width) * page.width;
    const y = ((clientY - rect.top) / rect.height) * page.height;
    const blocks = await blocksFor(page);
    const pad = 6;
    const block = blocks.find(candidate =>
      x >= candidate.box.x - pad && x <= candidate.box.x + candidate.box.width + pad &&
      y >= candidate.box.y - pad && y <= candidate.box.y + candidate.box.height + pad);

    if (block) {
      return { page, box: block.box, text: block.text, kind: block.lineCount > 1 ? "paragraph" : "line" };
    }

    const width = page.width * FALLBACK_WIDTH;
    const height = page.height * FALLBACK_HEIGHT;
    return {
      page,
      box: { x: clamp(x - width / 2, 0, page.width - width), y: clamp(y - height / 2, 0, page.height - height), width, height },
      text: "",
      kind: "area"
    };
  }

  // ---------- Outline ----------

  function ensureOutline() {
    if (!outline) {
      outline = document.createElement("div");
      outline.className = "lens-outline";
      outline.hidden = true;
    }
    return outline;
  }

  function showOutline(found) {
    const element = ensureOutline();
    if (element.parentElement !== found.page.shell) {
      found.page.shell.append(element);
    }
    const { page, box } = found;
    element.style.left = `${((box.x - OUTLINE_PAD) / page.width) * 100}%`;
    element.style.top = `${((box.y - OUTLINE_PAD) / page.height) * 100}%`;
    element.style.width = `${((box.width + OUTLINE_PAD * 2) / page.width) * 100}%`;
    element.style.height = `${((box.height + OUTLINE_PAD * 2) / page.height) * 100}%`;
    element.hidden = false;
  }

  function hideOutline() {
    if (outline) {
      outline.hidden = true;
    }
  }

  function sameTarget(a, b) {
    return a && b && a.page === b.page && Math.abs(a.box.x - b.box.x) < 1 && Math.abs(a.box.y - b.box.y) < 1 &&
      Math.abs(a.box.width - b.box.width) < 1 && Math.abs(a.box.height - b.box.height) < 1;
  }

  let locateToken = 0;
  async function track() {
    if (!altHeld || !pointer) {
      return;
    }
    const myToken = ++locateToken;
    const found = await locate(pointer.x, pointer.y);
    if (myToken !== locateToken || !altHeld) {
      return;
    }
    if (!found) {
      target = null;
      hideOutline();
      clearTimeout(dwellTimer);
      return;
    }
    if (sameTarget(found, target)) {
      return;
    }
    target = found;
    showOutline(found);
    clearTimeout(dwellTimer);
    dwellTimer = window.setTimeout(() => {
      if (altHeld && target === found) {
        explain(found, "explain");
      }
    }, DWELL_MS);
  }

  // ---------- Bubble ----------

  function ensureBubble() {
    if (bubble) {
      return bubble;
    }
    bubble = document.createElement("div");
    bubble.className = "lens-bubble glass";
    bubble.setAttribute("role", "dialog");
    bubble.innerHTML = `
      <div class="lens-head">
        <span class="lens-kind"></span>
        <button type="button" class="lens-close panel-icon-button" aria-label="${t("Close")}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
      </div>
      <div class="lens-body msg assistant"></div>
      <div class="lens-actions">
        <button type="button" class="text-button" data-lens="chat">${t("Ask more in chat")}</button>
        <button type="button" class="text-button" data-lens="copy">${t("Copy")}</button>
      </div>`;
    bubble.addEventListener("pointerdown", event => event.stopPropagation());
    bubble.querySelector(".lens-close").addEventListener("click", closeBubble);
    bubble.querySelector('[data-lens="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(bubbleContext?.answer || "");
        host.toast(t("Copied"));
      } catch {
        host.toast(t("Couldn't copy"));
      }
    });
    bubble.querySelector('[data-lens="chat"]').addEventListener("click", () => {
      if (!bubbleContext) {
        return;
      }
      const { page, box, text, answer } = bubbleContext;
      openChat({
        region: { page: page.number, box: host.toGrid(page.number, box), label: `${page.number}: ${text ? text.slice(0, 40) : t("region")}` },
        quote: text ? text.slice(0, 600) : "",
        draft: answer ? "" : t("Explain this in more detail.")
      });
      closeBubble();
    });
    host.stage.append(bubble);
    return bubble;
  }

  function placeBubble(found) {
    const element = ensureBubble();
    const stage = host.stage.getBoundingClientRect();
    const pageRect = found.page.shell.getBoundingClientRect();
    const { page, box } = found;
    const regionLeft = pageRect.left + (box.x / page.width) * pageRect.width - stage.left;
    const regionTop = pageRect.top + (box.y / page.height) * pageRect.height - stage.top;
    const regionRight = regionLeft + (box.width / page.width) * pageRect.width;
    const regionBottom = regionTop + (box.height / page.height) * pageRect.height;
    const width = element.offsetWidth;
    const height = element.offsetHeight;

    // Only the part of the viewer no panel covers counts as room.
    const area = host.uncovered?.() || { left: 0, right: stage.width };
    let left;
    let top;
    if (regionRight + width + 16 <= area.right) {
      left = regionRight + 12;
      top = regionTop;
    } else if (regionLeft - width - 16 >= area.left) {
      left = regionLeft - width - 12;
      top = regionTop;
    } else {
      // No room beside the region: sit under it, centred on it.
      left = regionLeft + ((regionRight - regionLeft) - width) / 2;
      top = regionBottom + 12;
    }
    element.style.left = `${clamp(left, area.left + 12, Math.max(area.left + 12, area.right - width - 12))}px`;
    element.style.top = `${clamp(top, 12, Math.max(12, stage.height - height - 12))}px`;
  }

  function closeBubble() {
    controller?.abort();
    controller = null;
    if (bubble) {
      bubble.hidden = true;
    }
  }

  // ---------- Asking ----------

  function promptFor(kind, found, hint) {
    const language = replyLanguageName();
    if (kind === "translate") {
      return [
        `Translate the text in this cropped part of page ${found.page.number} ${translationDirection(hint)}. Keep the meaning and formatting (paragraphs, lists). Return only the translation.`,
        hint ? `Extracted text, for reference:\n"""\n${hint.slice(0, 1500)}\n"""` : ""
      ].filter(Boolean).join("\n\n");
    }
    const what = found.kind === "area"
      ? "It may be a figure, chart, table, diagram or formula."
      : "It is a passage of text.";
    return [
      `Explain what is in this cropped part of page ${found.page.number} in plain words, in at most 120 words. ${what}`,
      "If it is a formula, say what it computes and what each symbol means. If it is a table or chart, say what it shows and the one key takeaway. If it is text, rephrase the main point simply and define any jargon.",
      `Answer in the language of the document's text (or ${language} if unsure). No preamble.`,
      hint ? `Extracted text, for reference:\n"""\n${hint.slice(0, 1500)}\n"""` : ""
    ].filter(Boolean).join("\n\n");
  }

  async function explain(found, kind = "explain", hint = found.text) {
    closeBubble();
    clearTimeout(dwellTimer);
    const element = ensureBubble();
    element.hidden = false;
    element.querySelector(".lens-kind").textContent = kind === "translate" ? t("Translation") : t("Explanation");
    const body = element.querySelector(".lens-body");
    body.innerHTML = `<div class="thinking"><i></i><i></i><i></i><span>${t("Looking…")}</span></div>`;
    placeBubble(found);

    bubbleContext = { page: found.page, box: found.box, text: hint, answer: "" };
    controller = new AbortController();
    const { signal } = controller;

    try {
      const { dataUrl } = await host.renderRegion(found.page.number, found.box, { pad: 6, longSide: 1000, forAssistant: true });
      signal.throwIfAborted();
      let answer = "";
      await quickAsk({
        image: dataUrl,
        prompt: promptFor(kind, found, hint),
        signal,
        onUpdate: text => {
          answer = text;
          bubbleContext.answer = text;
          body.innerHTML = renderMarkdown(text);
          placeBubble(found);
        }
      });
      if (!answer) {
        body.innerHTML = `<p><em>${t("No answer.")}</em></p>`;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      const paragraph = document.createElement("p");
      paragraph.className = "lens-error";
      paragraph.textContent = error.message || t("Couldn't explain this.");
      body.replaceChildren(paragraph);
      placeBubble(found);
    } finally {
      if (controller?.signal === signal) {
        controller = null;
      }
    }
  }

  // External entry points: from the selection popover or a reference card.
  function explainBox(pageNumber, box, text = "", kind = "explain") {
    const page = host.pages()[pageNumber - 1];
    if (!page) {
      return;
    }
    hideOutline();
    explain({ page, box, text, kind: text ? "paragraph" : "area" }, kind, text);
  }

  // ---------- Events ----------

  host.shell.addEventListener("pointermove", event => {
    pointer = { x: event.clientX, y: event.clientY };
    if (event.altKey && !altHeld) {
      setAlt(true);
    } else if (!event.altKey && altHeld) {
      setAlt(false);
    }
    if (altHeld) {
      track();
    }
  });

  host.shell.addEventListener("click", event => {
    if (!event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pointer = { x: event.clientX, y: event.clientY };
    locate(pointer.x, pointer.y).then(found => {
      if (found) {
        target = found;
        showOutline(found);
        explain(found, "explain");
      }
    });
  }, true);

  function setAlt(held) {
    altHeld = held;
    document.body.classList.toggle("lens-active", held);
    if (!held) {
      clearTimeout(dwellTimer);
      hideOutline();
      target = null;
    }
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Alt" && !altHeld) {
      setAlt(true);
      track();
    } else if (event.key === "Escape" && bubble && !bubble.hidden) {
      closeBubble();
    }
  });
  document.addEventListener("keyup", event => {
    if (event.key === "Alt") {
      setAlt(false);
    }
  });
  window.addEventListener("blur", () => setAlt(false));
  document.addEventListener("pointerdown", event => {
    if (bubble && !bubble.hidden && !bubble.contains(event.target) && !event.altKey) {
      closeBubble();
    }
  });

  function reset() {
    layoutCache.clear();
    closeBubble();
    hideOutline();
    target = null;
  }

  return { explainBox, reset, closeBubble };
}
