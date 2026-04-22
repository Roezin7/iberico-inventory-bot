// src/services/parserService.js
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const OpenAI = require("openai");
const sharp = require("sharp");
const {
  cleanHumanText,
  normalizeProductLookupKey,
  parseFlexibleNumber,
  parseNameQtyLine,
} = require("../utils/textUtils");

const execFileAsync = promisify(execFile);

let cachedClient = null;
let cachedClientKey = null;
let cachedGhostscriptAvailability = null;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"]);

// Puedes cambiarlo desde Render si quieres: OPENAI_VISION_MODEL=gpt-4.1-mini
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.2";
const VISION_MAX_OUTPUT_TOKENS = readPositiveIntegerEnv("OPENAI_VISION_MAX_OUTPUT_TOKENS", 6000);
const PDF_GHOSTSCRIPT_DPI = readPositiveIntegerEnv("PDF_GHOSTSCRIPT_DPI", 220);

function toNum(x) {
  return parseFlexibleNumber(x);
}
function cleanName(s) {
  return cleanHumanText(s);
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

function readPositiveIntegerEnv(name, fallbackValue) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClient = new OpenAI({ apiKey });
    cachedClientKey = apiKey;
  }

  return cachedClient;
}

function detectVisionInputKind({ mimeType, fileName, buffer }) {
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  const normalizedFileName = String(fileName || "").trim().toLowerCase();

  if (Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (normalizedMimeType === "application/pdf") return "pdf";
  if (normalizedMimeType.startsWith("image/")) return "image";

  const extension = path.extname(normalizedFileName);
  if (extension === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";

  return null;
}

function ensureSupportedVisionInput(options) {
  const kind = detectVisionInputKind(options);
  if (!kind) {
    const suffix = cleanHumanText(options.mimeType || options.fileName || "unknown");
    throw new Error(`unsupported_mime:${suffix || "unknown"}`);
  }
  return kind;
}

function buildVisionResponseFormat(mode) {
  if (mode === "semana") {
    return {
      type: "json_schema",
      name: "iberico_semana_inventory_rows",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["producto", "local", "bodega", "total"],
              properties: {
                producto: { type: "string" },
                local: { type: "string" },
                bodega: { type: "string" },
                total: { type: "string" },
              },
            },
          },
        },
      },
    };
  }

  return {
    type: "json_schema",
    name: "iberico_ingreso_inventory_rows",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["producto", "compra"],
            properties: {
              producto: { type: "string" },
              compra: { type: "string" },
            },
          },
        },
      },
    },
  };
}

// Texto: "Producto = cantidad"
function parseLinesFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => cleanHumanText(x))
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const parsed = parseNameQtyLine(line);
    if (parsed) items.push(parsed);
  }
  return items;
}

// ✅ Mejor preproceso para “tablas con texto chico”
async function normalizeImageForVision(buffer, { preferLossless = false } = {}) {
  // Estrategia:
  // - rotate (EXIF)
  // - resize más grande (2800px) para que no se “pierdan” números
  // - normalize/gamma para contraste
  // - sharpen para líneas + dígitos
  // - png lossless para PDFs renderizados; jpeg de alta calidad para fotos
  const pipeline = sharp(buffer)
    .rotate()
    .resize({ width: 2800, height: 2800, fit: "inside", withoutEnlargement: false })
    .normalize()
    .gamma(1.15)
    .sharpen({ sigma: 1.2, m1: 0.8, m2: 2.0 });

  if (preferLossless) {
    return pipeline.png({ compressionLevel: 9 }).toBuffer();
  }

  return pipeline.jpeg({ quality: 92 }).toBuffer();
}

async function buildImageInputContent(buffer, { preferLossless = false } = {}) {
  const img = await normalizeImageForVision(buffer, { preferLossless });
  const mimeType = preferLossless ? "image/png" : "image/jpeg";
  return {
    type: "input_image",
    image_url: `data:${mimeType};base64,${img.toString("base64")}`,
  };
}

