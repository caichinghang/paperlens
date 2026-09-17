import assert from 'node:assert/strict';
import { blocksToMarkdown, escapeInline, inlineToHtml, inlineToPlain, markdownToBlocks } from '../src/blocks.js';
import { applyDetail, emptyProfile, findField, loadProfile, normalizeDate, privateEntries, profileAge, profileEntries } from '../src/profile.js';
import { compileSecrets, fillTokens, maskDeep, maskText, profileToken } from '../src/privacy.js';
import { moveOutline, normalizeOutline, outlineChildren } from '../src/outline.js';
import { popupNearCaret } from '../src/popup-position.js';
import { mergeTodos, readTodos } from '../src/todos.js';
import { collectRules, snapBoxToRule, snapTextToRule } from '../src/rules.js';
import { headingCandidates } from '../src/headings.js';
import { publicWebUrl, readWebpage } from '../src/web.js';

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

// Profile details land in the matching field, renamed or not; the rest become new "Other details".
{
  const profile = emptyProfile();
  assert.equal(applyDetail(profile, '姓名', '陈大文'), 'nameChinese');
  assert.equal(applyDetail(profile, 'Full name', 'Chan Tai Man'), 'nameEnglish');
  assert.equal(applyDetail(profile, 'Date of Birth', '1990年5月1日'), 'birthDate');
  assert.equal(findField(profile, 'birthDate').value, '1990-05-01');
  assert.equal(applyDetail(profile, 'Sex', 'F'), 'gender');
  const school = applyDetail(profile, 'School', 'HKU');
  assert.equal(profile.sections.at(-1).fields[0].id, school);
  assert.equal(findField(profile, school).private, false);
  // A renamed field is found by its new name and still by the built-in aliases; ID-like labels start private.
  findField(profile, 'idNumber').label = 'Hong Kong ID';
  assert.equal(applyDetail(profile, 'hong kong id', 'A123456(7)'), 'idNumber');
  assert.equal(applyDetail(profile, 'HKID number', 'A123456(7)'), 'idNumber');
  assert.equal(findField(profile, applyDetail(profile, 'US Social Security Number', '123-45-6789')).private, true);
  assert.equal(normalizeDate('31/12/1999'), '1999-12-31');
  assert.equal(normalizeDate('1999-02-30'), '');
  assert.equal(profileAge('1990-05-01', new Date(2026, 3, 30)), 35);
  assert.equal(profileAge('1990-05-01', new Date(2026, 4, 1)), 36);

  // The assistant gets values for open fields and only a token for private ones, with no hint.
  const entries = profileEntries(profile, new Date(2026, 8, 15));
  assert.deepEqual(entries.map(entry => entry.label), ['English name', 'Chinese name', 'Gender', 'Date of birth', 'Age', 'Hong Kong ID', 'School', 'US Social Security Number']);
  const id = entries.find(entry => entry.label === 'Hong Kong ID');
  assert.deepEqual(id, { group: 'Identity documents', label: 'Hong Kong ID', private: true, token: '{{profile:idNumber}}' });
  assert.ok(!JSON.stringify(entries).includes('A123456'));
  // A private date of birth takes its age with it.
  findField(profile, 'birthDate').private = true;
  assert.ok(!profileEntries(profile).some(entry => entry.label === 'Age' || entry.value === '1990-05-01'));

  // Tokens fill locally; anything private heading to the assistant turns back into its token.
  const secrets = privateEntries(profile);
  assert.strictEqual(compileSecrets(secrets), compileSecrets(secrets), 'unchanged private values reuse compiled masking patterns');
  const lookup = fieldId => findField(profile, fieldId) && { label: findField(profile, fieldId).label, value: findField(profile, fieldId).value };
  assert.deepEqual(fillTokens(`ID: ${profileToken('idNumber')}`, lookup), { text: 'ID: A123456(7)', used: ['Hong Kong ID'], missing: [] });
  assert.deepEqual(fillTokens('{{profile:nope}}', lookup).missing, ['nope']);
  assert.equal(maskText('A123456(7) / A 123 456 (7) / a1234567 / A12345678 / Link', [{ id: 'idNumber', value: 'A123456(7)' }, { id: 'n', value: 'Li' }]),
    '{{profile:idNumber}} / {{profile:idNumber}} / {{profile:idNumber}} / A12345678 / Link');
  assert.equal(maskText('我叫陈大文。', [{ id: 'c', value: '陈大文' }]), '我叫{{profile:c}}。');
  assert.deepEqual(maskDeep({ fields: [{ value: 'A123456(7)' }], image: 'data:image/jpeg;A123456(7)', count: 2 }, secrets),
    { fields: [{ value: '{{profile:idNumber}}' }], image: 'data:image/jpeg;A123456(7)', count: 2 });
}

