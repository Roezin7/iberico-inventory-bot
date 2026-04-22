// src/services/inventoryService.js
const db = require("../db");
const {
  cleanHumanText,
  normalizeProductLookupKey,
} = require("../utils/textUtils");

async function getActiveSnapshot() {
  const { rows } = await db.query(
    `
    select id, created_at
    from inventory_snapshot
    order by created_at desc, id desc
    limit 1
    `
  );

  return rows[0] || null;
}

async function getActiveSnapshotId() {
  const snapshot = await getActiveSnapshot();
  return snapshot?.id || null;
}

async function createSnapshot(lines /* [{product_id, qty}] */) {
  // Los snapshots ahora son append-only para conservar histórico.
  // El "snapshot activo" siempre es el más reciente; el stock actual se arma
  // a partir de ese snapshot + movimientos posteriores.
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("insert into inventory_snapshot default values returning id");
    const snapshotId = rows[0].id;

    for (const line of lines) {
      await client.query(
        `insert into inventory_lines (snapshot_id, product_id, qty)
         values ($1,$2,$3)
         on conflict (snapshot_id, product_id) do update set qty = excluded.qty`,
        [snapshotId, line.product_id, line.qty]
      );
    }

    return snapshotId;
  });
}

async function resetCycleAndCreateSnapshot(lines /* [{product_id, qty}] */) {
  return createSnapshot(lines);
}

async function addPurchase(lines /* [{product_id, qty}] */) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("insert into purchases default values returning id");
    const purchaseId = rows[0].id;

    for (const line of lines) {
      await client.query(
        `insert into purchase_lines (purchase_id, product_id, qty)
         values ($1,$2,$3)
         on conflict (purchase_id, product_id) do update set qty = excluded.qty`,
        [purchaseId, line.product_id, line.qty]
      );
    }

    return purchaseId;
  });
}

async function updateBaseQuantities(lines /* [{product_id, qty}] */) {
  return db.withTransaction(async (client) => {
    for (const line of lines) {
      await client.query(`update products set base_qty = $2 where id = $1`, [line.product_id, line.qty]);
    }
  });
}

async function updateBaseQty(productId, baseQty) {
  await db.query(`update products set base_qty = $2 where id = $1`, [productId, baseQty]);
}

async function getLookupCatalogRows() {
  const { rows } = await db.query(
    `
    select
      p.id as product_id,
      p.name,
      'product'::text as source_type,
      p.name as source_value
    from products p
    where p.active = true

    union all

    select
      p.id as product_id,
      p.name,
      'alias'::text as source_type,
      a.alias as source_value
    from product_aliases a
    join products p on p.id = a.product_id
    where p.active = true
    `
  );

  return rows;
}

function buildLookupIndex(rows) {
  const index = new Map();

  for (const row of rows) {
    const normalized = normalizeProductLookupKey(row.source_value);
    if (!normalized) continue;

    const bucket = index.get(normalized) || [];
    bucket.push({
      product_id: row.product_id,
      name: row.name,
      source_type: row.source_type,
      source_value: row.source_value,
    });
    index.set(normalized, bucket);
  }

  return index;
}

