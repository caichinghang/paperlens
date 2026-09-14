// Tools the AI assistant can call. Definitions follow the OpenAI / DeepSeek function-calling format;
// every coordinate is on a 0–1000 grid over the page as displayed (x from the left, y from the top).

const COLOR_NAMES = {
  yellow: "#fcc419",
  green: "#51cf66",
  blue: "#4dabf7",
  pink: "#f783ac",
  red: "#e03131",
  black: "#1f1f1f",
  white: "#ffffff"
};
const MAX_VIEW_PAGES = 6;
const MAX_LISTED_FIELDS = 150;
const MAX_REPORT_ITEMS = 60;
const EDIT_TOOLS = new Set(["fill_form_fields", "add_text", "add_text_layer", "highlight_text", "draw_shape", "delete_markup", "propose_redactions"]);
const SHAPE_LABELS = { rectangle: "a rectangle", oval: "an oval", line: "a line", arrow: "an arrow", check: "a check mark", cross: "a cross" };

const pageParam = { type: "integer", minimum: 1, description: "Page number (1-based)." };
const pageListParam = description => ({ type: "array", items: { type: "integer", minimum: 1 }, description });
const gridParam = description => ({ type: "number", minimum: 0, maximum: 1000, description });
const colorParam = { type: "string", description: "Optional: yellow, green, blue, pink, red, black, or a #rrggbb color." };
const boxParams = {
  x1: gridParam("Left edge."),
  y1: gridParam("Top edge."),
  x2: gridParam("Right edge."),
  y2: gridParam("Bottom edge.")
};

