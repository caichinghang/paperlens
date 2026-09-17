// The reader's personal details for forms, in groups: five built-in ones (name, basic information,
// identity documents, contact, other details) and any the reader adds, such as "School". Every
// group takes extra fields and every field can be renamed ("ID card number" → "Hong Kong ID").
// A field with a closed eye is private: it stays hidden on screen and the assistant only ever
// gets a token for it (see privacy.js). Pure data helpers; the workspace renders them.

import { profileToken } from "./privacy.js";

export const PROFILE_VERSION = 2;
const MAX_FIELDS = 200;
const MAX_SECTIONS = 40;

// The built-in groups and their starting fields. A starting field keeps its kind (date, gender…)
// and its aliases for matching even after the reader renames it.
export const PROFILE_TEMPLATE = [
  {
    id: "name",
    title: "Name",
    fields: [
      { key: "nameEnglish", label: "English name", placeholder: "Chan Tai Man", aliases: ["english name", "name in english", "english full name", "英文名", "英文姓名", "英文名字"] },
      { key: "nameChinese", label: "Chinese name", placeholder: "陈大文", aliases: ["chinese name", "name in chinese", "中文名", "中文姓名", "中文名字"] }
    ]
  },
  {
    id: "basics",
    title: "Basic information",
    fields: [
      { key: "gender", label: "Gender", type: "gender", aliases: ["gender", "sex", "性别"] },
      { key: "birthDate", label: "Date of birth", type: "date", aliases: ["date of birth", "birth date", "birthday", "dob", "出生日期", "生日", "出生年月日"] },
      { key: "nationality", label: "Nationality", aliases: ["nationality", "citizenship", "国籍"] }
    ]
  },
  {
    id: "identity",
    title: "Identity documents",
    fields: [
      { key: "idNumber", label: "ID card number", private: true, aliases: ["id number", "id card number", "id card", "id no", "identity card", "identity card number", "national id", "national id number", "hkid", "hkid number", "身份证", "身份证号", "身份证号码", "证件号码", "证件号"] },
      { key: "passportNumber", label: "Passport number", private: true, aliases: ["passport", "passport number", "passport no", "护照", "护照号", "护照号码"] }
    ]
  },
  {
    id: "contact",
    title: "Contact",
    fields: [
      { key: "phone", label: "Phone", type: "tel", placeholder: "+852 9123 4567", aliases: ["phone", "phone number", "mobile", "mobile number", "mobile phone", "telephone", "telephone number", "tel", "contact number", "手机", "手机号", "手机号码", "电话", "电话号码", "联系电话"] },
      { key: "email", label: "Email", type: "email", placeholder: "name@example.com", aliases: ["email", "e-mail", "email address", "邮箱", "电子邮箱", "电子邮件", "邮件地址"] },
      { key: "address", label: "Address", type: "multiline", aliases: ["address", "home address", "residential address", "mailing address", "correspondence address", "地址", "住址", "家庭住址", "通讯地址", "居住地址"] }
    ]
  },
  { id: "other", title: "Other details", fields: [] }
];

const TEMPLATE_FIELDS = new Map(PROFILE_TEMPLATE.flatMap(section => section.fields.map(field => [field.key, field])));
const BUILT_IN_SECTIONS = new Map(PROFILE_TEMPLATE.map(section => [section.id, section]));
const GENDER_LABELS = { male: "Male", female: "Female", other: "Other" };
const GENERIC_NAMES = new Set(["name", "fullname", "legalname", "姓名", "名字", "全名"]);
const AGE_LABELS = new Set(["age", "年龄", "年纪"]);
// Labels that name an identity or account number start private when the assistant saves them.
const SENSITIVE_LABEL = /\b(id|ids|hkid|nric|ssn|sin|tin|iban|swift|pin)\b|passport|identity|identification|social ?security|national insurance|licen[cs]e (number|no)|driver'?s? licen|tax (number|no|id|file)|bank|account (number|no)|card (number|no)|身份证|证件|护照|社保|社会保障|驾照|驾驶证|税号|银行|账号|帐号|卡号/i;

