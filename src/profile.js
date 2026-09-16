// The reader's personal details for forms: a fixed set of common fields, plus any of their own.
// Pure data helpers; the workspace renders them, the assistant reads and saves them through tools.

export const PROFILE_SECTIONS = [
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
      { key: "gender", label: "Gender", type: "choice", options: ["male", "female", "other"], aliases: ["gender", "sex", "性别"] },
      { key: "birthDate", label: "Date of birth", type: "date", aliases: ["date of birth", "birth date", "birthday", "dob", "出生日期", "生日", "出生年月日"] },
      { key: "nationality", label: "Nationality", placeholder: "", aliases: ["nationality", "citizenship", "国籍"] }
    ]
  },
  {
    id: "identity",
    title: "Identity documents",
    fields: [
      { key: "idNumber", label: "ID card number", secret: true, aliases: ["id number", "id card number", "id card", "id no", "identity card", "identity card number", "national id", "national id number", "hkid", "hkid number", "身份证", "身份证号", "身份证号码", "证件号码", "证件号"] },
      { key: "passportNumber", label: "Passport number", secret: true, aliases: ["passport", "passport number", "passport no", "护照", "护照号", "护照号码"] }
    ]
  },
  {
    id: "contact",
    title: "Contact",
    fields: [
      { key: "phone", label: "Phone", type: "tel", placeholder: "+852 9123 4567", aliases: ["phone", "phone number", "mobile", "mobile number", "mobile phone", "telephone", "telephone number", "tel", "contact number", "手机", "手机号", "手机号码", "电话", "电话号码", "联系电话"] },
      { key: "email", label: "Email", type: "email", placeholder: "name@example.com", aliases: ["email", "e-mail", "email address", "邮箱", "电子邮箱", "电子邮件", "邮件地址"] },
      { key: "address", label: "Address", type: "multiline", wide: true, aliases: ["address", "home address", "residential address", "mailing address", "correspondence address", "地址", "住址", "家庭住址", "通讯地址", "居住地址"] }
    ]
  }
];

export const PROFILE_FIELDS = PROFILE_SECTIONS.flatMap(section => section.fields);

const GENDER_LABELS = { male: "Male", female: "Female", other: "Other" };
const GENERIC_NAMES = new Set(["name", "fullname", "legalname", "姓名", "名字", "全名"]);
const AGE_LABELS = new Set(["age", "年龄", "年纪"]);
const MAX_CUSTOM = 100;

export function normalizeLabel(label) {
  return String(label ?? "").toLowerCase().replace(/[\s_\-.:：()（）/·,，]+/g, "");
}

const ALIASES = new Map(PROFILE_FIELDS.flatMap(field =>
  [field.label, ...field.aliases].map(alias => [normalizeLabel(alias), field.key])));

function customId() {
  return `field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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

export function emptyProfile() {
  return { fields: {}, custom: [] };
}

// Files a detail under the fixed field it names, or among the reader's own. Returns the field key,
// or "custom".
export function applyDetail(profile, label, value) {
  const cleanLabel = String(label ?? "").trim().slice(0, 80);
  let cleanValue = String(value ?? "").trim().slice(0, 500);
  const norm = normalizeLabel(cleanLabel);
  let key = GENERIC_NAMES.has(norm)
    ? (/[㐀-鿿]/.test(cleanValue) ? "nameChinese" : "nameEnglish")
    : ALIASES.get(norm) || null;
  if (key === "birthDate") {
    cleanValue = normalizeDate(cleanValue);
    key = cleanValue ? key : null;
    cleanValue = cleanValue || String(value ?? "").trim().slice(0, 500);
  } else if (key === "gender") {
    const gender = normalizeGender(cleanValue);
    key = gender ? key : null;
    cleanValue = gender || cleanValue;
  }
  if (AGE_LABELS.has(norm) && profile.fields.birthDate) {
    return "birthDate";
  }
  if (key) {
    profile.fields[key] = cleanValue;
    return key;
  }
  const existing = profile.custom.find(field => normalizeLabel(field.label) === norm);
  if (existing) {
    existing.value = cleanValue;
  } else if (profile.custom.length < MAX_CUSTOM) {
    profile.custom.push({ id: customId(), label: cleanLabel, value: cleanValue });
  }
  return "custom";
}

// Saved profiles were once a plain list of label/value pairs; those are filed into the new fields.
export function loadProfile(saved) {
  const profile = emptyProfile();
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (!entry || typeof entry.label !== "string") {
        continue;
      }
      if (!String(entry.value ?? "").trim()) {
        continue;
      }
      const key = ALIASES.get(normalizeLabel(entry.label));
      if (key && profile.fields[key]) {
        profile.custom.push({ id: entry.id || customId(), label: entry.label, value: String(entry.value) });
      } else {
        applyDetail(profile, entry.label, entry.value);
      }
    }
    return profile;
  }
  if (saved && typeof saved === "object") {
    for (const field of PROFILE_FIELDS) {
      const value = saved.fields?.[field.key];
      if (typeof value === "string" && value) {
        profile.fields[field.key] = value;
      }
    }
    profile.custom = (Array.isArray(saved.custom) ? saved.custom : [])
      .filter(field => field && typeof field.label === "string")
      .map(field => ({ id: field.id || customId(), label: field.label, value: String(field.value ?? "") }));
  }
  return profile;
}

// What the assistant sees: every filled detail with an English label, age included.
export function profileEntries(profile, now = new Date()) {
  const entries = [];
  for (const field of PROFILE_FIELDS) {
    const value = String(profile.fields[field.key] ?? "").trim();
    if (!value) {
      continue;
    }
    entries.push({ label: field.label, value: field.key === "gender" ? GENDER_LABELS[value] || value : value });
    if (field.key === "birthDate") {
      const age = profileAge(value, now);
      if (age !== null) {
        entries.push({ label: "Age", value: String(age) });
      }
    }
  }
  for (const field of profile.custom) {
    if (field.label.trim() && field.value.trim()) {
      entries.push({ label: field.label.trim(), value: field.value.trim() });
    }
  }
  return entries;
}

export function filledCount(profile) {
  return PROFILE_FIELDS.filter(field => String(profile.fields[field.key] ?? "").trim()).length;
}
