import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");
const section = source.slice(source.indexOf("function parseMentions"), source.indexOf("function rangeLabel"));
const context = vm.createContext({ MENTION_PATTERN: /(^|\s)@(\d+)(?:\s*[-–]\s*(\d+))?(?=$|[\s.,;:!?)])/g });
vm.runInContext(section, context);

const resolve = (text, pageCount, currentPage, attached = [], hasRegions = false) =>
  vm.runInContext(`resolveTurnPages(${JSON.stringify(text)}, ${pageCount}, ${currentPage}, ${JSON.stringify(attached)}, ${hasRegions})`, context);

assert.deepEqual([...resolve("hi", 80, 59).pages], [59], "the live page is attached when the message has no page mention");
assert.equal(resolve("hi", 80, 59).implicit, true);
assert.deepEqual([...resolve("look at @15", 80, 59).pages], [15], "a new explicit mention overrides the implicit page attachment");
assert.equal(resolve("look at @15", 80, 59).implicit, false);
assert.deepEqual([...resolve("look at @999", 80, 59).pages], [], "an invalid explicit page does not silently become the current page");
assert.deepEqual([...resolve("compare these", 80, 59, [12, 13]).pages], [12, 13]);
assert.deepEqual([...resolve("this area", 80, 59, [], true).pages], [], "a selected region does not redundantly attach the whole page");

const state = vm.runInContext('withViewerState("hi", 59)', context);
assert.match(state, /page 59 is the page visible for this message/);
assert.match(state, /Earlier @page mentions are historical references/);
assert.match(source, /const pageContext = resolveTurnPages\(content, info\.pageCount, info\.currentPage/);
assert.match(source, /lead = withViewerState\(lead, message\.viewerPage \|\| info\.currentPage\)/);

console.log("10 current-page context regression checks passed");
