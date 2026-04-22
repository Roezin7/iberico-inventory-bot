create table if not exists business_wealth_snapshots (
  id bigserial primary key,
  snapshot_date date not null,
  caja_operativa numeric(12,2) not null,
  caja_fuerte numeric(12,2) not null,
  banco numeric(12,2) not null,
  inventario numeric(12,2) not null,
  inventario_source text not null,
  inventory_total_products integer not null default 0,
  inventory_missing_cost_products integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_wealth_snapshots_snapshot_date_unique unique (snapshot_date),
  constraint business_wealth_snapshots_inventory_source_check
    check (inventario_source in ('auto', 'manual')),
  constraint business_wealth_snapshots_negative_requires_notes_check
    check (
      (
        caja_operativa >= 0
        and caja_fuerte >= 0
        and banco >= 0
        and inventario >= 0
      )
      or coalesce(length(trim(notes)), 0) > 0
    )
);

create index if not exists business_wealth_snapshots_snapshot_date_idx
  on business_wealth_snapshots (snapshot_date desc);
