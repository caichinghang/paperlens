import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureAnnotationPages, restoreAnnotationPages } from "../src/annotation-history.js";
import { createImagePdfBuilder } from "../src/pdf-writer.js";
import { readSseJson } from "../src/sse.js";

const viewerSource = readFileSync(new URL("../src/viewer.js", import.meta.url), "utf8");
assert.match(viewerSource, /function resetViewer\(\) \{\s+flushFormEdits\(\);/);
assert.match(viewerSource, /pendingFormSave = \{ key: state\.docKey, values: Object\.fromEntries\(formEdits\) \}/);
assert.match(viewerSource, /window\.addEventListener\("pagehide"[\s\S]*flushFormEdits\(\);[\s\S]*assistant\.flush\(\);/);

// Undo snapshots copy only dirty pages and restore both their content and global order.
{
  const start = [
    { id: "a", page: 1, paths: [[1, 2, 3, 4]] },
    { id: "b", page: 2, text: "before" },
    { id: "c", page: 1, text: "last" }
  ];
  const saved = captureAnnotationPages(start, [1]);
  start[0].paths[0][0] = 99;
  const changed = [{ id: "b", page: 2, text: "still here" }, { id: "d", page: 1, text: "new" }];
  const restored = restoreAnnotationPages(changed, saved);
  assert.deepEqual(restored.map(item => item.id), ["a", "b", "c"]);
  assert.equal(restored[0].paths[0][0], 1);
  assert.equal(restored[1].text, "still here");
}

// A final SSE JSON event is not lost when the server closes without a trailing newline.
{
  const bytes = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.encode('data: {"part":1}\n'));
      controller.enqueue(bytes.encode('data: {"part":2}'));
      controller.close();
    }
  });
  const values = [];
  await readSseJson(stream, value => values.push(value.part));
  assert.deepEqual(values, [1, 2]);
}

// Image-only PDFs are assembled as Blob parts and have a valid xref pointer without a full-byte copy.
{
  const builder = createImagePdfBuilder(1, { title: "Private (copy)" });
  builder.addPage({ jpeg: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]), width: 612, height: 792, pixelWidth: 2, pixelHeight: 2 });
  const pdf = builder.finish();
  assert.equal(pdf.type, "application/pdf");
  const text = new TextDecoder("latin1").decode(await pdf.arrayBuffer());
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/Count 1/);
  const xrefOffset = Number(text.match(/startxref\n(\d+)/)?.[1]);
  assert.equal(text.slice(xrefOffset, xrefOffset + 4), "xref");
}

console.log("runtime safety checks passed");
