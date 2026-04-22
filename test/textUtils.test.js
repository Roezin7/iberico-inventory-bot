const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeProductLookupKey,
  parseAliasMappingLine,
  parseFlexibleNumber,
  parseNameQtyLine,
} = require("../src/utils/textUtils");

test("parseNameQtyLine soporta bullets, comillas raras, NBSP, dos puntos y decimal con coma", () => {
  assert.deepEqual(parseNameQtyLine(`• “Agua\u00A0Tónica” : 1,5`), {
    rawName: "Agua Tónica",
    qty: 1.5,
  });
});

test("parseNameQtyLine soporta igual y apostrofes unicode", () => {
  assert.deepEqual(parseNameQtyLine(`- Don’s Mix = 2`), {
    rawName: "Don's Mix",
    qty: 2,
  });
});

test("normalizeProductLookupKey quita acentos, apostrofes y espacios sobrantes", () => {
  assert.equal(normalizeProductLookupKey(`  “Água   d’Jamaica”  `), "agua djamaica");
});

test("parseFlexibleNumber entiende separadores mixtos", () => {
  assert.equal(parseFlexibleNumber("1,250.75"), 1250.75);
  assert.equal(parseFlexibleNumber("1.250,75"), 1250.75);
  assert.equal(parseFlexibleNumber("0,75"), 0.75);
});

test("parseAliasMappingLine soporta formatos flexibles", () => {
  assert.deepEqual(parseAliasMappingLine(`• "coca zero" : Coca Zero`), {
    alias: "coca zero",
    productName: "Coca Zero",
  });
});
