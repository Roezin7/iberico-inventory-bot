// src/services/parserService.js
const OpenAI = require("openai");
const sharp = require("sharp");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Puedes cambiarlo desde Render si quieres: OPENAI_VISION_MODEL=gpt-4.1-mini
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.2";

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

// ✅ Mejor preproceso para “tablas con texto chico”
async function normalizeImageForVision(buffer) {
  // Estrategia:
  // - rotate (EXIF)
  // - resize más grande (2400px) para que no se “pierdan” números
  // - normalize/gamma para contraste
  // - sharpen para líneas + dígitos
  // - jpeg quality alto
  return sharp(buffer)
    .rotate()
    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: false })
    .normalize()
    .gamma(1.15)
    .sharpen({ sigma: 1.2, m1: 0.8, m2: 2.0 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function systemPromptSemana() {
  return (
    `Eres un extractor ESTRICTO del "Formato actual de Inventario — Alcohol/Cocina" de Ibérico.\n` +
    `La imagen es una tabla con columnas: Producto | Local | Bodega | Total.\n` +
    `Hay renglones de sección (ej: Jugos, Congelados, etc). ESOS SE IGNORAN.\n\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido. Sin texto extra.\n` +
    `- Formato exacto:\n` +
    `  {"items":[{"producto":"<string>","local":"<string|null>","bodega":"<string|null>","total":"<string|null>"}]}\n` +
    `- OJO: los números pueden ser decimales (0.75, 1.5, 2.25).\n` +
    `- NO inventes ceros. Si no estás seguro, usa null.\n` +
    `- Si la celda está vacía, usa null.\n` +
    `- Incluye solo filas de productos reales (no encabezados, no secciones).\n`
  );
}

function systemPromptIngreso() {
  return (
    `Eres un extractor ESTRICTO del "Formato de Compra — Alcohol/Cocina" de Ibérico.\n` +
    `Tabla: Producto | Compra.\n\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido. Sin texto extra.\n` +
    `- Formato exacto:\n` +
    `  {"items":[{"producto":"<string>","compra":"<string|null>"}]}\n` +
    `- NO inventes ceros. Si no estás seguro, usa null.\n` +
    `- Si está vacío/no legible, null.\n` +
    `- Solo productos reales.\n`
  );
}

// Llamada única a Vision
async function visionExtract({ mode, dataUrl, repairList }) {
  const system = mode === "semana" ? systemPromptSemana() : systemPromptIngreso();

  const userText =
    repairList && repairList.length
      ? `Extrae SOLO estos productos (ignora todo lo demás):\n- ${repairList.join("\n- ")}\nDevuelve SOLO el JSON en el formato indicado.`
      : `Extrae todas las filas de producto del formato y devuelve SOLO el JSON indicado.`;

  const resp = await client.responses.create({
    model: VISION_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  const text = resp.output_text || "";
  return safeJsonParse(text);
}

// Heurística: detectar filas sospechosas (para 2do pase)
function suspiciousSemana(rows) {
  const bad = [];
  for (const r of rows) {
    const name = r.rawName;

    const local = r.local;
    const bodega = r.bodega;
    const total = r.total;

    // Si total existe pero no cuadra con local+bodega, sospechoso
    if (total !== null && (local !== null || bodega !== null)) {
      const sum = (local ?? 0) + (bodega ?? 0);
      if (Math.abs(total - sum) > 0.26) { // tolerancia por lectura decimal
        bad.push(name);
        continue;
      }
    }

    // Si total = 0 y local/bodega no son 0, sospechoso
    if (total === 0 && ((local ?? 0) + (bodega ?? 0)) > 0.1) {
      bad.push(name);
      continue;
    }

    // Si local o bodega son null pero total sí, ok.
    // Si todo null, lo omitimos luego.
  }
  return [...new Set(bad)].slice(0, 25); // limita repair
}

async function extractItemsFromBuffer({ mode, buffer }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const img = await normalizeImageForVision(buffer);
  const b64 = img.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  // 1) Primer pase
  const parsed = await visionExtract({ mode, dataUrl });

  if (mode === "semana") {
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const rows = [];

    for (const it of items) {
      const rawName = cleanName(it?.producto);
      if (!rawName) continue;

      const local = toNum(it?.local);
      const bodega = toNum(it?.bodega);
      const totalCell = toNum(it?.total);

      // total final: si totalCell viene, úsalo; si no, calcula si hay local/bodega
      let total = totalCell;
      if (total === null && (local !== null || bodega !== null)) {
        total = (local ?? 0) + (bodega ?? 0);
      }

      // guardamos para analizar inconsistencias
      rows.push({ rawName, local, bodega, total });
    }

    // 2) Segundo pase (repair) si hay inconsistencias
    const repairList = suspiciousSemana(rows);
    if (repairList.length) {
      const parsed2 = await visionExtract({ mode, dataUrl, repairList });
      const items2 = Array.isArray(parsed2?.items) ? parsed2.items : [];

      const fixMap = new Map(); // producto -> {local,bodega,total}
      for (const it of items2) {
        const rawName = cleanName(it?.producto);
        if (!rawName) continue;
        const local = toNum(it?.local);
        const bodega = toNum(it?.bodega);
        const totalCell = toNum(it?.total);
        let total = totalCell;
        if (total === null && (local !== null || bodega !== null)) total = (local ?? 0) + (bodega ?? 0);
        fixMap.set(rawName, { local, bodega, total });
      }

      // aplica fixes
      for (const r of rows) {
        if (fixMap.has(r.rawName)) {
          const f = fixMap.get(r.rawName);
          r.local = f.local;
          r.bodega = f.bodega;
          r.total = f.total;
        }
      }
    }

    // 3) salida final para tu pipeline: [{rawName, qty}]
    const out = [];
    for (const r of rows) {
      if (r.total === null) continue; // si no hay números, omitimos
      out.push({ rawName: r.rawName, qty: r.total });
    }
    return out;
  }

  // modo ingreso
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const out = [];
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