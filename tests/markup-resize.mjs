import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Pull the pure geometry helpers out of markup.js (the module itself needs a DOM).
const source = readFileSync(new URL("../src/markup.js", import.meta.url), "utf8");
const grab = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const code = [
  "const round = value => Math.round(value * 100) / 100;",
  "const clamp = (value, min, max) => Math.min(max, Math.max(min, value));",
  'const SHAPE_TYPES = new Set(["rect", "ellipse", "arrow", "line"]);',
  grab("function getBounds(", "function smoothPath("),
  grab("const MIN_SHAPE_SIZE", "export function createMarkup"),
  "function measureText() { return { width: 0, height: 0 }; }"
].join("\n");
const context = vm.createContext({});
vm.runInContext(`${code}\nthis.resize = resizeAnnotation; this.handles = handlePoints; this.resizable = isResizable;`, context);
const { resize, handles, resizable } = context;
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const clone = value => JSON.parse(JSON.stringify(value));

// Rectangle: dragging the se corner keeps the nw corner fixed; too small a drag is held at the minimum.
const rect = { type: "rect", x1: 10, y1: 20, x2: 110, y2: 70, width: 2 };
let next = clone(rect);
resize(next, rect, "se", { x: 210, y: 120 });
same([next.x1, next.y1, next.x2, next.y2], [10, 20, 210, 120]);
resize(next, rect, "nw", { x: 109, y: 69 });
same([next.x1, next.y1, next.x2, next.y2], [110, 70, 106, 66]);
same(handles(rect).map(h => h.key), ["nw", "ne", "se", "sw"]);

// Line: each end moves on its own.
const line = { type: "line", x1: 0, y1: 0, x2: 50, y2: 50, width: 2 };
next = clone(line);
resize(next, line, "p2", { x: 80, y: 10 });
same([next.x1, next.y1, next.x2, next.y2], [0, 0, 80, 10]);
same(handles(line).map(h => h.key), ["p1", "p2"]);

// Signature: scales about the opposite corner, keeps proportions and thickens the pen with it.
const signature = { type: "ink", kind: "signature", width: 1.4, paths: [[100, 100, 140, 120, 200, 100]] };
next = clone(signature);
resize(next, signature, "se", { x: 300, y: 110 });
assert.equal(next.paths[0][0], 100);
assert.equal(next.paths[0][1], 100);
assert.equal(next.paths[0][4], 300);
assert.equal(next.paths[0][3], 140);
assert.equal(next.width, 2.8);
resize(next, signature, "se", { x: 101, y: 101 });
assert.equal(Math.round(next.paths[0][4] - next.paths[0][0]), 16, "never smaller than the minimum width");
assert.equal(resizable(signature), true);
assert.equal(resizable({ type: "ink", paths: [] }), false);
assert.equal(resizable({ type: "text" }), false);
console.log("markup resize checks passed");
