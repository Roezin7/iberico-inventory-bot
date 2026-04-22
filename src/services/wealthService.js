const db = require("../db");
const inventoryService = require("./inventoryService");
const { clampInteger, formatDateOnly, getTodayDateString, parseDateOnly } = require("../utils/dateUtils");
const { cleanHumanText } = require("../utils/textUtils");

const WEALTH_SELECT = `
  select
    id,
    snapshot_date,
    caja_operativa,
    caja_fuerte,
    banco,
    inventario,
    inventario_source,
    inventory_total_products,
    inventory_missing_cost_products,
    notes,
    created_at,
    updated_at,
    (caja_operativa + caja_fuerte + banco + inventario) as total_wealth
  from business_wealth_snapshots
`;

function normalizeSnapshotDate(value) {
  if (!value) return null;
  if (value instanceof Date) return formatDateOnly(value);
  return parseDateOnly(value) || String(value);
}

function percentChange(current, previous) {
  const currentNumber = Number(current || 0);
  const previousNumber = Number(previous || 0);

  if (previousNumber === 0) {
    return currentNumber === 0 ? 0 : null;
  }

  return ((currentNumber - previousNumber) / previousNumber) * 100;
}

function normalizeWealthSnapshot(row) {
  if (!row) return null;

  const cajaOperativa = Number(row.caja_operativa || 0);
  const cajaFuerte = Number(row.caja_fuerte || 0);
  const banco = Number(row.banco || 0);
  const inventario = Number(row.inventario || 0);
  const totalWealth =
    row.total_wealth === null || row.total_wealth === undefined
      ? cajaOperativa + cajaFuerte + banco + inventario
      : Number(row.total_wealth);
  const cashTotal = cajaOperativa + cajaFuerte + banco;

  return {
    id: row.id ? Number(row.id) : null,
    snapshot_date: normalizeSnapshotDate(row.snapshot_date),
    caja_operativa: cajaOperativa,
    caja_fuerte: cajaFuerte,
    banco: banco,
    inventario: inventario,
    inventario_source: row.inventario_source,
    inventory_total_products: Number(row.inventory_total_products || 0),
    inventory_missing_cost_products: Number(row.inventory_missing_cost_products || 0),
    notes: row.notes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    total_wealth: totalWealth,
    cash_total: cashTotal,
    cash_ratio: totalWealth === 0 ? null : cashTotal / totalWealth,
    inventory_ratio: totalWealth === 0 ? null : inventario / totalWealth,
  };
}

function average(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + Number(value || 0), 0) / numbers.length;
}

function validateSnapshotDate(snapshotDate) {
  const parsed = parseDateOnly(snapshotDate || getTodayDateString());
  if (!parsed) {
    return { error: "invalid_snapshot_date" };
  }

  return { value: parsed };
}

function validateMoneyField(fieldName, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { error: `missing_${fieldName}` };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return { error: `invalid_${fieldName}` };
  }

  return { value: parsed };
}

function validateWealthPayload(payload) {
  const notes = cleanHumanText(payload.notes || "") || null;
  const dateValidation = validateSnapshotDate(payload.snapshotDate);
  if (dateValidation.error) return dateValidation;

  const cajaOperativa = validateMoneyField("caja_operativa", payload.cajaOperativa);
  if (cajaOperativa.error) return cajaOperativa;

  const cajaFuerte = validateMoneyField("caja_fuerte", payload.cajaFuerte);
  if (cajaFuerte.error) return cajaFuerte;

  const banco = validateMoneyField("banco", payload.banco);
  if (banco.error) return banco;

  const inventario = validateMoneyField("inventario", payload.inventario);
  if (inventario.error) return inventario;

  const hasNegative = [cajaOperativa.value, cajaFuerte.value, banco.value, inventario.value].some(
    (value) => value < 0
  );
  if (hasNegative && !notes) {
    return { error: "negative_requires_notes" };
  }

  if (!["auto", "manual"].includes(payload.inventarioSource)) {
    return { error: "invalid_inventario_source" };
  }

  return {
    value: {
      snapshotDate: dateValidation.value,
      cajaOperativa: cajaOperativa.value,
      cajaFuerte: cajaFuerte.value,
      banco: banco.value,
      inventario: inventario.value,
      inventarioSource: payload.inventarioSource,
      inventoryTotalProducts: Number(payload.inventoryTotalProducts || 0),
      inventoryMissingCostProducts: Number(payload.inventoryMissingCostProducts || 0),
      notes,
    },
  };
}