function collapseCandidates(entries) {
  const byProductId = new Map();

  for (const entry of entries || []) {
    const existing = byProductId.get(entry.product_id);
    if (!existing) {
      byProductId.set(entry.product_id, {
        product_id: entry.product_id,
        name: entry.name,
        source_types: new Set([entry.source_type]),
        source_values: [entry.source_value],
      });
      continue;
    }

    existing.source_types.add(entry.source_type);
    if (!existing.source_values.includes(entry.source_value)) {
      existing.source_values.push(entry.source_value);
    }
  }

  return Array.from(byProductId.values())
    .map((entry) => ({
      product_id: entry.product_id,
      name: entry.name,
      source_types: Array.from(entry.source_types).sort(),
      source_values: entry.source_values.sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

async function resolveProductsByNamesDetailed(names /* array strings */) {
  const catalogRows = await getLookupCatalogRows();
  const lookupIndex = buildLookupIndex(catalogRows);

  const resolved = new Map();
  const rawResults = new Map();
  const missing = [];
  const ambiguous = [];

  for (const originalRaw of names || []) {
    const rawName = cleanHumanText(originalRaw);
    const normalized = normalizeProductLookupKey(rawName);

    if (!normalized) {
      const result = { status: "missing", rawName, normalized };
      rawResults.set(originalRaw, result);
      missing.push(result);
      continue;
    }

    const candidates = collapseCandidates(lookupIndex.get(normalized) || []);
    if (!candidates.length) {
      const result = { status: "missing", rawName, normalized };
      rawResults.set(originalRaw, result);
      missing.push(result);
      continue;
    }

    if (candidates.length > 1) {
      const result = {
        status: "ambiguous",
        rawName,
        normalized,
        candidates: candidates.map((candidate) => ({
          product_id: candidate.product_id,
          name: candidate.name,
        })),
      };
      rawResults.set(originalRaw, result);
      ambiguous.push(result);
      continue;
    }

    const candidate = candidates[0];
    const result = {
      status: "resolved",
      rawName,
      normalized,
      product_id: candidate.product_id,
      name: candidate.name,
      matchedBy: candidate.source_types.includes("product") ? "product" : "alias",
      sourceValues: candidate.source_values,
    };

    rawResults.set(originalRaw, result);
    resolved.set(originalRaw, result);
  }

  return { resolved, rawResults, missing, ambiguous };
}

async function resolveProductsByNames(names /* array strings */) {
  const { resolved } = await resolveProductsByNamesDetailed(names);
  return resolved;
}

async function getProductById(productId) {
  const { rows } = await db.query(
    `
    select id, name, active
    from products
    where id = $1
    limit 1
    `,
    [productId]
  );

  return rows[0] || null;
}

async function getAliasesForProduct(productId) {
  const { rows } = await db.query(
    `
    select alias
    from product_aliases
    where product_id = $1
    order by alias
    `,
    [productId]
  );

  return rows.map((row) => row.alias);
}

async function addProductAlias(productId, alias) {
  const product = await getProductById(productId);
  if (!product || product.active !== true) {
    return { status: "product_missing" };
  }

  const cleanedAlias = cleanHumanText(alias);
  const normalizedAlias = normalizeProductLookupKey(cleanedAlias);
  if (!normalizedAlias) {
    return { status: "invalid_alias" };
  }

  if (normalizeProductLookupKey(product.name) === normalizedAlias) {
    return {
      status: "matches_product_name",
      alias: cleanedAlias,
      productName: product.name,
    };
  }

  const currentAliases = await getAliasesForProduct(productId);
  const existingAlias = currentAliases.find(
    (currentAlias) => normalizeProductLookupKey(currentAlias) === normalizedAlias
  );
  if (existingAlias) {
    return {
      status: "exists",
      alias: existingAlias,
      productName: product.name,
    };
  }

  const catalogRows = await getLookupCatalogRows();
  const lookupIndex = buildLookupIndex(catalogRows);
  const conflicts = collapseCandidates(lookupIndex.get(normalizedAlias) || []).filter(
    (candidate) => Number(candidate.product_id) !== Number(productId)
  );

  if (conflicts.length) {
    return {
      status: "conflict",
      alias: cleanedAlias,
      conflictingProducts: conflicts.map((candidate) => ({
        product_id: candidate.product_id,
        name: candidate.name,
      })),
    };
  }

  const { rows } = await db.query(
    `
    insert into product_aliases (product_id, alias)
    values ($1, $2)
    returning id, alias
    `,
    [productId, cleanedAlias]
  );

  return {
    status: "created",
    alias: rows[0].alias,
    productName: product.name,
  };
}

async function addProductAliasByNames({ alias, productName }) {
  const detail = await resolveProductsByNamesDetailed([productName]);
  const outcome = detail.rawResults.get(productName);

  if (!outcome || outcome.status === "missing") {
    return { status: "product_missing", productName: cleanHumanText(productName) };
  }

  if (outcome.status === "ambiguous") {
    return {
      status: "product_ambiguous",
      productName: cleanHumanText(productName),
      candidates: outcome.candidates,
    };
  }

  return addProductAlias(outcome.product_id, alias);
}

async function getCurrentStockRows() {
  const snapshot = await getActiveSnapshot();
  if (!snapshot) return { error: "no_snapshot" };

  const { rows } = await db.query(
    `
    with purchase_totals as (
      -- Futuras tablas de movimientos pueden agregarse aquí como un union all
      -- para mantener el cálculo de stock centralizado.
      select
        pl.product_id,
        sum(pl.qty) as purchase_qty
      from purchases pu
      join purchase_lines pl on pl.purchase_id = pu.id
      where pu.created_at > $1
      group by pl.product_id
    )
    select
      p.id as product_id,
      p.name,
      st.name as store,
      p.base_qty,
      p.unit_cost,
      coalesce(il.qty, 0) as snapshot_qty,
      coalesce(il.qty, 0) + coalesce(pt.purchase_qty, 0) as stock_actual,
      case
        when p.unit_cost is null then null
        else (coalesce(il.qty, 0) + coalesce(pt.purchase_qty, 0)) * p.unit_cost
      end as inventory_value,
      greatest(p.base_qty - (coalesce(il.qty, 0) + coalesce(pt.purchase_qty, 0)), 0) as faltante,
      case
        when p.unit_cost is null then null
        else greatest(p.base_qty - (coalesce(il.qty, 0) + coalesce(pt.purchase_qty, 0)), 0) * p.unit_cost
      end as costo_reponer
    from products p
    join stores st on st.id = p.store_id
    left join inventory_lines il
      on il.product_id = p.id and il.snapshot_id = $2
    left join purchase_totals pt on pt.product_id = p.id
    where p.active = true
      and p.base_qty > 0
    order by st.name, p.name
    `,
    [snapshot.created_at, snapshot.id]
  );

  return rows;
}

async function getComprasSugeridas() {
  const rows = await getCurrentStockRows();
  if (rows?.error === "no_snapshot") return rows;

  return rows.filter((row) => Number(row.faltante) > 0);
}

async function getStockActual() {
  return getCurrentStockRows();
}

async function getInventoryValueSummary() {
  const rows = await getCurrentStockRows();
  if (rows?.error === "no_snapshot") return rows;

  const totalsByStore = new Map();
  let totalInventoryValue = 0;
  let missingCostCount = 0;

  for (const row of rows) {
    const store = String(row.store || "Sin tienda");
    const inventoryValue = row.inventory_value === null ? null : Number(row.inventory_value || 0);
    const unitCost = row.unit_cost === null ? null : Number(row.unit_cost);

    if (!totalsByStore.has(store)) {
      totalsByStore.set(store, {
        store,
        total_inventory_value: 0,
        missing_cost_count: 0,
      });
    }

    const bucket = totalsByStore.get(store);
    if (unitCost === null) {
      bucket.missing_cost_count += 1;
      missingCostCount += 1;
      continue;
    }

    bucket.total_inventory_value += inventoryValue || 0;
    totalInventoryValue += inventoryValue || 0;
  }

  return {
    total_inventory_value: totalInventoryValue,
    missing_cost_count: missingCostCount,
    stores: Array.from(totalsByStore.values()).sort((a, b) =>
      a.store.localeCompare(b.store, "es", { sensitivity: "base" })
    ),
  };
}

async function getInventoryValueByProductName(rawName) {
  const detail = await resolveProductsByNamesDetailed([rawName]);
  const outcome = detail.rawResults.get(rawName);

  if (!outcome || outcome.status === "missing") {
    return { status: "missing", rawName: cleanHumanText(rawName) };
  }

  if (outcome.status === "ambiguous") {
    return { status: "ambiguous", rawName: cleanHumanText(rawName), candidates: outcome.candidates };
  }

  const rows = await getCurrentStockRows();
  if (rows?.error === "no_snapshot") return rows;

  const row = rows.find((item) => Number(item.product_id) === Number(outcome.product_id));
  if (!row) {
    return { status: "missing_in_stock", rawName: cleanHumanText(rawName), productName: outcome.name };
  }

  return {
    status: "ok",
    row,
  };
}

async function getProductsMissingUnitCost() {
  const { rows } = await db.query(
    `
    select
      p.id as product_id,
      p.name,
      s.name as store,
      p.base_qty
    from products p
    join stores s on s.id = p.store_id
    where p.active = true
      and p.unit_cost is null
    order by s.name, p.name
    `
  );

  return rows;
}

async function getMissingProductsInActiveSnapshot() {
  const snapshot = await getActiveSnapshot();
  if (!snapshot) return { error: "no_snapshot" };

  const { rows } = await db.query(
    `
    select
      p.id as product_id,
      p.name,
      s.name as store
    from products p
    join stores s on s.id = p.store_id
    left join inventory_lines il
      on il.product_id = p.id and il.snapshot_id = $1
    where p.active = true
      and il.product_id is null
    order by s.name, p.name
    `,
    [snapshot.id]
  );

  return rows;
}

async function getBaseStockList() {
  const { rows } = await db.query(
    `
    select
      p.id as product_id,
      p.name,
      s.name as store,
      p.base_qty
    from products p
    join stores s on s.id = p.store_id
    where p.active = true
    order by s.name, p.name
    `
  );

  return rows;
}

module.exports = {
  addProductAlias,
  addProductAliasByNames,
  addPurchase,
  createSnapshot,
  getActiveSnapshot,
  getActiveSnapshotId,
  getBaseStockList,
  getComprasSugeridas,
  getCurrentStockRows,
  getInventoryValueByProductName,
  getInventoryValueSummary,
  getMissingProductsInActiveSnapshot,
  getProductsMissingUnitCost,
  getStockActual,
  resetCycleAndCreateSnapshot,
  resolveProductsByNames,
  resolveProductsByNamesDetailed,
  updateBaseQty,
  updateBaseQuantities,
};