function buildPdfInputContent(buffer, fileName) {
  const normalizedFileName = path.basename(String(fileName || "document.pdf").trim() || "document.pdf");
  const pdfFileName = normalizedFileName.toLowerCase().endsWith(".pdf")
    ? normalizedFileName
    : `${normalizedFileName}.pdf`;

  return {
    type: "input_file",
    filename: pdfFileName,
    file_data: buffer.toString("base64"),
  };
}

function systemPromptSemana() {
  return (
    `Eres un extractor ESTRICTO del inventario semanal de Ibérico.\n` +
    `La entrada puede ser una foto, una imagen o un PDF multipágina.\n` +
    `Solo debes extraer las tablas del "Formato actual de Inventario" con columnas Producto | Local | Bodega | Total.\n` +
    `Ignora por completo páginas o bloques del "Formato de lo que se comprará", encabezados, subtotales, filas de sección (ej: Vino, Jugos, Congelados), notas largas, advertencias escritas a mano y texto decorativo.\n\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido. Sin texto extra.\n` +
    `- Formato exacto:\n` +
    `  {"items":[{"producto":"<string>","local":"<string>","bodega":"<string>","total":"<string>"}]}\n` +
    `- Los números pueden ser enteros o decimales.\n` +
    `- No inventes valores ni productos.\n` +
    `- Si una celda está vacía o no es confiable, usa cadena vacía "".\n` +
    `- Si Local/Bodega tienen notas mezcladas, conserva solo el valor numérico si es claro; si no, deja "". \n` +
    `- Si Total es legible, consérvalo aunque Local/Bodega queden vacíos.\n` +
    `- Incluye solo filas de productos reales.\n`
  );
}

function systemPromptIngreso() {
  return (
    `Eres un extractor ESTRICTO de compras semanales de Ibérico.\n` +
    `La entrada puede ser una foto, una imagen o un PDF multipágina.\n` +
    `Solo debes extraer las tablas del "Formato de lo que se comprará" o "Formato de Compra" con columnas Producto | Compra.\n` +
    `Ignora páginas del "Formato actual de Inventario", secciones, notas, encabezados y filas vacías.\n\n` +
    `REGLAS:\n` +
    `- Devuelve SOLO JSON válido. Sin texto extra.\n` +
    `- Formato exacto:\n` +
    `  {"items":[{"producto":"<string>","compra":"<string>"}]}\n` +
    `- No inventes ceros.\n` +
    `- Si está vacío o no legible, usa cadena vacía "".\n` +
    `- Solo productos reales.\n`
  );
}

function buildVisionUserText({ mode, repairList, inputKind }) {
  const modeLabel = mode === "semana" ? "inventario semanal" : "compras semanales";
  const scopeLabel =
    inputKind === "pdf"
      ? `El documento puede tener varias páginas; combina todas las filas válidas del ${modeLabel}.`
      : `La imagen puede tener notas manuscritas; conserva solo las filas válidas del ${modeLabel}.`;

  if (repairList?.length) {
    return (
      `${scopeLabel}\n` +
      `Haz una segunda lectura SOLO para estos productos y corrige sus cantidades si la tabla los contiene:\n` +
      `- ${repairList.join("\n- ")}\n` +
      `Devuelve SOLO el JSON en el formato indicado.`
    );
  }

  return `${scopeLabel}\nExtrae todas las filas válidas y devuelve SOLO el JSON indicado.`;
}

