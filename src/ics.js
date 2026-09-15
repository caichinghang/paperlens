// Minimal iCalendar (RFC 5545) files for dated items: all-day events, or one-hour events when a time is given.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{1,2}:\d{2}$/;

function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function compactDate(date) {
  return date.replace(/-/g, "");
}

function nextDay(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10).replace(/-/g, "");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function isCalendarDate(value) {
  return DATE.test(String(value ?? ""));
}

// events: [{ title, date: "YYYY-MM-DD", time?: "HH:MM", description? }]
export function buildCalendar(events) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PaperLens//EN", "CALSCALE:GREGORIAN"];
  for (const event of events) {
    const date = String(event?.date ?? "");
    if (!DATE.test(date) || !event.title) {
      continue;
    }
    lines.push(
      "BEGIN:VEVENT",
      `UID:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@paperlens`,
      `DTSTAMP:${timestamp()}`
    );
    const time = String(event.time ?? "");
    if (TIME.test(time)) {
      const [hours, minutes] = time.split(":");
      lines.push(`DTSTART:${compactDate(date)}T${hours.padStart(2, "0")}${minutes}00`, "DURATION:PT1H");
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(date)}`, `DTEND;VALUE=DATE:${nextDay(date)}`);
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
