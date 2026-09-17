# PaperLens codebase audit

Date: 2026-09-17  
Scope: static source review only. No browser or live-extension testing was performed, and no functional source changes were made as part of this audit.

> Implementation update: the concrete fixes and cleanup items from this audit were implemented on
> `codex/codebase-audit-fixes` after the original review checkpoint. Static verification remains the
> boundary: no browser testing was added. Measurement-dependent product experiments (for example,
> aggressively shortening agent instructions) were not applied blindly; the safe local allocation,
> caching, page-payload and module-boundary improvements were implemented instead.

## Executive summary

The current tree is syntactically valid and its existing Node checks pass. The architecture is understandable for a framework-free extension, and several important performance choices are already good: visible-page rendering is queued, off-screen canvases and text layers are released, search and text extraction are cached, request images have a bounded cache, and most persistence writes are debounced.

The main risks are not syntax errors. They are lifecycle edges and work that scales with the whole document:

1. Form values can be written under the wrong document key, or removed, when a document is switched or a load fails during the 400 ms debounce window.
2. Failed loads leave the previous document identity and workspace/assistant state active even though the viewer has no document.
3. The AI web-reading tool can fetch arbitrary HTTP(S) targets, including local or private-network addresses and redirect destinations.
4. Chat, profile, and directly typed form changes are not all flushed on `pagehide`, so a quick reload or close can lose the latest edit.
5. Markup changes serialize the complete annotation set and redraw every page; dense markup and long PDFs will make this disproportionately expensive.
6. Redacted export holds every rendered page image in memory and then copies the data again while assembling the PDF.

I recommend fixing the correctness and data-safety items before doing cleanup-only refactors. Large refactors should be split into small commits with focused tests because the present automated suite mostly covers pure data helpers, not viewer lifecycle, persistence, or DOM-heavy markup code.

## Validation performed

- Read all first-party files in `src/`, `viewer.html`, `manifest.json`, the tests, and the current uncommitted diff.
- Checked every JavaScript and test file with `node --check`.
- Ran `node --test tests/*.mjs`: all 3 test files passed.
- Ran `git diff --check`: no whitespace errors.
- Searched the pending diff and new files for credential-like values; no committed API key or private key was found.
- Checked literal translation keys, CSS selectors with no source reference, duplicated parsers, timers, observers, caches, and persistence boundaries.

These are static checks, not proof that the extension is functionally correct in Chrome.

## Prioritized findings

### P1 — Form persistence can cross document boundaries or delete saved values

Evidence:

- `src/viewer.js:963-977` creates a delayed `write()` that reads the mutable global `state.docKey` and `formEdits` only when the timer fires.
- `src/viewer.js:338-370` clears `formEdits` during `resetViewer()` but does not flush or cancel `formPersistTimer` first.
- A document switch or failed load inside the 400 ms debounce window can therefore make the old timer write the new document's key, or remove the previous document's stored form data after the map has been cleared.

Affected functions: `persistFormEdits`, `syncFormEditsFromStorage`, `resetViewer`, `loadFromUrl`, `loadFromFile`, `openDocument`.

Recommendation:

- Capture `{ key, values }` when scheduling, like markup and workspace persistence already do.
- Flush the old document's pending form state before clearing it.
- Cancel any old timer during reset.
- Add a unit test using two document keys and a fake timer/storage adapter.

### P1 — A failed load retains stale document identity and side-panel state

Evidence:

- `resetViewer()` clears `state.doc`, pages, caches, and form indexes, but does not clear `state.docKey` or `state.fileName`.
- The assistant, workspace, and markup are switched only after a later `openDocument()` succeeds.
- If loading the new PDF fails, the viewer shows an empty state while the workspace can still represent the old document.

Affected functions: `resetViewer`, `showEmptyState`, `openDocument`, `assistant.setDocument`, `workspace.setDocument`, `markup.setDocument`.

Recommendation:

- Introduce one document-lifecycle transition that clears all four owners together: viewer, assistant, workspace, and markup.
- Separate `beginDocumentLoad`, `commitDocument`, and `clearDocument` so a failure cannot leave a mixed state.
- Preserve the old document only if that is an explicit product decision, and then keep it visibly mounted until replacement succeeds.

### P1 — Arbitrary web reads include private-network and redirect targets

Evidence:

- `src/web.js:164-207` accepts any `http:` or `https:` URL.
- `request()` follows redirects, and the final `response.url` is not checked against local, loopback, link-local, or private-network ranges.
- The extension has `<all_urls>` host access, and the model can call `read_webpage` while web tools are enabled.

