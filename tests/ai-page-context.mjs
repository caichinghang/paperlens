import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");
const section = source.slice(source.indexOf("function parseMentions"), source.indexOf("function rangeLabel"));
const context = vm.createContext({
  MENTION_PATTERN: /(^|\s)@(\d+)(?:\s*[-–]\s*(\d+))?(?=$|[\s.,;:!?)])/g,
  VIEWER_STATE_ONLY: /^(?:hi|hello|hey|thanks|thank\s+you|(?:what|which)\s+page(?:\s+(?:am\s+i\s+on|is\s+this))?|你好|嗨|谢谢|多谢|我在第几页|现在第几页)$/i
});
vm.runInContext(section, context);

const resolve = (text, pageCount, currentPage, attached = [], hasRegions = false) =>
  vm.runInContext(`resolveTurnPages(${JSON.stringify(text)}, ${pageCount}, ${currentPage}, ${JSON.stringify(attached)}, ${hasRegions})`, context);

assert.equal(vm.runInContext('needsCurrentPageContent("hi")', context), false);
assert.deepEqual([...vm.runInContext('resolveTurnPages("hi", 80, 59, [], false, needsCurrentPageContent("hi"))', context).pages], [], "a greeting gets live page identity without an expensive page image");
assert.equal(vm.runInContext('needsCurrentPageContent("explain this")', context), true);
assert.deepEqual([...resolve("explain this", 80, 59).pages], [59], "a page-relative request implicitly attaches the live page");
assert.equal(resolve("explain this", 80, 59).implicit, true);
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

console.log("13 current-page context regression checks passed");
