function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getTodayDateString() {
  return formatDateOnly(new Date());
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return formatDateOnly(parsed);
}

function addDays(dateString, days) {
  const parsed = parseDateOnly(dateString);
  if (!parsed) return null;

  const [year, month, day] = parsed.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + Number(days || 0));
  return formatDateOnly(date);
}

function clampInteger(value, { defaultValue, min = 1, max = 52 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

module.exports = {
  addDays,
  clampInteger,
  formatDateOnly,
  getTodayDateString,
  parseDateOnly,
};
