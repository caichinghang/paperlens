import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
const ai = readFileSync(new URL("../src/ai.js", import.meta.url), "utf8");

const lightPalette = {
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  purple: "#a855f7",
  orange: "#f97316"
};

const darkPalette = {
  blue: "#60a5fa",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  purple: "#c084fc",
  orange: "#fb923c"
};

test("scenario and skill icons use the familiar six-color palette", () => {
  for (const [name, value] of Object.entries(lightPalette)) {
    assert.match(css, new RegExp(`--i-${name}: ${value}`, "i"));
    assert.match(ai, new RegExp(`var\\(--i-${name}\\)`));
  }

  for (const [name, value] of Object.entries(darkPalette)) {
    assert.equal(css.match(new RegExp(`--i-${name}: ${value}`, "gi"))?.length, 2);
  }

  for (const retired of ["clay", "ochre", "teal", "plum", "denim", "cobalt", "cyan", "emerald", "violet", "saffron"]) {
    assert.doesNotMatch(`${css}\n${ai}`, new RegExp(`--i-${retired}\\b`));
  }
});

test("each scenario and skill icon stays within one hue family", () => {
  const iconSource = ai.slice(ai.indexOf("const SKILL_ICONS"), ai.indexOf("function iconTile"));
  const lines = iconSource.split("\n").filter(line => line.includes("<svg"));
  assert.ok(lines.length > 30);
  for (const line of lines) {
    const tokens = [...line.matchAll(/var\(--i-(blue|green|yellow|red|purple|orange)\)/g)].map(match => match[1]);
    assert.equal(new Set(tokens).size, 1, line.trim().slice(0, 80));
  }

  assert.match(ai, /study: .*var\(--i-blue\)/);
  assert.match(ai, /research: .*var\(--i-green\)/);
  assert.match(ai, /contracts: .*var\(--i-red\)/);
  assert.match(ai, /forms: .*var\(--i-orange\)/);
  assert.match(ai, /reports: .*var\(--i-purple\)/);
});

test("menu icons are standalone and Reports precedes Forms", () => {
  const skillIconRule = css.match(/\.skill-icon\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(skillIconRule, /\bborder:/);
  assert.doesNotMatch(skillIconRule, /\bbackground:/);

  const scenarios = ai.slice(ai.indexOf("const SCENARIOS"), ai.indexOf("const WORKSPACE_GUIDANCE"));
  assert.ok(scenarios.indexOf('id: "reports"') < scenarios.indexOf('id: "forms"'));
});