const DEFINITIONS = [
  {
    name: "view_pages",
    description: `Look at pages of the PDF. They arrive in the next message (as images with a faint blue 0–1000 grid, or as text when images are off), including any markup and form values added so far. Use this before answering about or editing a page you haven't seen, and after editing to check your work. At most ${MAX_VIEW_PAGES} pages per call.`,
    parameters: {
      type: "object",
      properties: { pages: pageListParam("Page numbers to view.") },
      required: ["pages"]
    }
  },
  {
    name: "view_region",
    description: "Look closely at one rectangle of a page: a formula, table, chart or dense paragraph. A zoomed crop (with the same 0–1000 grid labels) arrives in the next message. Cheaper and sharper than viewing the whole page.",
    parameters: {
      type: "object",
      properties: { page: pageParam, ...boxParams },
      required: ["page", "x1", "y1", "x2", "y2"]
    }
  },
  {
    name: "search_document",
    description: "Find where a word or phrase appears anywhere in the document (case-insensitive). Returns page numbers with short snippets, so you can jump straight to the right pages instead of reading everything.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Word or phrase to look for." },
        limit: { type: "integer", minimum: 1, maximum: 60, description: "Maximum results (default 30)." }
      },
      required: ["text"]
    }
  },
  {
    name: "get_outline",
    description: "Get the document's table of contents (bookmarks) with page numbers, when the PDF has one. Use it to understand the structure of a long document before diving in.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "set_outline",
    description: "Give the reader a table of contents in the sidebar when the PDF has none: one entry per heading with its page and depth (0 for chapters or top-level sections, 1 for subsections, 2 deeper). Keep titles as printed. Replaces any outline you set before.",
    parameters: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              page: pageParam,
              depth: { type: "integer", minimum: 0, maximum: 5 }
            },
            required: ["title", "page"]
          }
        }
      },
      required: ["entries"]
    }
  },
  {
    name: "get_page_layout",
    description: "Get the text of a page split into blocks (paragraphs, headings, captions, table rows) with each block's box on the 0–1000 grid and its font size. Use it to place translations or notes exactly over or beside the original text, or to find figures (gaps between blocks).",
    parameters: {
      type: "object",
      properties: { page: pageParam },
      required: ["page"]
    }
  },
  {
    name: "find_text",
    description: "Find exact text on a page using the PDF's text layer (case-insensitive). Returns each match's box {x, y, w, h} on the 0–1000 grid. Use it to locate labels precisely before adding text next to them.",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        text: { type: "string", description: "Exact text to look for, e.g. a label such as \"Date of birth\"." }
      },
      required: ["page", "text"]
    }
  },
  {
    name: "list_form_fields",
    description: "List the PDF's real fillable form fields (text boxes, checkboxes, radio buttons, dropdowns) with id, label, type, current value, options and box on the 0–1000 grid. Check this before filling or reviewing a form: when fields exist, use fill_form_fields instead of adding free text.",
    parameters: {
      type: "object",
      properties: { pages: pageListParam("Optional page numbers; omit to list the whole document.") }
    }
  },
  {
    name: "fill_form_fields",
    description: "Set the values of real form fields returned by list_form_fields. Text fields take text; checkboxes and radio buttons take \"true\" or \"false\"; dropdowns take one of the listed options. The reader can also edit these fields directly afterwards.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Field id from list_form_fields." },
              value: { type: "string" }
            },
            required: ["id", "value"]
          }
        }
      },
      required: ["fields"]
    }
  },
  {
    name: "add_text",
    description: "Add a text box to a page, for example to fill in a form that has no real fields, or to leave a note. (x, y) is the top-left corner on the 0–1000 grid. To answer next to a label, use the label's y and an x just past its right edge; to write on a blank line, put y a little above the line so the text sits on it. Use \\n for more lines. The reader can click the box later to edit or move it.",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        x: gridParam("Left edge of the text."),
        y: gridParam("Top edge of the text."),
        text: { type: "string" },
        font_size: { type: "number", minimum: 6, maximum: 48, description: "Font size in points (default 11). Match nearby printed text." },
        width: gridParam("Optional width on the grid; longer text wraps inside it."),
        color: colorParam
      },
      required: ["page", "x", "y", "text"]
    }
  },
  {
    name: "add_text_layer",
    description: "Lay text over a page as a named layer the reader can switch on and off, keeping the layout: the main use is translating a page in place. Give one item per block from get_page_layout with the block's box (x, y, w, h) and the replacement text; each item is drawn on a white background sized to its box, with the font shrunk to fit. Do a whole page in one call.",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        layer: { type: "string", description: "Layer name, e.g. \"translation\" (default)." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              x: gridParam("Left edge of the box."),
              y: gridParam("Top edge of the box."),
              w: gridParam("Width of the box."),
              h: gridParam("Height of the box."),
              text: { type: "string" },
              font_size: { type: "number", minimum: 5, maximum: 48, description: "Optional starting font size in points (the original block's size)." }
            },
            required: ["x", "y", "w", "h", "text"]
          }
        }
      },
      required: ["page", "items"]
    }
  },
  {
    name: "highlight_text",
    description: "Highlight, underline or strike through existing text on a page, found by its exact wording in the text layer.",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        text: { type: "string", description: "Exact phrase or sentence from the page." },
        style: { type: "string", enum: ["highlight", "underline", "strike"] },
        occurrence: { type: "integer", minimum: 1, description: "Which match to mark when the text appears more than once; omit to mark every match." },
        color: colorParam
      },
      required: ["page", "text"]
    }
  },
  {
    name: "draw_shape",
    description: "Draw on a page inside the box (x1, y1)–(x2, y2) on the 0–1000 grid: a rectangle or oval, a line or arrow from (x1, y1) to (x2, y2), or a check / cross mark (for tick boxes that aren't real form fields).",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        shape: { type: "string", enum: ["rectangle", "oval", "line", "arrow", "check", "cross"] },
        ...boxParams,
        color: colorParam,
        width: { type: "number", minimum: 0.5, maximum: 8, description: "Line width in points (default 2)." }
      },
      required: ["page", "shape", "x1", "y1", "x2", "y2"]
    }
  },
  {
    name: "list_markup",
    description: "List markup currently on the PDF (highlights with their text, text boxes, drawings, layers, proposed redactions) with ids and boxes on the 0–1000 grid. Highlights are the reader's own notes: use them for study notes and quizzes.",
    parameters: {
      type: "object",
      properties: { page: { ...pageParam, description: "Optional page number; omit for every page." } }
    }
  },
  {
    name: "delete_markup",
    description: "Delete markup by id (from list_markup, or ids returned by your own edits), e.g. to fix a misplaced text box.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"]
    }
  },
  {
    name: "report_items",
    description: "Show the reader a checklist of findings, each with a page and optionally the box it refers to, so they can click to jump there. Use it for form reviews (empty required fields, wrong date formats, missing signatures, contradictory ticks), extracted facts (dates, amounts, parties) or issues found while reading. Call it once with every item, then summarise briefly in text.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. \"Form review\" or \"Key dates\"." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "One line describing the finding." },
              page: pageParam,
              severity: { type: "string", enum: ["error", "warning", "info", "ok"], description: "How serious it is (default info)." },
              ...boxParams
            },
            required: ["text", "page"]
          }
        }
      },
      required: ["title", "items"]
    }
  },
  {
    name: "propose_redactions",
    description: "Propose black boxes over personal or sensitive information (ID numbers, phone numbers, emails, addresses, signatures, names). They appear as dashed red boxes the reader must approve; approved boxes become solid black and the download removes the text underneath. Use find_text and get_page_layout to get exact boxes; pad them slightly.",
    parameters: {
      type: "object",
      properties: {
        page: pageParam,
        boxes: {
          type: "array",
          items: {
            type: "object",
            properties: { ...boxParams, reason: { type: "string", description: "What it hides, e.g. \"phone number\"." } },
            required: ["x1", "y1", "x2", "y2"]
          }
        }
      },
      required: ["page", "boxes"]
    }
  },
  {
    name: "go_to_page",
    description: "Scroll the reader's view to a page so they can see it.",
    parameters: {
      type: "object",
      properties: { page: pageParam },
      required: ["page"]
    }
  }
];

