process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectVisionInputKind,
  parseLinesFromText,
  extractItemsFromBuffer,
} = require("../src/services/parserService");

test("parseLinesFromText conserva las lineas validas y descarta ruido", () => {
  const text = `
• “Agua\u00A0Tónica”: 1,5
Basura
- Don’s Mix = 2
"Jarabe   de  limón" = 0,75
`;

  assert.deepEqual(parseLinesFromText(text), [
    { rawName: "Agua Tónica", qty: 1.5 },
    { rawName: "Don's Mix", qty: 2 },
    { rawName: "Jarabe de limón", qty: 0.75 },
  ]);
});

test("detectVisionInputKind detecta PDFs por mime, extension y magic bytes", () => {
  assert.equal(detectVisionInputKind({ mimeType: "application/pdf" }), "pdf");
  assert.equal(detectVisionInputKind({ mimeType: "application/octet-stream", fileName: "inventario.PDF" }), "pdf");
  assert.equal(detectVisionInputKind({ buffer: Buffer.from("%PDF-1.4 sample") }), "pdf");
});

test("detectVisionInputKind detecta imagenes por mime o extension", () => {
  assert.equal(detectVisionInputKind({ mimeType: "image/jpeg" }), "image");
  assert.equal(detectVisionInputKind({ mimeType: "application/octet-stream", fileName: "foto.heic" }), "image");
});

test("extractItemsFromBuffer rechaza documentos no soportados antes de invocar OpenAI", async () => {
  await assert.rejects(
    extractItemsFromBuffer({
      mode: "semana",
      buffer: Buffer.from("hola"),
      mimeType: "text/plain",
      fileName: "nota.txt",
    }),
    /unsupported_mime:text\/plain/
  );
});
