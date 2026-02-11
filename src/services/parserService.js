// src/services/parserService.js
const OpenAI = require("openai");
const sharp = require("sharp");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function toNum(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).trim().replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanName(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    const s = String(str || "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b !== -1 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
    }
    const c = s.indexOf("[");
    const d = s.lastIndexOf("]");
    if (c !== -1 && d !== -1 && d > c) {
      try { return JSON.parse(s.slice(c, d + 1)); } catch (_) {}
    }
    return null;
  }
}

// Texto: "Producto = cantidad"
function parseLinesFromText(text) {
  const lines = String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*=\s*([0-9]+(?:[.,][0-9]+)?)$/);
    if (!m) continue;
    const rawName = cleanName(m[1]);
    const qty = toNum(m[2]);
    if (!rawName || qty === null) continue;
    items.push({ rawName, qty });
  }
  return items;
}

// Comprime/rescala para que Vision no falle por tamaño
async function normalizeImageForVision(buffer) {
  // Convierte cualquier cosa a jpeg optimizado
  // max 1600px para mantener legible y estable
  return sharp(buffer)
    .rotate() // respeta orientación EXIF
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

// Prompt ultra específico para TUS formatos
function buildSystemPrompt(mode) {
  if (mode === "semana") {
    return (
      `Eres un extractor ESTRICTO para el formato "Formato de Inventario — Alcohol/Cocina" del restaurante Ibérico.\n` +
      `La imagen es una tabla con columnas: Producto | Local | Bodega | Total.\n` +
      `También hay renglones de SECCIÓN como: "Jugos", "Congelados", "Lácteos y Quesos", "Carnes frías y embutidos", "Salsas, condimentos y generales", "Limpieza y desechable", etc.\n` +
      `REGLAS:\n` +
      `- Devuelve SOLO JSON válido, sin texto extra.\n` +
      `- Formato exacto:\n` +
      `  {"items":[{"producto":"<string>","local":<number|null>,"bodega":<number|null>,"total":<number|null>}]}\n` +
      `- Incluye SOLO filas que sean PRODUCTOS reales.\n` +
      `- Ignora encabezados y renglones de sección/categoría.\n` +
      `- Para cada producto:\n` +
      `   - Si la columna TOTAL tiene un número, ponlo en "total".\n` +
      `   - Si TOTAL está vacío pero Local/Bodega tienen números, pon local y bodega; total puede ir null.\n` +
      `- Si no hay número en ninguna columna, omite esa fila.\n` +
      `- Si no puedes leer nada, devuelve {"items":[]}.\n`
    );
  }

  // compras/ingreso
  return (
    `Eres un extractor ESTRICTO para el formato "Formato de Compra — Alcohol/Cocina" del restaurante Ibérico.\n` +
    `La imagen es una tabla con columnas: Producto | Compra.\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido, sin texto extra.\n` +
    `- Formato exacto:\n` +
    `  {"items":[{"producto":"<string>","compra":<number|null>}]}\n` +
    `- Incluye SOLO filas que sean PRODUCTOS reales.\n` +
    `- Ignora encabezados y renglones de sección/categoría.\n` +
    `- "compra" debe ser número. Si está vacío/no legible, omite la fila.\n` +
    `- Si no puedes leer nada, devuelve {"items":[]}.\n`
  );
}

/**
 * Vision → items normalizados a [{rawName, qty}]
 */
async function extractItemsFromBuffer({ mode, buffer, mimeType }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // Convertimos a JPG optimizado siempre (más estable)
  const img = await normalizeImageForVision(buffer);
  const b64 = img.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  const system = buildSystemPrompt(mode);

  const resp = await client.responses.create({
    model: "gpt-4.1-mini", // más rápido/barato y soporta visión
    input: [
      { role: "system", content: [{ type: "text", text: system }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Extrae todas las filas de producto del formato y devuelve SOLO el JSON indicado." },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  const text = resp.output_text || "";
  const parsed = safeJsonParse(text);

  // Normalización final
  const out = [];

  if (mode === "semana") {
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    for (const it of items) {
      const rawName = cleanName(it?.producto);
      if (!rawName) continue;

      const local = toNum(it?.local);
      const bodega = toNum(it?.bodega);
      let total = toNum(it?.total);

      // Si no viene total, lo calculamos si hay local/bodega
      if (total === null && (local !== null || bodega !== null)) {
        total = (local ?? 0) + (bodega ?? 0);
      }

      // OJO: permitimos 0
      if (total === null) continue;

      out.push({ rawName, qty: total });
    }
    return out;
  }

  // modo ingreso: usa "compra"
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  for (const it of items) {
    const rawName = cleanName(it?.producto);
    const qty = toNum(it?.compra);
    if (!rawName || qty === null) continue;
    out.push({ rawName, qty });
  }
  return out;
}

module.exports = {
  parseLinesFromText,
  extractItemsFromBuffer,
};