// Older profiles: version 1 kept fixed values in `fields` and the reader's own in `custom`; before that a plain list.
{
  const v1 = loadProfile({ fields: { phone: '123', idNumber: 'X1' }, custom: [{ id: 'field-s', label: 'Student ID', value: '3035' }, { id: 'field-h', label: 'Hobby', value: 'Chess' }] });
  assert.equal(findField(v1, 'phone').value, '123');
  assert.equal(findField(v1, 'idNumber').private, true);
  assert.deepEqual(v1.sections.at(-1).fields.map(field => [field.label, field.private]), [['Student ID', true], ['Hobby', false]]);
  const list = loadProfile([{ label: 'Phone number', value: '123' }, { label: 'Phone', value: '456' }, { label: 'Hobby', value: 'Chess' }]);
  assert.equal(findField(list, 'phone').value, '123');
  assert.deepEqual(list.sections.at(-1).fields.map(field => field.label), ['Phone', 'Hobby']);
  // A saved version 2 profile keeps custom groups; built-in groups can't go missing.
  const v2 = loadProfile({ version: 2, sections: [{ id: 'section-school', title: 'School', fields: [{ id: 'field-a', label: 'Name', value: 'HKU' }] }] });
  assert.deepEqual(v2.sections.map(section => section.id), ['name', 'basics', 'identity', 'contact', 'other', 'section-school']);
}


// To-dos are to-do blocks on the notebook's To-do page: appended after the last one, cited by page,
// skipped when an unticked copy is already there, and read back as plain items.
{
  const start = markdownToBlocks('# To-do\n\n- [ ] Sign the form [p. 3]\n- [x] Read *section 2*\n\nNotes below.');
  const { blocks: merged, added } = mergeTodos(start, [
    { text: 'sign the form', page: 3 },
    { text: 'Read section 2', page: 2 },
    { text: 'Book a session by 30 Sep', page: 1 },
    { text: '  ' }
  ]);
  assert.equal(added.length, 2);
  assert.deepEqual(merged.map(block => block.type), ['heading1', 'todo', 'todo', 'todo', 'todo', 'paragraph']);
  assert.equal(merged[3].text, 'Read section 2 [p. 2]');
  assert.equal(merged[4].text, 'Book a session by 30 Sep [p. 1]');
  assert.deepEqual(readTodos(merged), [
    { text: 'Sign the form', page: 3, done: false },
    { text: 'Read section 2', page: null, done: true },
    { text: 'Read section 2', page: 2, done: false },
    { text: 'Book a session by 30 Sep', page: 1, done: false }
  ]);
  assert.equal(blocksToMarkdown(merged).split('\n').filter(line => line.startsWith('- [')).length, 4);

  // A new page's blank paragraph is dropped; the old separate list migrates with its ticks.
  const fresh = mergeTodos(markdownToBlocks(''), [{ text: 'Return the form', page: 3, done: true }, { text: 'Bring a photo' }]);
  assert.deepEqual(fresh.blocks.map(block => [block.type, block.text, block.checked]), [['todo', 'Return the form [p. 3]', true], ['todo', 'Bring a photo', false]]);
  assert.equal(mergeTodos(fresh.blocks, [{ text: 'bring a  photo' }]).added.length, 0);
}

// Blank lines come from flat drawn boxes; text and signatures placed near one are set to sit on it.
{
  const rules = collectRules([
    { x1: 300, x2: 550, y1: 500, y2: 500 },
    { x1: 550, x2: 600, y1: 500.4, y2: 500.4 },
    { x1: 300, x2: 430, y1: 540, y2: 540.8 },
    { x1: 80, x2: 90, y1: 300, y2: 300 },
    { x1: 100, x2: 400, y1: 200, y2: 260 }
  ]);
  assert.deepEqual(rules.map(rule => [rule.x1, rule.x2, Math.round(rule.y)]), [[300, 600, 500], [300, 430, 540]]);

  // A date typed a little low, across the line, is lifted so its baseline sits just above it.
  const y = snapTextToRule(rules, { x: 302, y: 533, fontSize: 11 });
  assert.ok(y + 11 * 0.96 <= 538 && y + 11 * 0.96 > 535, `glyphs end at ${y + 11 * 0.96}`);
  assert.equal(snapTextToRule(rules, { x: 302, y: 533, fontSize: 11, depth: 12 }), 525.1);
  // Too far above, off the end of the line, or several lines: left alone.
  assert.equal(snapTextToRule(rules, { x: 302, y: 505, fontSize: 11 }), null);
  assert.equal(snapTextToRule(rules, { x: 480, y: 533, fontSize: 11 }), null);
  assert.equal(snapTextToRule(rules, { x: 302, y: 533, fontSize: 11, lineCount: 2 }), null);

  // A signature box straddling the line comes to rest on it; one with no line under it stays put.
  const box = snapBoxToRule(rules, { x: 330, y: 480, width: 150, height: 34 });
  assert.equal(box.y + box.height, 499);
  assert.deepEqual(snapBoxToRule(rules, { x: 330, y: 100, width: 150, height: 34 }), { x: 330, y: 100, width: 150, height: 34 });
}

