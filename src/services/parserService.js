// src/services/parserService.js
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function toNum(x) {
  if (x === null || x === undefined) return null;
  const s = String(x)
    .trim()
    .replace(/\s+/g, "")
    .replace(",", "."); // 1,5 -> 1.5
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanName(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

/**
 * Texto: "Producto = cantidad"
 */
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

/**
 * Intenta parsear JSON aunque venga con texto alrededor.
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    // intenta extraer el primer bloque {...} o [...]
    const s = String(str || "");
    const firstObj = s.indexOf("{");
    const lastObj = s.lastIndexOf("}");
    if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
      try {
        return JSON.parse(s.slice(firstObj, lastObj + 1));
      } catch (_) {}
    }
    const firstArr = s.indexOf("[");
    const lastArr = s.lastIndexOf("]");
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
      try {
        return JSON.parse(s.slice(firstArr, lastArr + 1));
      } catch (_) {}
    }
    return null;
  }
}

/**
 * OpenAI Vision:
 * Recibe buffer de imagen y regresa [{rawName, qty}]
 *
 * Requisitos: imágenes claras (jpg/png/webp). Docs: Vision guide.  [oai_citation:1‡OpenAI Developers](https://developers.openai.com/api/docs/guides/images-vision/?utm_source=chatgpt.com)
 */
async function extractItemsFromBuffer({ mode, buffer, mimeType }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const mt = String(mimeType || "").toLowerCase();

  // Por ahora: solo imagen. Si mandan PDF, pedir foto.
  if (!mt.startsWith("image/")) {
    // Telegram a veces manda fotos como application/octet-stream si es documento raro,
    // pero en general queremos forzar foto.
    throw new Error(`unsupported_mime:${mt || "unknown"}`);
  }

  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mt};base64,${b64}`;

  const system =
    `Eres un extractor estricto de inventario para un restaurante.\n` +
    `Vas a leer una FOTO de una tabla hecha a mano.\n` +
    `El usuario está en modo: "${mode}".\n\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido, sin texto extra.\n` +
    `- Formato EXACTO:\n` +
    `  {"items":[{"producto":"<string>","total":<number>}, ...]}\n` +
    `- "producto" debe ser el texto tal cual (sin inventarte cosas).\n` +
    `- "total" debe ser número (puede ser decimal). Si no hay número, omite esa fila.\n` +
    `- Ignora encabezados como "Producto", "Local", "Bodega", "Total", "Compra".\n` +
    `- Si ves columnas Local/Bodega/Total, usa TOTAL.\n` +
    `- Si es formato de compra, usa la columna "Compra" como total.\n` +
    `- No incluyas filas vacías ni categorías.\n` +
    `- Si no puedes leer nada, devuelve {"items":[]}.\n`;

  const resp = await client.responses.create({
    model: "gpt-4.1", // vision recomendado (multimodal).  [oai_citation:2‡OpenAI Developers](https://developers.openai.com/api/docs/guides/images-vision/?utm_source=chatgpt.com)
    input: [
      {
        role: "system",
        content: [{ type: "text", text: system }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extrae los items del inventario en JSON." },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  // En el SDK, normalmente puedes usar resp.output_text; si no, buscamos texto.
  const text =
    resp.output_text ||
    (resp.output && Array.isArray(resp.output)
      ? resp.output
          .map((o) => (o.content || []).map((c) => c.text).filter(Boolean).join("\n"))
          .filter(Boolean)
          .join("\n")
      : "") ||
    "";

  const parsed = safeJsonParse(text);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];

  // Normaliza a [{rawName, qty}]
  const out = [];
  for (const it of items) {
    const rawName = cleanName(it?.producto);
    const qty = toNum(it?.total);
    if (!rawName || qty === null) continue;
    out.push({ rawName, qty });
  }

  return out;
}

module.exports = {
  parseLinesFromText,
  extractItemsFromBuffer,
};