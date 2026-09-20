// Renders TeX math (found by the pure matchers in blocks.js) with KaTeX for chat replies and notebook text.
import katex from "../vendor/katex/katex.mjs";
import { matchMath } from "./blocks.js";

export { displayMathOpening } from "./blocks.js";

const cache = new Map();

// KaTeX output with `trust` off is plain markup, so it can go straight into innerHTML.
export function renderTex(tex, display = false) {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = cache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
    if (cache.size > 500) cache.clear();
    cache.set(key, html);
  }
  return html;
}

// Swaps each math span (outside `code`) for a private-use placeholder, so the Markdown passes
// around it can't touch the TeX; `restore` puts the rendered math back.
export function protectMath(text) {
  const spans = [];
  let out = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index) {
        out += text.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    const math = matchMath(text, index);
    if (math) {
      spans.push(math);
      out += `\uE002${spans.length - 1}\uE003`;
      index = math.end;
      continue;
    }
    out += text[index];
    index += 1;
  }
  const restore = html => html.replace(/\uE002(\d+)\uE003/g, (_, i) => mathHtml(spans[Number(i)]));
  return { text: out, restore };
}

export function mathHtml({ tex, display }) {
  return `<span class="${display ? "math math-display" : "math"}">${renderTex(tex, display)}</span>`;
}
