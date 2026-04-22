const test = require("node:test");
const assert = require("node:assert/strict");

const { addDays, clampInteger, parseDateOnly } = require("../src/utils/dateUtils");

test("parseDateOnly valida fechas ISO reales", () => {
  assert.equal(parseDateOnly("2026-04-21"), "2026-04-21");
  assert.equal(parseDateOnly("2026-02-30"), null);
  assert.equal(parseDateOnly("21-04-2026"), null);
});

test("addDays suma dias sin romper formato", () => {
  assert.equal(addDays("2026-04-21", 7), "2026-04-28");
});

test("clampInteger aplica default y limites", () => {
  assert.equal(clampInteger(undefined, { defaultValue: 12, min: 1, max: 20 }), 12);
  assert.equal(clampInteger("0", { defaultValue: 12, min: 1, max: 20 }), 1);
  assert.equal(clampInteger("25", { defaultValue: 12, min: 1, max: 20 }), 20);
});