// Shown in the chat while a tool runs; replaced by the tool's summary when it finishes.
export const TOOL_LABELS = {
  view_pages: "Looking at pages…",
  view_region: "Looking closer…",
  search_document: "Searching the document…",
  get_outline: "Reading the table of contents…",
  set_outline: "Building the table of contents…",
  get_page_layout: "Reading the page layout…",
  find_text: "Finding text…",
  list_form_fields: "Reading form fields…",
  fill_form_fields: "Filling in the form…",
  add_text: "Adding text…",
  add_text_layer: "Laying out the layer…",
  highlight_text: "Marking text…",
  draw_shape: "Drawing…",
  list_markup: "Checking markup…",
  delete_markup: "Removing markup…",
  report_items: "Building the checklist…",
  propose_redactions: "Proposing redactions…",
  go_to_page: "Opening page…"
};

export function formatPages(pages) {
  const ranges = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && page === last[1] + 1) {
      last[1] = page;
    } else {
      ranges.push([page, page]);
    }
  }
  const text = ranges.map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`)).join(", ");
  return `${pages.length === 1 ? "p." : "pp."} ${text}`;
}

function resolveColor(value) {
  const key = String(value || "").trim().toLowerCase();
  if (COLOR_NAMES[key]) {
    return COLOR_NAMES[key];
  }
  return /^#[0-9a-f]{6}$/.test(key) ? key : undefined;
}

function quoted(text, max = 40) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function pageNumbers(value) {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(list.map(Number).filter(Number.isInteger))];
}

function gridBox(args) {
  const box = { x1: Number(args.x1), y1: Number(args.y1), x2: Number(args.x2), y2: Number(args.y2) };
  if (Object.values(box).some(value => !Number.isFinite(value))) {
    return null;
  }
  return box;
}

export function createAgentTools(host) {
  function definitions(allowEdits) {
    return DEFINITIONS
      .filter(definition => allowEdits || !EDIT_TOOLS.has(definition.name))
      .map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
  }

  // Returns { result, summary, attachPages?, attachRegions?, card?, undo? }; throws with a message the model can act on.
  async function execute(name, args, { allowEdits }) {
    if (EDIT_TOOLS.has(name) && !allowEdits) {
      throw new Error("Editing is turned off in the assistant's settings.");
    }

    switch (name) {
      case "view_pages": {
        const pages = pageNumbers(args.pages).slice(0, MAX_VIEW_PAGES);
        if (!pages.length) {
          throw new Error("Pass at least one page number.");
        }
        return { result: { ok: true, pages, note: "The pages follow in the next message." }, attachPages: pages, summary: `Looked at ${formatPages(pages)}` };
      }

      case "view_region": {
        const box = gridBox(args);
        if (!box) {
          throw new Error("Pass page, x1, y1, x2 and y2.");
        }
        const page = Number(args.page);
        return {
          result: { ok: true, note: "The crop follows in the next message." },
          attachRegions: [{ page, box, label: `Page ${page}, region (${Math.round(box.x1)},${Math.round(box.y1)})–(${Math.round(box.x2)},${Math.round(box.y2)})` }],
          summary: `Looked closer at p. ${page}`
        };
      }

      case "search_document": {
        const results = await host.searchDocument(args.text, Math.min(Number(args.limit) || 30, 60));
        const pages = [...new Set(results.map(item => item.page))];
        return {
          result: { matches: results, note: results.length ? undefined : "No matches; try a shorter or different phrase." },
          summary: results.length ? `Found ${quoted(args.text)} on ${formatPages(pages)}` : `No matches for ${quoted(args.text)}`
        };
      }

      case "get_outline": {
        const entries = await host.getOutline();
        return {
          result: { outline: entries, note: entries.length ? undefined : "This PDF has no bookmarks; use search_document or view_pages instead." },
          summary: entries.length ? `Read ${plural(entries.length, "outline entry").replace("entrys", "entries")}` : "No table of contents"
        };
      }

      case "set_outline": {
        const count = host.setOutline(args.entries);
        return { result: { ok: true, entries: count, note: "The outline is now in the sidebar." }, summary: `Built a table of contents with ${plural(count, "entry").replace("entrys", "entries")}` };
      }

      case "get_page_layout": {
        const blocks = await host.getPageLayout(args.page);
        return {
          result: { page: Number(args.page), blocks, note: blocks.length ? undefined : "No text layer on this page (it may be scanned)." },
          summary: `Read ${plural(blocks.length, "text block")} on p. ${args.page}`
        };
      }

      case "find_text": {
        const found = await host.findText(args.page, args.text);
        const result = found.hasTextLayer
          ? { page: found.page, matches: found.matches }
          : { page: found.page, matches: [], note: "This page has no text layer (it may be scanned). Work from the page image instead." };
        return { result, summary: `Found ${plural(found.matches.length, "match")} for ${quoted(args.text)} on p. ${found.page}` };
      }

      case "list_form_fields": {
        const pages = pageNumbers(args.pages);
        const fields = await host.listFormFields(pages.length ? pages : undefined);
        if (!fields.length) {
          return {
            result: { fields: [], note: "No fillable form fields. Place answers with add_text, and use draw_shape \"check\" for tick boxes." },
            summary: "No fillable form fields found"
          };
        }
        return {
          result: { fields: fields.slice(0, MAX_LISTED_FIELDS), truncated: fields.length > MAX_LISTED_FIELDS },
          summary: `Found ${plural(fields.length, "form field")}`
        };
      }

      case "fill_form_fields": {
        const entries = Array.isArray(args.fields) ? args.fields : [];
        if (!entries.length) {
          throw new Error("Pass the fields to fill as [{id, value}].");
        }
        const { filled, errors, undo } = await host.fillFormFields(entries);
        if (!filled.length) {
          throw new Error(errors.join("; ") || "Nothing was filled.");
        }
        return { result: { filled: filled.length, errors }, summary: `Filled ${plural(filled.length, "form field")}`, undo };
      }

      case "add_text": {
        const id = host.addText({
          page: args.page,
          x: args.x,
          y: args.y,
          text: args.text,
          fontSize: args.font_size,
          width: args.width,
          color: resolveColor(args.color)
        });
        return { result: { id }, summary: `Added ${quoted(args.text)} on p. ${args.page}`, undo: () => host.deleteMarkup([id]) };
      }

      case "add_text_layer": {
        const layer = String(args.layer || "translation").trim().toLowerCase() || "translation";
        const ids = host.addTextLayer({ page: args.page, layer, items: args.items });
        return {
          result: { ids, layer, note: `The reader can toggle the "${layer}" layer from the pill at the bottom left of the page.` },
          summary: `Added ${plural(ids.length, "block")} to the ${layer} layer on p. ${args.page}`,
          undo: () => host.deleteMarkup(ids)
        };
      }

      case "highlight_text": {
        const { ids, count, total } = await host.highlightText({
          page: args.page,
          text: args.text,
          style: args.style,
          occurrence: args.occurrence,
          color: resolveColor(args.color)
        });
        const verb = { underline: "Underlined", strike: "Struck through" }[args.style] || "Highlighted";
        return {
          result: { ids, marked: count, matchesOnPage: total },
          summary: `${verb} ${quoted(args.text)} on p. ${args.page}`,
          undo: () => host.deleteMarkup(ids)
        };
      }

      case "draw_shape": {
        const id = host.drawShape({
          page: args.page,
          shape: args.shape,
          x1: args.x1,
          y1: args.y1,
          x2: args.x2,
          y2: args.y2,
          width: args.width,
          color: resolveColor(args.color)
        });
        return { result: { id }, summary: `Drew ${SHAPE_LABELS[args.shape] || "a shape"} on p. ${args.page}`, undo: () => host.deleteMarkup([id]) };
      }

      case "list_markup": {
        const markup = host.listMarkup(args.page);
        return { result: { markup }, summary: `Checked markup${args.page ? ` on p. ${args.page}` : ""}` };
      }

      case "delete_markup": {
        const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
        const deleted = host.deleteMarkup(ids);
        return { result: { deleted }, summary: `Removed ${plural(deleted, "markup item")}` };
      }

      case "report_items": {
        const items = (Array.isArray(args.items) ? args.items : [])
          .filter(item => item && item.text && Number.isInteger(Number(item.page)))
          .slice(0, MAX_REPORT_ITEMS)
          .map(item => ({
            text: String(item.text).slice(0, 300),
            page: Number(item.page),
            severity: ["error", "warning", "info", "ok"].includes(item.severity) ? item.severity : "info",
            box: gridBox(item)
          }));
        if (!items.length) {
          throw new Error("Pass at least one item with text and page.");
        }
        const title = String(args.title || "Findings").slice(0, 80);
        return {
          result: { ok: true, shown: items.length, note: "The checklist is shown to the reader; keep your text summary short." },
          summary: `${title}: ${plural(items.length, "item")}`,
          card: { type: "checklist", title, items }
        };
      }

      case "propose_redactions": {
        const boxes = (Array.isArray(args.boxes) ? args.boxes : []).map(item => ({ ...gridBox(item), reason: item.reason })).filter(item => Number.isFinite(item.x1));
        if (!boxes.length) {
          throw new Error("Pass at least one box.");
        }
        const ids = host.proposeRedactions({ page: args.page, boxes });
        return {
          result: { ids, note: "Shown to the reader as proposals; they approve or reject them. Don't approve on their behalf." },
          summary: `Proposed ${plural(ids.length, "redaction")} on p. ${args.page}`,
          card: { type: "redactions", page: Number(args.page), ids, items: boxes.map((box, index) => ({ id: ids[index], reason: box.reason || "Sensitive text", box })) },
          undo: () => host.deleteMarkup(ids)
        };
      }

      case "go_to_page": {
        host.goToPage(args.page);
        return { result: { ok: true }, summary: `Opened p. ${args.page}` };
      }

      default:
        throw new Error(`Unknown tool "${name}".`);
    }
  }

  return { definitions, execute };
}
