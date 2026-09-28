import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ai = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");

// The array literal that starts at `const name = [`, up to its closing `];` at the start of a line.
function block(name) {
  const start = ai.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} is defined`);
  return ai.slice(start, ai.indexOf("\n];", start));
}

test("the skills view lists every skill in exactly one group", () => {
  const skills = [...block("SKILLS").matchAll(/\{ id: "([^"]+)"/g)].map(match => match[1]);
  const grouped = [...block("SKILL_GROUPS").matchAll(/skills: \[([^\]]*)\]/g)]
    .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(id => id[1]));
  assert.ok(skills.length > 0);
  assert.deepEqual([...grouped].sort(), [...skills].sort());
});