export function normalizeLabel(label) {
  return String(label ?? "").toLowerCase().replace(/[\s_\-.:：()（）/·,，]+/g, "");
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function looksSensitive(label) {
  return SENSITIVE_LABEL.test(String(label ?? ""));
}

// The built-in definition behind a field, if it started as one.
export function fieldTemplate(field) {
  return field?.key ? TEMPLATE_FIELDS.get(field.key) || null : null;
}

export function fieldType(field) {
  return fieldTemplate(field)?.type || "text";
}

// English labels and titles: the defaults unless the reader renamed them. The workspace translates
// the defaults for display; the assistant always gets these.
export function fieldLabel(field) {
  return String(field?.label ?? "").trim() || fieldTemplate(field)?.label || "";
}

export function sectionTitle(section) {
  return String(section?.title ?? "").trim() || BUILT_IN_SECTIONS.get(section?.id)?.title || "";
}

export function isBuiltInSection(section) {
  return BUILT_IN_SECTIONS.has(section?.id);
}

function templateField(field) {
  return { id: field.key, key: field.key, label: "", value: "", private: Boolean(field.private) };
}

export function emptyProfile() {
  return {
    version: PROFILE_VERSION,
    sections: PROFILE_TEMPLATE.map(section => ({ id: section.id, title: "", fields: section.fields.map(templateField) }))
  };
}

export function newField(label = "", value = "") {
  return { id: uid("field"), label: String(label).slice(0, 80), value: String(value).slice(0, 500), private: looksSensitive(label) };
}

export function newSection(title = "") {
  return { id: uid("section"), title: String(title).slice(0, 80), fields: [newField()] };
}

export function allFields(profile) {
  return (profile?.sections || []).flatMap(section => section.fields);
}

export function findField(profile, id) {
  return allFields(profile).find(field => field.id === id) || null;
}

export function findSection(profile, id) {
  return (profile?.sections || []).find(section => section.id === id) || null;
}

function sectionOf(profile, id) {
  return findSection(profile, id) || findSection(profile, "other");
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const ok = year > 1880 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return ok ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : "";
}

// "1990-05-01", "1990/5/1", "1990年5月1日" and day-first "01/05/1990" become YYYY-MM-DD.
export function normalizeDate(value) {
  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (match) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    return second > 12 ? validDate(Number(match[3]), first, second) : validDate(Number(match[3]), second, first);
  }
  return "";
}

export function normalizeGender(value) {
  const text = normalizeLabel(value);
  if (["male", "m", "man", "男", "男性"].includes(text)) {
    return "male";
  }
  if (["female", "f", "woman", "女", "女性"].includes(text)) {
    return "female";
  }
  if (["other", "nonbinary", "其他"].includes(text)) {
    return "other";
  }
  return "";
}