async function getSnapshotByDate(snapshotDate) {
  const parsed = parseDateOnly(snapshotDate);
  if (!parsed) return null;

  const { rows } = await db.query(
    `
    ${WEALTH_SELECT}
    where snapshot_date = $1
    limit 1
    `,
    [parsed]
  );

  return normalizeWealthSnapshot(rows[0] || null);
}

async function getLatestWealthSnapshot() {
  const { rows } = await db.query(
    `
    ${WEALTH_SELECT}
    order by snapshot_date desc, id desc
    limit 1
    `
  );

  return normalizeWealthSnapshot(rows[0] || null);
}

async function resolveInventoryInput({ inventario, inventarioSource }) {
  if (inventario !== null && inventario !== undefined && inventario !== "auto") {
    return {
      inventario: inventario,
      inventarioSource: inventarioSource || "manual",
      inventoryTotalProducts: 0,
      inventoryMissingCostProducts: 0,
      inventoryAutoSummary: null,
    };
  }

  const autoSummary = await inventoryService.getCurrentInventoryValue();
  if (autoSummary?.error === "no_snapshot") {
    return { error: "no_inventory_snapshot" };
  }

  return {
    inventario: autoSummary.inventory_value,
    inventarioSource: "auto",
    inventoryTotalProducts: autoSummary.total_products,
    inventoryMissingCostProducts: autoSummary.missing_cost_count,
    inventoryAutoSummary: autoSummary,
  };
}

async function saveWeeklyWealthSnapshot({
  snapshotDate,
  cajaOperativa,
  cajaFuerte,
  banco,
  inventario,
  inventarioSource,
  notes,
  overwrite = false,
}) {
  const inventoryResolution = await resolveInventoryInput({ inventario, inventarioSource });
  if (inventoryResolution.error) return inventoryResolution;

  const validation = validateWealthPayload({
    snapshotDate,
    cajaOperativa,
    cajaFuerte,
    banco,
    inventario: inventoryResolution.inventario,
    inventarioSource: inventoryResolution.inventarioSource,
    inventoryTotalProducts: inventoryResolution.inventoryTotalProducts,
    inventoryMissingCostProducts: inventoryResolution.inventoryMissingCostProducts,
    notes,
  });
  if (validation.error) return validation;

  const normalized = validation.value;
  const existing = await getSnapshotByDate(normalized.snapshotDate);
  if (existing && !overwrite) {
    return {
      status: "exists",
      snapshot: existing,
      inventoryAutoSummary: inventoryResolution.inventoryAutoSummary,
    };
  }

  const query = existing
    ? `
      update business_wealth_snapshots
      set
        caja_operativa = $2,
        caja_fuerte = $3,
        banco = $4,
        inventario = $5,
        inventario_source = $6,
        inventory_total_products = $7,
        inventory_missing_cost_products = $8,
        notes = $9,
        updated_at = now()
      where snapshot_date = $1
      returning *
    `
    : `
      insert into business_wealth_snapshots (
        snapshot_date,
        caja_operativa,
        caja_fuerte,
        banco,
        inventario,
        inventario_source,
        inventory_total_products,
        inventory_missing_cost_products,
        notes
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      returning *
    `;

  const { rows } = await db.query(query, [
    normalized.snapshotDate,
    normalized.cajaOperativa,
    normalized.cajaFuerte,
    normalized.banco,
    normalized.inventario,
    normalized.inventarioSource,
    normalized.inventoryTotalProducts,
    normalized.inventoryMissingCostProducts,
    normalized.notes,
  ]);

  return {
    status: existing ? "updated" : "created",
    snapshot: normalizeWealthSnapshot(rows[0]),
    inventoryAutoSummary: inventoryResolution.inventoryAutoSummary,
  };
}

async function getWealthHistory({ weeks = 12, order = "asc" } = {}) {
  const limit = clampInteger(weeks, { defaultValue: 12, min: 1, max: 104 });
  const { rows } = await db.query(
    `
    ${WEALTH_SELECT}
    order by snapshot_date desc, id desc
    limit $1
    `,
    [limit]
  );

  const snapshots = rows.map(normalizeWealthSnapshot);
  return order === "desc" ? snapshots : snapshots.reverse();
}

