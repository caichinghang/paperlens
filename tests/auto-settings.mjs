import assert from "node:assert/strict";

// i18n reads navigator and localStorage when imported, so stub both first.
const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });

const i18n = await import("../src/i18n.js");
assert.equal(i18n.getLanguagePreference(), "auto");
assert.equal(i18n.uiLanguage, "zh");
assert.equal(i18n.browserLanguage(), "zh");
assert.equal(i18n.resolveLanguage("en"), "en");
assert.equal(i18n.resolveLanguage("auto"), "zh");
assert.equal(store.has("uiLanguage"), false, "auto is the default and is not written on first run");

// The page loaded in Chinese: choosing zh or auto keeps it (no reload); choosing en changes it.
assert.equal(i18n.setLanguagePreference("zh"), false);
assert.equal(i18n.getLanguagePreference(), "zh");
assert.equal(i18n.setLanguagePreference("en"), true);
assert.equal(i18n.setLanguagePreference("auto"), false);
assert.equal(i18n.getLanguagePreference(), "auto");
assert.equal(i18n.setLanguagePreference("fr"), false);
console.log("auto settings checks passed");
