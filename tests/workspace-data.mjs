import assert from 'node:assert/strict';
import { blocksToMarkdown, escapeInline, inlineToHtml, inlineToPlain, markdownToBlocks } from '../src/blocks.js';
import { applyDetail, emptyProfile, loadProfile, normalizeDate, profileAge, profileEntries } from '../src/profile.js';
import { moveOutline, normalizeOutline, outlineChildren } from '../src/outline.js';
import { popupNearCaret } from '../src/popup-position.js';

const types = markdown => markdownToBlocks(markdown).map(block => block.type);

// Markdown the assistant writes becomes blocks, and goes back to the same Markdown.
const note = [
  '# Overview',
  '',
  'Intro with **bold** and a cite [p. 3].',
  '',
  '- one',
  '  - nested',
  '- [x] done task',
  '1. first',
  '2. second',
  '',
  '> quoted line',
  '',
  '> 💡 remember this',
  '',
  '---',
  '',
  '| Term | Page |',
  '| --- | --- |',
  '| A \\| B | 4 |',
  '',
  '```flashcards',
  'What is X? :: A thing',
  '```',
  '',
  '```js',
  'const a = 1;',
  '```'
].join('\n');
const blocks = markdownToBlocks(note);
assert.deepEqual(blocks.map(block => block.type), ['heading1', 'paragraph', 'bullet', 'bullet', 'todo', 'numbered', 'numbered', 'quote', 'callout', 'divider', 'table', 'flashcards', 'code']);
assert.equal(blocks[3].indent, 1);
assert.equal(blocks[4].checked, true);
assert.equal(blocks[10].rows[1][0], 'A | B');
assert.equal(blocks[11].cards[0].answer, 'A thing');
assert.equal(blocksToMarkdown(blocks), note);
assert.deepEqual(types(blocksToMarkdown(markdownToBlocks(blocksToMarkdown(blocks)))), blocks.map(block => block.type));
const pageBlock = markdownToBlocks('See [p. 12] in this sentence.');
assert.equal(pageBlock[0].type, 'paragraph');
assert.equal(blocksToMarkdown(pageBlock), 'See [p. 12] in this sentence.');
assert.match(inlineToHtml('See [Page 12]'), /data-page="12"/);

const tree = { notes: [
  { id: 'a', createdAt: 3 }, { id: 'b', createdAt: 2 }, { id: 'c', createdAt: 1, folderId: 'f' }
], folders: [{ id: 'f' }, { id: 'g' }] };
normalizeOutline(tree);
assert.deepEqual(outlineChildren(tree).map(item => item.id), ['a', 'b', 'f', 'g']);
assert.equal(moveOutline(tree, 'b', 'f', 'c'), true);
assert.deepEqual(outlineChildren(tree, 'f').map(item => item.id), ['b', 'c']);
assert.equal(moveOutline(tree, 'b', null, 'a'), true);
assert.deepEqual(outlineChildren(tree).map(item => item.id), ['b', 'a', 'f', 'g']);
assert.equal(moveOutline(tree, 'g', 'f'), true);
assert.equal(moveOutline(tree, 'f', 'g'), false);

const viewport = { width: 1200, height: 800 };
const box = { width: 180, height: 46 };
const atText = { left: 700, top: 260, bottom: 282, height: 22 };
assert.deepEqual(popupNearCaret({ left: 0, top: 0, bottom: 0, height: 0 }, atText, box, viewport), { left: 700, top: 290 });
assert.deepEqual(popupNearCaret({ left: 1150, top: 750, bottom: 772, height: 22 }, atText, box, viewport), { left: 1012, top: 696 });

// CSV blocks become tables; numbering restarts after other blocks.
assert.deepEqual(markdownToBlocks('```csv\na,b\n1,2\n```')[0].rows, [['a', 'b'], ['1', '2']]);
assert.match(blocksToMarkdown(markdownToBlocks('1. a\n\ntext\n\n1. b\n2. c')), /1\. b\n2\. c$/);

// Inline Markdown renders safely, and escaped text stays literal.
assert.doesNotMatch(inlineToHtml('<img src=x onerror=alert(1)>'), /<img/);
assert.match(inlineToHtml('see [pp. 4–7]'), /data-page="4"/);
assert.match(inlineToHtml('**b** *i* ~~s~~ `c` [x](https://a.b)'), /<strong>b<\/strong> <em>i<\/em> <s>s<\/s> <code>c<\/code> <a href="https:\/\/a\.b"/);
assert.equal(inlineToHtml(escapeInline('2 * 3 * 4 and snake_case_name [p. 2]')), '2 * 3 * 4 and snake_case_name [p. 2]');
assert.equal(inlineToHtml('snake_case_name'), 'snake_case_name');
assert.equal(inlineToPlain('**Bold** and [link](https://x.y)'), 'Bold and link');

// Profile details land in the fixed fields; the rest are kept as custom ones.
const profile = emptyProfile();
assert.equal(applyDetail(profile, '姓名', '陈大文'), 'nameChinese');
assert.equal(applyDetail(profile, 'Full name', 'Chan Tai Man'), 'nameEnglish');
assert.equal(applyDetail(profile, 'Date of Birth', '1990年5月1日'), 'birthDate');
assert.equal(profile.fields.birthDate, '1990-05-01');
assert.equal(applyDetail(profile, 'Sex', 'F'), 'gender');
assert.equal(applyDetail(profile, 'School', 'HKU'), 'custom');
assert.equal(normalizeDate('31/12/1999'), '1999-12-31');
assert.equal(normalizeDate('1999-02-30'), '');
assert.equal(profileAge('1990-05-01', new Date(2026, 3, 30)), 35);
assert.equal(profileAge('1990-05-01', new Date(2026, 4, 1)), 36);
assert.deepEqual(profileEntries(profile, new Date(2026, 8, 15)).map(entry => entry.label), ['English name', 'Chinese name', 'Gender', 'Date of birth', 'Age', 'School']);
const migrated = loadProfile([{ label: 'Phone number', value: '123' }, { label: 'Phone', value: '456' }, { label: 'Hobby', value: 'Chess' }]);
assert.equal(migrated.fields.phone, '123');
assert.deepEqual(migrated.custom.map(field => field.label), ['Phone', 'Hobby']);

console.log('workspace data checks passed');