export function profileAge(birthDate, now = new Date()) {
  const match = String(birthDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : null;
}

// The field a label means: a renamed or built-in label, or one of a built-in field's aliases.
function matchField(profile, label, value) {
  const norm = normalizeLabel(label);
  if (!norm) {
    return null;
  }
  const fields = allFields(profile);
  const byName = fields.find(field => normalizeLabel(fieldLabel(field)) === norm);
  if (byName) {
    return byName;
  }
  if (GENERIC_NAMES.has(norm)) {
    const key = /[㐀-鿿]/.test(value) ? "nameChinese" : "nameEnglish";
    return fields.find(field => field.key === key) || null;
  }
  return fields.find(field => fieldTemplate(field)?.aliases.some(alias => normalizeLabel(alias) === norm)) || null;
}

// Files a detail under the field its label names, or as a new field in "Other details". Returns
// the field's id.
export function applyDetail(profile, label, value) {
  const cleanLabel = String(label ?? "").trim().slice(0, 80);
  const cleanValue = String(value ?? "").trim().slice(0, 500);
  if (AGE_LABELS.has(normalizeLabel(cleanLabel))) {
    const birth = allFields(profile).find(field => field.key === "birthDate");
    if (birth?.value) {
      return birth.id;
    }
  }
  const field = matchField(profile, cleanLabel, cleanValue);
  if (field) {
    const type = fieldType(field);
    const normalized = type === "date" ? normalizeDate(cleanValue) : type === "gender" ? normalizeGender(cleanValue) : cleanValue;
    field.value = normalized || cleanValue;
    return field.id;
  }
  const other = sectionOf(profile, "other");
  if (allFields(profile).length >= MAX_FIELDS) {
    return null;
  }
  const created = newField(cleanLabel, cleanValue);
  other.fields.push(created);
  return created.id;
}

function loadField(saved) {
  if (!saved || typeof saved !== "object") {
    return null;
  }
  const template = saved.key ? TEMPLATE_FIELDS.get(saved.key) : null;
  return {
    id: typeof saved.id === "string" && saved.id ? saved.id : template ? template.key : uid("field"),
    ...(template ? { key: template.key } : {}),
    label: String(saved.label ?? "").slice(0, 80),
    value: String(saved.value ?? "").slice(0, 500),
    private: typeof saved.private === "boolean" ? saved.private : Boolean(template?.private)
  };
}

// Reads a saved profile of any version. Version 1 kept built-in values in `fields` and the reader's
// own in `custom`; before that it was a plain list of label/value pairs.
export function loadProfile(saved) {
  const profile = emptyProfile();
  if (saved?.version === PROFILE_VERSION && Array.isArray(saved.sections)) {
    const seen = new Set();
    const sections = [];
    for (const entry of saved.sections.slice(0, MAX_SECTIONS)) {
      if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      sections.push({
        id: entry.id,
        title: String(entry.title ?? "").slice(0, 80),
        fields: (Array.isArray(entry.fields) ? entry.fields : []).map(loadField).filter(Boolean)
      });
    }
    // Built-in groups can't be deleted; any that are missing come back empty, in their place.
    for (const [index, template] of PROFILE_TEMPLATE.entries()) {
      if (!seen.has(template.id)) {
        sections.splice(Math.min(index, sections.length), 0, { id: template.id, title: "", fields: [] });
      }
    }
    profile.sections = sections;
    return profile;
  }
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (entry && typeof entry.label === "string" && String(entry.value ?? "").trim()) {
        const existing = matchField(profile, entry.label, String(entry.value));
        if (existing?.value) {
          sectionOf(profile, "other").fields.push(newField(entry.label, entry.value));
        } else {
          applyDetail(profile, entry.label, entry.value);
        }
      }
    }
    return profile;
  }
  if (saved && typeof saved === "object") {
    for (const field of allFields(profile)) {
      const value = saved.fields?.[field.key];
      if (typeof value === "string" && value) {
        field.value = value;
      }
    }
    for (const entry of Array.isArray(saved.custom) ? saved.custom : []) {
      if (entry && typeof entry.label === "string") {
        sectionOf(profile, "other").fields.push({ ...newField(entry.label, entry.value ?? ""), id: entry.id || uid("field") });
      }
    }
  }
  return profile;
}

// What the assistant sees: each filled detail with its group and English label. A private detail
// comes as a token, never its value; age is only worked out from a date of birth that isn't private.
export function profileEntries(profile, now = new Date()) {
  const entries = [];
  for (const section of profile.sections) {
    for (const field of section.fields) {
      const value = String(field.value ?? "").trim();
      const label = fieldLabel(field);
      if (!value || !label) {
        continue;
      }
      const group = sectionTitle(section);
      if (field.private) {
        entries.push({ group, label, private: true, token: profileToken(field.id) });
        continue;
      }
      entries.push({ group, label, value: fieldType(field) === "gender" ? GENDER_LABELS[value] || value : value });
      if (fieldType(field) === "date" && field.key === "birthDate") {
        const age = profileAge(value, now);
        if (age !== null) {
          entries.push({ group, label: "Age", value: String(age) });
        }
      }
    }
  }
  return entries;
}

// The private values, for filling tokens and masking what goes to the assistant.
export function privateEntries(profile) {
  return allFields(profile)
    .filter(field => field.private && String(field.value ?? "").trim())
    .map(field => ({ id: field.id, label: fieldLabel(field) || "Private detail", value: String(field.value).trim() }));
}
