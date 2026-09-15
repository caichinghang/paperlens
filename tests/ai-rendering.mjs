import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/ai.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function escapeHtml'), source.indexOf('function newChatId')).replace(/^export /gm, '');
// The renderer translates card labels; English passthrough is enough for these checks.
const fill = (text, params = {}) => text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
const context = vm.createContext({ t: fill, tn: (count, one, other, params = {}) => fill(count === 1 ? one : other, { count, ...params }) });
vm.runInContext(section, context);
const render = text => vm.runInContext(`renderMarkdown(${JSON.stringify(text)})`, context);
assert.deepEqual([...render('[pp. 1, 4-7]').matchAll(/data-page="(\d+)"/g)].map(m => m[1]), ['1', '4']);
assert.equal((render('[pp. 4-7, 4-7, 5]').match(/class="cite"/g) || []).length, 1);
assert.match(render('Fields on [pp. 4–7].'), /pp\. 4–7<\/button>\./);
assert.doesNotMatch(render('`[p. 4]`'), /class="cite"/);
assert.doesNotMatch(render('<img src=x onerror=alert(1)>'), /<img/);
assert.match(render('| Field | Count |\n| --- | ---: |\n| Name | 2 |'), /text-align:right/);
assert.match(render('[Source](https://example.com)'), /rel="noopener noreferrer"/);
console.log('7 rendering regression checks passed');