// Llamada única a Vision
async function visionExtract({ mode, inputContent, repairList, inputKind }) {
  const system = mode === "semana" ? systemPromptSemana() : systemPromptIngreso();
  const userText = buildVisionUserText({ mode, repairList, inputKind });

  const resp = await getOpenAIClient().responses.create({
    model: VISION_MODEL,
    max_output_tokens: VISION_MAX_OUTPUT_TOKENS,
    instructions: system,
    text: {
      format: buildVisionResponseFormat(mode),
      verbosity: "low",
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          inputContent,
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

function normalizeSemanaRows(parsed) {
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

    rows.push({ rawName, local, bodega, total });
  }

  return rows;
}

function buildSemanaOutput(rows) {
  const out = [];
  for (const row of rows) {
    if (row.total === null) continue;
    out.push({ rawName: row.rawName, qty: row.total });
  }
  return out;
}

function normalizeIngresoItems(parsed) {
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

function dedupeExactItems(items) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    if (!item?.rawName || item.qty === null || item.qty === undefined) continue;
    const key = `${normalizeProductLookupKey(item.rawName)}::${Number(item.qty).toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function extractItemsFromVisionInput({ mode, inputContent, inputKind }) {
  const parsed = await visionExtract({ mode, inputContent, inputKind });

  if (mode === "semana") {
    const rows = normalizeSemanaRows(parsed);

    const repairList = suspiciousSemana(rows);
    if (repairList.length) {
      const parsed2 = await visionExtract({ mode, inputContent, repairList, inputKind });
      const repairedRows = normalizeSemanaRows(parsed2);
      const fixMap = new Map(repairedRows.map((row) => [row.rawName, row]));

      for (const row of rows) {
        if (!fixMap.has(row.rawName)) continue;
        const fixed = fixMap.get(row.rawName);
        row.local = fixed.local;
        row.bodega = fixed.bodega;
        row.total = fixed.total;
      }
    }

    return dedupeExactItems(buildSemanaOutput(rows));
  }

  return dedupeExactItems(normalizeIngresoItems(parsed));
}

async function isGhostscriptAvailable() {
  if (!cachedGhostscriptAvailability) {
    cachedGhostscriptAvailability = execFileAsync("gs", ["--version"])
      .then(() => true)
      .catch(() => false);
  }

  return cachedGhostscriptAvailability;
}

async function renderPdfPagesWithGhostscript(buffer) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iberico-pdf-"));
  const inputPath = path.join(tempDir, "input.pdf");
  const outputPattern = path.join(tempDir, "page-%03d.png");

  try {
    await fs.writeFile(inputPath, buffer);
    await execFileAsync(
      "gs",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dTextAlphaBits=4",
        "-dGraphicsAlphaBits=4",
        "-sDEVICE=png16m",
        `-r${PDF_GHOSTSCRIPT_DPI}`,
        `-sOutputFile=${outputPattern}`,
        inputPath,
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    );

    const fileNames = (await fs.readdir(tempDir))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((left, right) => left.localeCompare(right));

    if (!fileNames.length) throw new Error("pdf_rasterized_without_pages");

    return Promise.all(
      fileNames.map(async (fileName) => ({
        label: fileName,
        buffer: await fs.readFile(path.join(tempDir, fileName)),
      }))
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractItemsFromPdfFallback({ mode, buffer }) {
  if (!(await isGhostscriptAvailable())) return [];

  const pages = await renderPdfPagesWithGhostscript(buffer);
  const collected = [];

  for (const page of pages) {
    try {
      const inputContent = await buildImageInputContent(page.buffer, { preferLossless: true });
      const pageItems = await extractItemsFromVisionInput({
        mode,
        inputContent,
        inputKind: "image",
      });

      collected.push(...pageItems);
    } catch (error) {
      console.error("pdf raster fallback page failed:", page.label, error?.message || error);
    }
  }

  return dedupeExactItems(collected);
}

async function extractItemsFromBuffer({ mode, buffer, mimeType, fileName }) {
  const inputKind = ensureSupportedVisionInput({ mimeType, fileName, buffer });

  if (inputKind === "image") {
    const inputContent = await buildImageInputContent(buffer);
    return extractItemsFromVisionInput({ mode, inputContent, inputKind: "image" });
  }

  const pdfInputContent = buildPdfInputContent(buffer, fileName);
  let directItems = [];
  let directError = null;

  try {
    directItems = await extractItemsFromVisionInput({
      mode,
      inputContent: pdfInputContent,
      inputKind: "pdf",
    });
    if (directItems.length) return directItems;
  } catch (error) {
    directError = error;
    console.error("pdf direct extraction failed:", error?.message || error);
  }

  const fallbackItems = await extractItemsFromPdfFallback({ mode, buffer });
  if (fallbackItems.length) return fallbackItems;

  if (directError) throw directError;
  return [];
}

module.exports = {
  detectVisionInputKind,
  parseLinesFromText,
  extractItemsFromBuffer,
};
