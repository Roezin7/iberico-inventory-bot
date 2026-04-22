process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLinesFromText } = require("../src/services/parserService");

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
