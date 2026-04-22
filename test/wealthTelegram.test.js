process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDirectArgs,
  parseDirectPayload,
} = require("../src/handlers/wealth/telegram");

test("parseDirectArgs entiende key=value y notas con comillas", () => {
  const parsed = parseDirectArgs(
    `/valor_semanal caja=5000 fuerte=20000 banco=35000 inventario=auto fecha=2026-04-21 notes="corte semanal normal"`
  );

  assert.deepEqual(parsed, {
    caja: "5000",
    fuerte: "20000",
    banco: "35000",
    inventario: "auto",
    fecha: "2026-04-21",
    notes: "corte semanal normal",
  });
});

test("parseDirectPayload usa inventario automatico cuando se omite", () => {
  const parsed = parseDirectPayload({
    caja: "5000",
    fuerte: "20000",
    banco: "35000",
    fecha: "2026-04-21",
  });

  assert.deepEqual(parsed, {
    value: {
      snapshotDate: "2026-04-21",
      cajaOperativa: 5000,
      cajaFuerte: 20000,
      banco: 35000,
      inventario: null,
      inventarioSource: "auto",
      notes: null,
      overwrite: false,
    },
  });
});

test("parseDirectPayload acepta inventario manual y overwrite", () => {
  const parsed = parseDirectPayload({
    caja: "5000",
    fuerte: "20000",
    banco: "35000",
    inventario: "120000",
    fecha: "2026-04-21",
    sobrescribir: "si",
    nota: "ajuste manual",
  });

  assert.deepEqual(parsed, {
    value: {
      snapshotDate: "2026-04-21",
      cajaOperativa: 5000,
      cajaFuerte: 20000,
      banco: 35000,
      inventario: 120000,
      inventarioSource: "manual",
      notes: "ajuste manual",
      overwrite: true,
    },
  });
});
