// src/services/inventoryService.js
const db = require("../db");

async function getActiveSnapshotId() {
  const { rows } = await db.query("select id from inventory_snapshot order by id desc limit 1");
  return rows[0]?.id || null;
}

async function resetCycleAndCreateSnapshot(lines /* [{product_id, qty}] */) {
  // Nuevo ciclo: borra snapshot y compras previas
  await db.query("delete from inventory_snapshot cascade");
  await db.query("delete from purchases cascade");

  const { rows } = await db.query("insert into inventory_snapshot default values returning id");
  const snapshotId = rows[0].id;

  for (const l of lines) {
    await db.query(
      `insert into inventory_lines (snapshot_id, product_id, qty)
       values ($1,$2,$3)
       on conflict (snapshot_id, product_id) do update set qty = excluded.qty`,
      [snapshotId, l.product_id, l.qty]
    );
  }
  return snapshotId;
}

async function addPurchase(lines /* [{product_id, qty}] */) {
  const { rows } = await db.query("insert into purchases default values returning id");
  const purchaseId = rows[0].id;

  for (const l of lines) {
    await db.query(
      `insert into purchase_lines (purchase_id, product_id, qty)
       values ($1,$2,$3)
       on conflict (purchase_id, product_id) do update set qty = excluded.qty`,
      [purchaseId, l.product_id, l.qty]
    );
  }
  return purchaseId;
}

async function resolveProductsByNames(names /* array strings */) {
  // 1) match exact products.name
  // 2) else match product_aliases.alias
  const q = `
    with input as (
      select unnest($1::text[]) as raw
    ),
    exact as (
      select i.raw, p.id, p.name
      from input i
      join products p on lower(p.name) = lower(i.raw)
    ),
    alias as (
      select i.raw, p.id, p.name
      from input i
      join product_aliases a on lower(a.alias) = lower(i.raw)
      join products p on p.id = a.product_id
    )
    select * from exact
    union
    select * from alias
  `;
  const { rows } = await db.query(q, [names]);
  const map = new Map();
  for (const r of rows) map.set(r.raw, { product_id: r.id, name: r.name });
  return map;
}

async function getComprasSugeridas() {
  const snapshotId = await getActiveSnapshotId();
  if (!snapshotId) return { error: "no_snapshot" };

  const { rows } = await db.query(
    `
    select
      p.id as product_id,
      p.name,
      st.name as store,
      p.base_qty,
      coalesce(il.qty,0) as snapshot_qty,
      coalesce(il.qty,0) + coalesce(sum(pl.qty),0) as stock_actual,
      greatest(p.base_qty - (coalesce(il.qty,0) + coalesce(sum(pl.qty),0)), 0) as faltante
    from products p
    join stores st on st.id = p.store_id
    left join inventory_lines il
      on il.product_id = p.id and il.snapshot_id = $1
    left join purchase_lines pl
      on pl.product_id = p.id
    where p.active = true
      and p.base_qty > 0
    group by p.id, p.name, st.name, p.base_qty, il.qty
    order by st.name, p.name
    `,
    [snapshotId]
  );

  return rows.filter((r) => Number(r.faltante) > 0);
}

async function getStockActual() {
  const snapshotId = await getActiveSnapshotId();
  if (!snapshotId) return { error: "no_snapshot" };

  const { rows } = await db.query(
    `
    select
      p.name,
      s.name as store,
      p.base_qty,
      coalesce(il.qty,0) as snapshot_qty,
      coalesce(il.qty,0) + coalesce(sum(pl.qty),0) as stock_actual
    from products p
    join stores s on s.id = p.store_id
    left join inventory_lines il
      on il.product_id = p.id and il.snapshot_id = $1
    left join purchase_lines pl on pl.product_id = p.id
    group by p.name, s.name, p.base_qty, il.qty
    order by s.name, p.name
    `,
    [snapshotId]
  );
  return rows;
}

async function updateBaseQty(productId, baseQty) {
  await db.query(`update products set base_qty = $2 where id = $1`, [productId, baseQty]);
}

module.exports = {
  resetCycleAndCreateSnapshot,
  addPurchase,
  resolveProductsByNames,
  getComprasSugeridas,
  getStockActual,
  updateBaseQty,
};