Impact: a malicious document or webpage prompt could try to make the assistant read an unauthenticated local service, router page, or metadata endpoint and return the result to the model. `credentials: "omit"` helps but does not eliminate this class of exposure.

Affected functions: `request`, `readWebpage`, `searchWeb`, `createAgentTools.run("read_webpage")`.

Recommendation:

- Reject localhost, loopback, link-local, private IPv4/IPv6 ranges, and suspicious numeric host forms before the request.
- Validate every redirect destination, including `response.url`.
- Prefer restricting `read_webpage` to URLs returned by the current search operation or explicitly supplied by the reader.
- Add URL-policy tests, including redirect cases.

### P1 — Some debounced user state is not flushed when the page closes

Evidence:

- `src/viewer.js:3289-3292` flushes markup and notebook data on `pagehide` only.
- `createWorkspace.flush()` does not flush `profileTimer`.
- The assistant's `flushChats()` is private and is not called on `pagehide`.
- Direct form typing is not forced through `persistFormEdits({ immediate: true })` on `pagehide`.
- A user prompt is not persisted when it is appended; persistence waits until the agent finishes. Closing during a long request can lose the latest question.

Affected functions: `saveProfile`, `flush`, `saveChats`, `flushChats`, `send`, `persistFormEdits`, the viewer `pagehide` handler.

Recommendation:

- Give assistant and workspace one public `flush()` each that includes every owned timer.
- Persist a user message immediately before starting the network request.
- On `pagehide`, synchronously schedule all storage API writes without waiting for network work.
- Keep streaming assistant output excluded if partial replies should not be restored, but do not exclude the user's submitted message.

### P1 — Redacted export has document-sized peak memory with multiple copies

Evidence:

- `flattenToImagePdf()` renders every page, converts it to a JPEG data URL, decodes it to a `Uint8Array`, and retains every JPEG in `pages`.
- `buildImagePdf()` then creates object chunks and finally concatenates them into another complete `Uint8Array`.
- `canvas.toDataURL()` and `atob()` add large intermediate string and byte copies.

Affected functions: `flattenToImagePdf`, `dataUrlToBytes`, `buildImagePdf`, `downloadPdf`.

Impact: long or image-heavy documents can exhaust the extension renderer's memory during a safety-critical redacted export.

Recommendation:

- Use `canvas.toBlob()` rather than data URLs.
- Build a `Blob` from ordered PDF parts instead of repeatedly concatenating all bytes.
- Release each page canvas and temporary JPEG as soon as its PDF object parts are queued.
- Consider a page-count/estimated-size warning or adaptive DPI for very large files.

### P2 — Markup history and rendering scale with all annotations and all pages

Evidence:

- `src/markup.js:385-407` serializes every annotation before a mutation and serializes them all again to detect a change.
- Up to `HISTORY_LIMIT` complete JSON snapshots are retained.
- `changed()` calls `renderAll()`, and `renderAll()` calls `renderPage()` for every page.
- Each `renderPage()` loops over the complete annotation array to find that page's items.
- The eraser scans annotations on every coalesced pointer sample and may densify long paths.

Affected functions: `snapshot`, `commit`, `pushHistory`, `changed`, `renderAll`, `renderPage`, `eraseAlong`, `startErasing`.

Recommendation:

- Maintain an annotation index by page.
- Pass a set of dirty page numbers through `commit()` and redraw only those pages.
- Replace full-history snapshots with reversible operations or, as an intermediate step, page-scoped snapshots.
- Throttle eraser redraws to one animation frame and scan only the active page's erasable items.
- Measure memory and edit latency with dense ink before choosing the final history design.

### P2 — Long documents are only partially virtualized

Evidence:

- `openDocument()` creates a shell, thumbnail, and three markup-layer elements for every page.
- `loadPageSizes()` eagerly calls `getPage()` for every page and retains the proxy in `page.pdfPage`.
- `releasePage()` removes the large canvas and text/link DOM, which is good, but it does not release `pdfPage`, annotation promises, page rules, or base shell/markup DOM.
- The comment that a 500-page document costs about as much as a 10-page document is therefore too strong.

Affected functions: `openDocument`, `createPage`, `loadPageSizes`, `markup.attachPage`, `releasePage`.

Recommendation:

- Keep lightweight placeholders for every page, but load page proxies and exact sizes in a bounded window around the viewport.
- Attach markup surfaces when a page becomes near and detach them when released.
- Decide which derived caches should survive page release and place explicit byte/count limits on them.

### P2 — Failed page/form rendering does not reliably retry

Evidence:

- A non-cancellation error sets `page.failedScale`; `nextPageToRender()` skips that scale, and `releasePage()` does not clear `failedScale`. The comment says scrolling should retry, but it will not retry at the same zoom.
- `ensureFormLayer()` sets `formLayerStarted = true` before awaiting work. On failure no form layer exists, and `releasePage()` calls `rebuildFormLayer()` only when `page.formLayer` exists, so that page may never retry its form layer.