async function getWealthSummary({ weeks = 4 } = {}) {
  const history = await getWealthHistory({ weeks, order: "asc" });
  if (!history.length) {
    return { error: "no_wealth_snapshots" };
  }

  const current = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const totals = history.map((snapshot) => snapshot.total_wealth);
  const highest = history.reduce((best, snapshot) =>
    !best || snapshot.total_wealth > best.total_wealth ? snapshot : best
  , null);
  const lowest = history.reduce((best, snapshot) =>
    !best || snapshot.total_wealth < best.total_wealth ? snapshot : best
  , null);

  return {
    current_snapshot_date: current.snapshot_date,
    snapshot_count: history.length,
    current_total: current.total_wealth,
    previous_total: previous ? previous.total_wealth : null,
    absolute_change: previous ? current.total_wealth - previous.total_wealth : null,
    percent_change: previous ? percentChange(current.total_wealth, previous.total_wealth) : null,
    average_total: average(totals),
    highest_total: highest ? highest.total_wealth : null,
    highest_total_date: highest ? highest.snapshot_date : null,
    lowest_total: lowest ? lowest.total_wealth : null,
    lowest_total_date: lowest ? lowest.snapshot_date : null,
    cash_ratio: current.cash_ratio,
    inventory_ratio: current.inventory_ratio,
  };
}

async function getWealthChange() {
  const history = await getWealthHistory({ weeks: 2, order: "asc" });
  if (!history.length) return { error: "no_wealth_snapshots" };
  if (history.length < 2) return { error: "insufficient_wealth_history", current: history[0] };

  const previous = history[0];
  const current = history[1];

  return {
    current,
    previous,
    absolute_change: current.total_wealth - previous.total_wealth,
    percent_change: percentChange(current.total_wealth, previous.total_wealth),
    component_changes: {
      caja_operativa: current.caja_operativa - previous.caja_operativa,
      caja_fuerte: current.caja_fuerte - previous.caja_fuerte,
      banco: current.banco - previous.banco,
      inventario: current.inventario - previous.inventario,
    },
  };
}

async function getWealthMonthSummary({ weeks = 5 } = {}) {
  const history = await getWealthHistory({ weeks, order: "asc" });
  if (!history.length) return { error: "no_wealth_snapshots" };

  const deltas = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    deltas.push({
      from_date: previous.snapshot_date,
      to_date: current.snapshot_date,
      absolute_change: current.total_wealth - previous.total_wealth,
      percent_change: percentChange(current.total_wealth, previous.total_wealth),
    });
  }

  const first = history[0];
  const last = history[history.length - 1];
  const bestWeek = deltas.reduce((best, delta) =>
    !best || delta.absolute_change > best.absolute_change ? delta : best
  , null);
  const worstWeek = deltas.reduce((best, delta) =>
    !best || delta.absolute_change < best.absolute_change ? delta : best
  , null);

  return {
    weeks_requested: clampInteger(weeks, { defaultValue: 5, min: 2, max: 104 }),
    snapshot_count: history.length,
    history,
    current_total: last.total_wealth,
    starting_total: first.total_wealth,
    net_change: last.total_wealth - first.total_wealth,
    net_percent_change: percentChange(last.total_wealth, first.total_wealth),
    average_total: average(history.map((snapshot) => snapshot.total_wealth)),
    average_weekly_change: deltas.length
      ? average(deltas.map((delta) => delta.absolute_change))
      : null,
    best_week: bestWeek,
    worst_week: worstWeek,
  };
}

async function getWealthAnalysisData({ weeks = 4 } = {}) {
  const history = await getWealthHistory({ weeks, order: "asc" });
  if (!history.length) return { error: "no_wealth_snapshots" };

  const summary = await getWealthSummary({ weeks });
  const monthly = await getWealthMonthSummary({ weeks });

  return {
    history,
    summary,
    monthly,
  };
}

module.exports = {
  getLatestWealthSnapshot,
  getSnapshotByDate,
  getWealthAnalysisData,
  getWealthChange,
  getWealthHistory,
  getWealthMonthSummary,
  getWealthSummary,
  normalizeWealthSnapshot,
  percentChange,
  saveWeeklyWealthSnapshot,
};
