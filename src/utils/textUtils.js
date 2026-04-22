const WEIRD_SPACES_RE = /[\s\u00A0\u1680\u180E\u2000-\u200D\u202F\u205F\u3000]+/g;
const FANCY_SINGLE_QUOTES_RE = /[’‘`´ʻʼʹ]/g;
const FANCY_DOUBLE_QUOTES_RE = /[“”„‟«»]/g;
const BULLET_PREFIX_RE = /^\s*[-*•●◦▪▫‣∙·]+\s*/;

function normalizeSpaces(value) {
  return String(value || "").replace(WEIRD_SPACES_RE, " ");
}

function normalizeQuotes(value) {
  return String(value || "")
    .replace(FANCY_SINGLE_QUOTES_RE, "'")
    .replace(FANCY_DOUBLE_QUOTES_RE, '"');
}

function cleanHumanText(value) {
  return normalizeQuotes(normalizeSpaces(value)).trim().replace(/\s+/g, " ");
}

function stripBulletPrefix(value) {
  return cleanHumanText(value).replace(BULLET_PREFIX_RE, "").trim();
}

function stripWrappingQuotes(value) {
  let out = cleanHumanText(value);

  while (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1).trim();
  }

  return out;
}

function normalizeProductLookupKey(value) {
  return stripWrappingQuotes(stripBulletPrefix(value))
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFlexibleNumber(value) {
  if (value === null || value === undefined) return null;

  let raw = cleanHumanText(value).replace(/\s+/g, "");
  if (!raw) return null;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");

  if (hasComma && hasDot) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      raw = raw.replace(/\./g, "").replace(",", ".");
    } else {
      raw = raw.replace(/,/g, "");
    }
  } else if (hasComma) {
    raw = raw.replace(",", ".");
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNameQtyLine(line) {
  const normalizedLine = stripBulletPrefix(line);
  if (!normalizedLine) return null;

  const match = normalizedLine.match(/^(.+?)\s*(?:=|:)\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
  if (!match) return null;

  const rawName = stripWrappingQuotes(match[1]);
  const qty = parseFlexibleNumber(match[2]);
  if (!rawName || qty === null) return null;

  return { rawName, qty };
}

function parseAliasMappingLine(line) {
  const normalizedLine = stripBulletPrefix(line);
  if (!normalizedLine) return null;

  const match = normalizedLine.match(/^(.+?)\s*(?:=|:)\s*(.+?)\s*$/);
  if (!match) return null;

  const alias = stripWrappingQuotes(match[1]);
  const productName = stripWrappingQuotes(match[2]);
  if (!alias || !productName) return null;

  return { alias, productName };
}

function norm(value) {
  return normalizeProductLookupKey(value);
}

module.exports = {
  cleanHumanText,
  norm,
  normalizeProductLookupKey,
  parseAliasMappingLine,
  parseFlexibleNumber,
  parseNameQtyLine,
  stripBulletPrefix,
  stripWrappingQuotes,
};