// Table-of-contents candidates come from the text layer: larger type, numbered headings and page
// titles; body text, page numbers and long lines don't count.
{
  const block = (text, fontSize, y, lineCount = 1) => ({ text, fontSize, lineCount, box: { y } });
  const body = 'Body text that goes on for a while so this size carries the most characters in the document. '.repeat(3);
  const pages = [
    { page: 1, blocks: [block('Practice Question', 28, 40), block(body, 12, 120, 4), block('12', 9, 780)] },
    { page: 2, blocks: [block('2.1 Unordered sampling', 12, 60), block(body, 12, 100, 4), block('Figure 1: Recall', 10, 300)] },
    { page: 3, blocks: [block('Summary', 13, 30), block(body, 12, 80, 4), block('第二章 概率', 12, 400)] }
  ];
  const { bodySize, candidates, trimmed } = headingCandidates(pages);
  assert.equal(bodySize, 12);
  assert.deepEqual(candidates.map(entry => [entry.page, entry.text]), [[1, 'Practice Question'], [2, '2.1 Unordered sampling'], [3, 'Summary'], [3, '第二章 概率']]);
  assert.equal(trimmed, false);
  // Over the limit, the largest type is kept, still in reading order.
  const many = Array.from({ length: 10 }, (_, index) => ({ page: index + 1, blocks: [block(`Heading ${index}`, index % 2 ? 20 : 16, 10), block(body, 12, 100, 4)] }));
  const cut = headingCandidates(many, { limit: 5 });
  assert.equal(cut.trimmed, true);
  assert.deepEqual(cut.candidates.map(entry => entry.page), [2, 4, 6, 8, 10]);
}

console.log('workspace data checks passed');

// DeepSeek list prices, doubled in Beijing peak hours (weekdays 9–12 and 14–18).
{
  const { formatCost, isPeakTime, requestCost } = await import('../src/pricing.js');
  assert.equal(isPeakTime(Date.UTC(2026, 8, 17, 2, 0)), true);   // Thu 10:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 17, 4, 30)), false); // Thu 12:30 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 17, 10, 0)), false); // Thu 18:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 19, 2, 0)), false);  // Sat 10:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 20, 17, 0)), false); // Mon 01:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 21, 6, 0)), true);   // Mon 14:00 Beijing

  // 1M input (400k from cache) and 100k output, off-peak then peak.
  const usage = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 400_000, completion_tokens: 100_000 };
  const offPeak = requestCost('deepseek-flash', usage, Date.UTC(2026, 8, 19, 2, 0));
  assert.equal(offPeak.peak, false);
  assert.ok(Math.abs(offPeak.usd - (0.6 * 0.15 + 0.4 * 0.003 + 0.1 * 0.6)) < 1e-9);
  assert.ok(Math.abs(offPeak.cny - (0.6 * 1 + 0.4 * 0.02 + 0.1 * 4)) < 1e-9);
  const peak = requestCost('deepseek-flash', usage, Date.UTC(2026, 8, 17, 2, 0));
  assert.ok(Math.abs(peak.usd - offPeak.usd * 2) < 1e-9);
  assert.equal(requestCost('some-other-model', usage), null);

  assert.equal(formatCost(0.0042, 'usd'), '$0.0042');
  assert.equal(formatCost(0.00042, 'usd'), '$0.00042');
  assert.equal(formatCost(0.0315, 'cny'), '¥0.032');
  assert.equal(formatCost(1.254, 'usd'), '$1.25');
  assert.equal(formatCost(0, 'cny'), '¥0');
}

console.log('pricing checks passed');

// The web-reading tool accepts public HTTP(S) pages but never local or private-network targets.
{
  assert.equal(publicWebUrl('https://example.com/path').href, 'https://example.com/path');
  assert.equal(publicWebUrl('/next', 'https://example.com/start').href, 'https://example.com/next');
  for (const address of [
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://127.1',
    'http://2130706433',
    'http://10.0.0.2',
    'http://100.64.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://172.16.2.3',
    'http://192.168.1.1',
    'http://[::1]',
    'http://[fd00::1]',
    'https://user:password@example.com'
  ]) {
    assert.throws(() => publicWebUrl(address), /private-network|http\(s\)/);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 302,
    headers: new Headers({ location: 'http://127.0.0.1/private' })
  });
  await assert.rejects(readWebpage('https://example.com/start'), /private-network/);
  globalThis.fetch = originalFetch;
}

console.log('web URL safety checks passed');