Affected functions: `renderPage`, `nextPageToRender`, `releasePage`, `ensureFormLayer`, `rebuildFormLayer`.

Recommendation:

- Reset retry flags after release or use a bounded retry count/backoff.
- Set `formLayerStarted = false` in the failure path and remove any partially created layer.

### P2 — Custom OpenAI-compatible endpoints may reject DeepSeek-specific request fields

Evidence:

- `requestTurn()` adds `stream_options: { include_usage: true }` for every provider.
- DeepSeek-only `thinking` is correctly conditional, but `stream_options` is not.
- The README promises any OpenAI-compatible endpoint; compatibility varies for this optional field.

Affected function: `requestTurn`.

Recommendation:

- Add provider capability flags or retry once without optional fields after a clear 400/422 unsupported-parameter response.
- Process the remaining SSE buffer at EOF so a final usage event without a trailing newline is not dropped.

### P2 — Reference resolution can scan the whole document repeatedly

Evidence:

- `references.findItem()` walks pages sequentially until it finds a target.
- `pagesNear()` sorts a copy of all pages on each lookup.
- Citations scan from the end; figures, tables, equations, and sections may scan most pages from the current location.
- Text is cached, but the first lookup on a long document can still force whole-document extraction.

Affected functions: `pagesNear`, `findItem`, `resolve`, `paragraphBlocks`.

Recommendation:

- Build a lazy per-document index for captions, numbered headings, equations, and bibliography entries during idle time or the first lookup.
- Cache resolved `(kind, number)` targets.
- Share this index with document search and heading extraction where practical.

### P2 — PDF-link interception changes normal link behavior

Evidence:

- `src/content.js:16-38` ignores `target="_blank"` and `download` attributes.
- An unmodified click is always prevented and replaced with `window.location.assign`, so a PDF link intended for a new tab or download opens in the current tab.

Affected functions: content-script click handler and `openInViewer`.

Recommendation:

- Respect `link.target`, `link.download`, and possibly `rel="external"`.
- Use `chrome.runtime.sendMessage` to ask the service worker to create a viewer tab when the link requests a new browsing context.

### P3 — The AI image cache can retain many old revisions

Evidence:

- The cache is capped at 40 entries, but each entry can be a large base64 page image.
- The cache key includes `contentRevision`, so every markup/form change creates a new entry rather than replacing the previous image for that page.

Affected functions: `cached`, `pageImage`, `regionImage`.

Recommendation:

- Evict older revisions of the same page/region immediately.
- Prefer a byte budget over an entry-count budget.
- Revoke/clear generated resources if the representation changes from data URLs to blobs.

### P3 — Search results are unbounded

Evidence:

- Viewer search records every occurrence across every page with no maximum.
- A one-character query in a long PDF can create a very large array and expensive highlighting work.

Affected functions: `runSearch`, `applySearchHighlights`, `updateSearchCount`.

Recommendation:

- Set a high but finite result cap and report `N+` when truncated.
- Optionally delay full-document search for one-character queries.

### P3 — Pointer cancellation can leave markup dragging active

Evidence:

- Markup dragging registers `pointermove` and a one-shot `pointerup`, but no `pointercancel` handler.
- A cancelled pointer can leave `dragging` and the global move listener alive until another pointer-up event.

Affected functions: the delegated markup `pointerdown`, `dragMove`, `dragEnd`.

Recommendation: register `pointercancel` with the same cleanup path and remove both terminal listeners in `dragEnd`.

## Safe cleanup candidates

These are small, low-risk deletions or consolidations. They should still be made in a separate cleanup commit after the P1 fixes.

### Exact duplicate work

- `src/workspace.js:1279-1288`: `markupChanged()` calls `syncHighlights()` twice when the notes tab is visible. Delete the second call.
- `src/i18n.js:114` and `src/i18n.js:427`: the literal key `"Page number"` appears twice with the same value. Keep one.

### Exact duplicated functions

- `parseFlashcards()` and `parseCsv()` are effectively duplicated in `src/blocks.js` and `src/ai.js`. Import the existing exports from `blocks.js` into `ai.js`.
- Table row splitting is also duplicated, but the chat renderer and notebook parser have different responsibilities. Extract it only if a shared module can stay DOM-free and has tests for both callers.

### Unused JavaScript

- `src/pricing.js:19-21`: `hasPricing()` has no caller in source or tests. Delete it unless it is intentionally public API.

### Confirmed stale CSS

The following selectors have no matching class or dynamic construction in current HTML/JavaScript:

- `.ai-empty-chips` and its button variants.
- `.msg .cite-extra`.
- `.ws-head`, `.ws-head-text`, `.ws-head h1`, `.ws-head p`.
- `.nb-muted`, `.nb-highlights`, and `.nb-highlight` variants.
- Legacy `.checklist`, `.check-toggle`, `.check-icon`, and `.check-text` selectors. Keep `.check-jump`, which is still used by redaction cards.

Delete complete unused blocks, not individual properties, and rerun the selector scan afterward.

### Source-file hygiene

- `src/ai.js` contains literal NUL characters as temporary inline-code sentinels. Runtime behavior works, but common tools treat the file as binary (`rg` does this now). Replace them with an escaped/private-use sentinel or a tokenization approach that cannot collide with user text.
- The translation map is missing literal keys for `Add` and `Create`, so those controls fall back to English in the Chinese interface.

### Manifest cleanup

- `frame-src 'self' blob: data: http://* https://*` appears unused because the extension does not create frames. Remove it if a final static check confirms PDF.js does not depend on it.
- Do not remove `<all_urls>`, `webRequest`, or the content script casually: they support arbitrary remote PDFs and web tools. Reducing those permissions is a product/security redesign, not a line cleanup.

## Structural improvements

The largest files are `viewer.css` (6,147 lines), `viewer.js` (3,330), `ai.js` (3,034), `markup.js` (2,289), and `editor.js` (1,828). File size alone is not a runtime problem, but it makes ownership and testing harder.

Recommended boundaries:

- Move the AI Markdown renderer and block-card registry out of `ai.js`; keep the conversation/controller and request loop there.
- Move the agent-host functions (`agent*`, page-grid conversion, page-image generation) out of `viewer.js` behind an explicit host factory.
- Split markup into annotation data/history, page rendering, pointer tools, and PDF serialization. Start with data/history because it needs the performance fix.
- Split CSS by the same stable surfaces: reader, assistant, markup, workspace, block editor, responsive overrides. Preserve load order explicitly.
- Keep tiny helpers such as `clamp`, `round`, and domain-specific `escapeHtml` local unless consolidation removes real duplicated behavior. A generic utility file for every two-line helper would increase coupling without improving performance.

## Efficiency improvements that need measurement

- `agentGetHeadingCandidates()` and whole-document form listing process pages sequentially. Bounded concurrency (for example 3–4 pages) could reduce latency, but should be measured because PDF.js work is CPU- and memory-heavy.
- The system prompt and full tool schemas are sent again at every agent step. Shortening tool descriptions and scenario guidance could reduce tokens and latency, but token-usage data should be collected first so clarity is not traded away blindly.
- The live page-number metadata is now always preserved, while simple greetings, thanks, and “what page am I on?” questions skip the page image. Page-relative requests still attach the current page automatically. Broader intent classification should only be expanded after measuring cost and accuracy.
- `compileSecrets()` recompiles every private-value regular expression for each request and assistant image. Cache compiled patterns until the profile changes if profiles with many private fields show measurable overhead.

## Test gaps

Current tests cover Markdown/block conversion, outline movement, profile helpers, privacy masking, rules, headings, pricing, Markdown rendering, and current-page selection. They do not exercise the highest-risk findings above.

Add focused, non-browser tests for:

1. Persistence ownership across document A → document B transitions.
2. `pagehide` flushing of chats, profile fields, forms, workspace, and markup.
3. Failed-load clearing and successful-load commit ordering.
4. Private/local URL blocking and redirects in `web.js` with a mocked `fetch`.
5. Markup history operations and dirty-page calculation without DOM rendering.
6. Provider request-body capabilities and SSE final-buffer parsing.
7. Retry-state transitions for page, text, link, and form layers.
8. Content-script behavior for `_blank`, modifier keys, and download links.

## Recommended implementation order

1. **Data safety:** form debounce ownership, all flush paths, document lifecycle reset.
2. **Security:** web URL policy and redirect validation.
3. **Reliability:** retry flags, provider compatibility, pointer cancellation.
4. **Performance:** page-scoped markup index/history/rendering, then redacted-export memory.
5. **Long-document work:** lazy page proxies, reference index, bounded search results.
6. **Cleanup:** duplicate parsers, dead CSS/exports, NUL sentinel, translation map.
7. **Module split:** only after the behavior above has focused tests.

## Current-state conclusion

The current state is suitable to commit as a reviewable checkpoint: syntax checks and the existing test suite pass, and no credential material was found in the pending changes. It should not be treated as a fully validated release yet. The first follow-up should address persistence ownership and document reset behavior before performance refactoring.
