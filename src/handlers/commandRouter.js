// src/handlers/commandRouter.js
const db = require("../db");
const {
  sendMessage,
  escapeHtml,
  getFile,
  downloadFile,
} = require("../services/telegramService");

const inventory = require("../services/inventoryService");
const { parseLinesFromText, extractItemsFromBuffer } = require("../services/parserService");
const { cleanHumanText, parseAliasMappingLine, parseNameQtyLine } = require("../utils/textUtils");
const wealthTelegram = require("./wealth/telegram");

// state: chatId -> { mode, batch: { linesByProductId: Map<number, number>, rawSeen: number } }
const state = new Map();

function startBatch(chatId, mode) {
  state.set(chatId, {
    mode,
    batch: {
      linesByProductId: new Map(),
      rawSeen: 0,
    },
  });
}

function clearBatch(chatId) {
  state.delete(chatId);
}

function getState(chatId) {
  return state.get(chatId) || null;
}

function pickTelegramFileFromMessage(message) {
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      mimeType: "image/jpeg",
      fileName: `photo_${Date.now()}.jpg`,
      fileSize: photo.file_size,
      kind: "photo",
    };
  }

  if (message.document) {
    const document = message.document;
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      mimeType: document.mime_type || "application/octet-stream",
      fileName: document.file_name || `document_${Date.now()}`,
      fileSize: document.file_size,
      kind: "document",
    };
  }

  return null;
}

// Para semana/ingreso: SUMA
function mergeLines(batch, resolvedLines /* [{product_id, qty}] */) {
  for (const line of resolvedLines) {
    const previousQty = Number(batch.linesByProductId.get(line.product_id) || 0);
    batch.linesByProductId.set(line.product_id, previousQty + Number(line.qty || 0));
  }
}

// Para base: REEMPLAZA
function setLines(batch, resolvedLines /* [{product_id, qty}] */) {
  for (const line of resolvedLines) {
    batch.linesByProductId.set(line.product_id, Number(line.qty || 0));
  }
}

function batchToLines(batch) {
  return Array.from(batch.linesByProductId.entries()).map(([product_id, qty]) => ({
    product_id,
    qty,
  }));
}

function parseBaseInline(rest) {
  return parseNameQtyLine(rest);
}

function formatQty(value) {
  return Number(value || 0).toFixed(2);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatCostOrMissing(value) {
  return value === null || value === undefined ? "sin costo" : formatCurrency(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];

  for (const value of values || []) {
    const cleaned = cleanHumanText(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }

  return out;
}

function uniqueAmbiguousItems(items) {
  const byRawName = new Map();

  for (const item of items || []) {
    if (!item?.rawName || byRawName.has(item.rawName)) continue;
    byRawName.set(item.rawName, item);
  }

  return Array.from(byRawName.values());
}

function groupRowsByStore(rows) {
  const byStore = new Map();

  for (const row of rows || []) {
    const store = String(row.store || "Sin tienda");
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(row);
  }

  return byStore;
}

function renderGroupedStoreList({ title, rows, emptyMessage, renderRow }) {
  if (!rows?.length) {
    return `<b>${title}</b>\n\n${emptyMessage}`;
  }

  let out = `<b>${title}</b>\n`;
  for (const [store, list] of groupRowsByStore(rows).entries()) {
    out += `\n<b>${escapeHtml(store)}</b>\n`;
    out += list.map(renderRow).join("\n");
    out += "\n";
  }

  return out.trim();
}

function renderReplacementCost(value) {
  return value === null || value === undefined
    ? "costo sin costo"
    : `costo ${formatCurrency(value)}`;
}

function buildUnresolvedSections({ missingNames, ambiguousItems }) {
  const sections = [];

  if (missingNames.length) {
    sections.push(
      `<b>No reconocí:</b>\n${missingNames.map((name) => `• ${escapeHtml(name)}`).join("\n")}`
    );
  }

  if (ambiguousItems.length) {
    sections.push(
      `<b>Quedaron ambiguos:</b>\n${ambiguousItems
        .map((item) => {
          const options = item.candidates
            .slice(0, 4)
            .map((candidate) => escapeHtml(candidate.name))
            .join(" / ");
          return `• ${escapeHtml(item.rawName)} <code>→</code> ${options}`;
        })
        .join("\n")}`
    );
  }

  return sections;
}

function buildBatchOutcomeMessage({
  successLabel,
  sourceLabel,
  batch,
  resolvedCount,
  missingNames,
  ambiguousItems,
  ingestId,
}) {
  const unresolvedSections = buildUnresolvedSections({ missingNames, ambiguousItems });
  const hasWarnings = unresolvedSections.length > 0;
  const hasResolved = resolvedCount > 0;

  let html = hasResolved
    ? `${successLabel}${hasWarnings ? " parcialmente" : ""} al lote ✅`
    : `No pude agregar productos reconocidos de ese ${sourceLabel} todavía.`;

  html += `\nAcumulado: <b>${batch.linesByProductId.size}</b> productos`;

  if (hasWarnings) {
    html += `\n\n${unresolvedSections.join("\n\n")}`;

    if (missingNames.length) {
      html += `\n\nPuedes crear alias con <code>/alias_add Alias = Producto</code> y reenviar solo lo pendiente.`;
    }

    if (ambiguousItems.length) {
      html += `\n\nLos ambiguos requieren revisar nombres o aliases porque hoy coinciden con más de un producto.`;
    }
  }

  html += `\n\nCuando termines: <code>/fin</code>`;
  if (ingestId) html += `\nIngest: <code>${ingestId}</code>`;

  return html;
}

async function resolveItemsToBatchLines(items) {
  const detail = await inventory.resolveProductsByNamesDetailed(items.map((item) => item.rawName));

  const resolvedLines = [];
  const missingNames = [];
  const ambiguousItems = [];

  for (const item of items) {
    const outcome = detail.rawResults.get(item.rawName);

    if (!outcome || outcome.status === "missing") {
      missingNames.push(item.rawName);
      continue;
    }

    if (outcome.status === "ambiguous") {
      ambiguousItems.push(outcome);
      continue;
    }

    resolvedLines.push({ product_id: outcome.product_id, qty: item.qty });
  }

  return {
    resolvedLines,
    missingNames: uniqueStrings(missingNames),
    ambiguousItems: uniqueAmbiguousItems(ambiguousItems),
  };
}

async function handleCommand(chatId, text) {
  const cmd = String(text || "").trim().split(/\s+/)[0];
  const st = getState(chatId);
  const wealthResult = await wealthTelegram.handleCommand({
    chatId,
    text,
    hasConflictingBatch: Boolean(st),
  });
  if (wealthResult) return wealthResult;
  const wealthSessionActive = wealthTelegram.hasSession(chatId);

  if (cmd === "/menu") {
    const html =
      `<b>Ibérico Inventario</b>\n\n` +
      `<code>/semana</code> — iniciar lote inventario semanal\n` +
      `<code>/ingreso</code> — iniciar lote compras\n` +
      `<code>/base</code> — cambiar stock base\n` +
      `<code>/valor_semanal</code> — registrar valor total del negocio\n` +
      `<code>/valor_total</code> — ver ultimo corte total del negocio\n` +
      `<code>/valor_historial</code> — ver historial de valor semanal\n` +
      `<code>/valor_cambio</code> — comparar ultimo corte contra el anterior\n` +
      `<code>/valor_mes</code> — resumen de ultimas semanas\n` +
      `<code>/base_show</code> — ver stock base actual\n` +
      `<code>/faltantes</code> — listar productos activos faltantes del snapshot actual\n` +
      `<code>/alias_add</code> — agregar alias <code>/alias_add Alias = Producto</code>\n` +
      `<code>/fin</code> — guardar lote actual\n` +
      `<code>/cancel</code> — cancelar lote actual\n\n` +
      `<code>/stock</code> — ver stock actual\n` +
      `<code>/valor_stock</code> — ver stock actual con costo y valor\n` +
      `<code>/valor_inventario</code> — ver valor total del inventario\n` +
      `<code>/valor_producto</code> — ver valor de un producto\n` +
      `<code>/costos_faltantes</code> — listar productos activos sin costo\n` +
      `<code>/compras</code> — lista de compras sugerida\n` +
      `<code>/compras_tienda</code> — compras sugeridas por tienda`;

    return sendMessage(chatId, html);
  }

  if (cmd === "/cancel") {
    if (!st) return sendMessage(chatId, `No hay nada que cancelar. Usa <code>/menu</code>.`);
    clearBatch(chatId);
    return sendMessage(chatId, `Lote cancelado ✅`);
  }

  if (cmd === "/fin") {
    if (!st) {
      return sendMessage(
        chatId,
        `No hay lote activo. Usa <code>/semana</code>, <code>/ingreso</code> o <code>/base</code>.`
      );
    }

    const lines = batchToLines(st.batch);
    if (!lines.length) {
      clearBatch(chatId);
      return sendMessage(chatId, `Lote vacío. Cancelo ✅`);
    }

    if (st.mode === "semana") {
      await inventory.createSnapshot(lines);
      clearBatch(chatId);
      return sendMessage(
        chatId,
        `Inventario semanal guardado ✅\nUsa <code>/faltantes</code>, <code>/compras</code> o <code>/stock</code>.`
      );
    }

    if (st.mode === "ingreso") {
      await inventory.addPurchase(lines);
      clearBatch(chatId);
      return sendMessage(chatId, `Compras guardadas ✅\nUsa <code>/stock</code>.`);
    }

    if (st.mode === "base") {
      await inventory.updateBaseQuantities(lines);
      clearBatch(chatId);
      return sendMessage(chatId, `Stock base actualizado ✅ (${lines.length} productos)`);
    }

    clearBatch(chatId);
    return sendMessage(chatId, `Modo inválido. Usa <code>/menu</code>.`);
  }

  if (wealthSessionActive && ["/semana", "/ingreso", "/base"].includes(cmd)) {
    return sendMessage(
      chatId,
      `Tienes un registro de valor semanal en progreso. Termínalo o usa <code>/cancel</code> antes de abrir otro modo interactivo.`
    );
  }

  if (cmd === "/semana") {
    startBatch(chatId, "semana");
    return sendMessage(
      chatId,
      `Lote semanal iniciado ✅\n` +
        `Envíame fotos, PDFs o texto del inventario.\n` +
        `También acepto líneas como <pre>Producto = cantidad</pre>.\n\n` +
        `Cuando termines: <code>/fin</code>\n` +
        `Si te equivocas: <code>/cancel</code>`
    );
  }

  if (cmd === "/ingreso") {
    startBatch(chatId, "ingreso");
    return sendMessage(
      chatId,
      `Lote de compras iniciado ✅\n` +
        `Envíame la(s) foto(s), PDF(s) o texto.\n\n` +
        `Cuando termines: <code>/fin</code>\n` +
        `Si te equivocas: <code>/cancel</code>`
    );
  }

  if (cmd === "/base") {
    const rest = String(text || "").replace(/^\/base\s*/i, "").trim();
    const inline = parseBaseInline(rest);

    if (inline) {
      const detail = await inventory.resolveProductsByNamesDetailed([inline.rawName]);
      const outcome = detail.rawResults.get(inline.rawName);

      if (!outcome || outcome.status === "missing") {
        return sendMessage(
          chatId,
          `No reconocí el producto: <code>${escapeHtml(inline.rawName)}</code>`
        );
      }

      if (outcome.status === "ambiguous") {
        const options = outcome.candidates
          .map((candidate) => `• ${escapeHtml(candidate.name)}`)
          .join("\n");
        return sendMessage(
          chatId,
          `El producto quedó ambiguo: <code>${escapeHtml(inline.rawName)}</code>\n${options}`
        );
      }

      await inventory.updateBaseQty(outcome.product_id, inline.qty);
      return sendMessage(
        chatId,
        `Stock base actualizado ✅\n• ${escapeHtml(outcome.name)} → <b>${formatQty(inline.qty)}</b>`
      );
    }

    startBatch(chatId, "base");
    return sendMessage(
      chatId,
      `Modo edición de <b>stock base</b> ✅\n` +
        `Pega líneas así:\n<pre>Coca = 4\nTonica: 60</pre>\n` +
        `Luego: <code>/fin</code> para guardar o <code>/cancel</code>`
    );
  }

  if (cmd === "/base_show") {
    const rows = await inventory.getBaseStockList();
    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Stock base",
        rows,
        emptyMessage: "No hay productos activos.",
        renderRow: (row) => `• ${escapeHtml(row.name)}: <b>${formatQty(row.base_qty)}</b>`,
      })
    );
  }

  if (cmd === "/alias_add") {
    const rest = String(text || "").replace(/^\/alias_add\s*/i, "").trim();
    const parsed = parseAliasMappingLine(rest);

    if (!parsed) {
      return sendMessage(
        chatId,
        `Usa:\n<pre>/alias_add Alias = Producto</pre>\nEjemplo:\n<pre>/alias_add coca zero = Coca Zero</pre>`
      );
    }

    const result = await inventory.addProductAliasByNames(parsed);

    if (result.status === "product_missing") {
      return sendMessage(
        chatId,
        `No reconocí el producto destino: <code>${escapeHtml(parsed.productName)}</code>`
      );
    }

    if (result.status === "product_ambiguous") {
      const options = result.candidates.map((candidate) => `• ${escapeHtml(candidate.name)}`).join("\n");
      return sendMessage(
        chatId,
        `El producto destino quedó ambiguo: <code>${escapeHtml(parsed.productName)}</code>\n${options}`
      );
    }

    if (result.status === "invalid_alias") {
      return sendMessage(chatId, `El alias está vacío o no es válido.`);
    }

    if (result.status === "matches_product_name") {
      return sendMessage(
        chatId,
        `Ese alias ya coincide con el nombre oficial de <b>${escapeHtml(result.productName)}</b>.`
      );
    }

    if (result.status === "exists") {
      return sendMessage(
        chatId,
        `Ese alias ya existe ✅\n• <code>${escapeHtml(result.alias)}</code> → <b>${escapeHtml(
          result.productName
        )}</b>`
      );
    }

    if (result.status === "conflict") {
      const options = result.conflictingProducts
        .map((candidate) => `• ${escapeHtml(candidate.name)}`)
        .join("\n");

      return sendMessage(
        chatId,
        `No pude guardar ese alias porque ya coincide con otro producto:\n<code>${escapeHtml(
          result.alias
        )}</code>\n${options}`
      );
    }

    return sendMessage(
      chatId,
      `Alias guardado ✅\n• <code>${escapeHtml(result.alias)}</code> → <b>${escapeHtml(
        result.productName
      )}</b>\n${st ? `Tu lote sigue abierto. Puedes reenviar lo pendiente y luego <code>/fin</code>.` : ""}`.trim()
    );
  }

  if (cmd === "/faltantes") {
    const rows = await inventory.getMissingProductsInActiveSnapshot();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    if (!rows.length) {
      return sendMessage(chatId, `<b>Faltantes del snapshot actual</b>\n\nNo faltan productos activos ✅`);
    }

    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Faltantes del snapshot actual",
        rows,
        emptyMessage: "No faltan productos activos ✅",
        renderRow: (row) => `• ${escapeHtml(row.name)}`,
      })
    );
  }

  if (cmd === "/costos_faltantes") {
    const rows = await inventory.getProductsMissingUnitCost();
    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Productos sin costo",
        rows,
        emptyMessage: "Todos los productos activos tienen costo ✅",
        renderRow: (row) => `• ${escapeHtml(row.name)} <code>(base ${formatQty(row.base_qty)})</code>`,
      })
    );
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Stock actual",
        rows,
        emptyMessage: "No hay productos activos.",
        renderRow: (row) => `• ${escapeHtml(row.name)}: <b>${formatQty(row.stock_actual)}</b>`,
      })
    );
  }

  if (cmd === "/valor_stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Valor del stock actual",
        rows,
        emptyMessage: "No hay productos activos.",
        renderRow: (row) =>
          `• ${escapeHtml(row.name)}: <b>${formatQty(row.stock_actual)}</b> <code>(costo ${escapeHtml(
            formatCostOrMissing(row.unit_cost)
          )} / valor ${escapeHtml(formatCostOrMissing(row.inventory_value))})</code>`,
      })
    );
  }

  if (cmd === "/valor_inventario") {
    const summary = await inventory.getCurrentInventoryValue();
    if (summary?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    let html =
      `<b>Valor total del inventario</b>\n\n` +
      `Total valorizado: <b>${escapeHtml(formatCurrency(summary.inventory_value))}</b>\n` +
      `Productos con stock: <b>${summary.total_products}</b>\n` +
      `Productos valorizados: <b>${summary.valued_products}</b>\n` +
      `Productos sin costo: <b>${summary.missing_cost_count}</b>`;

    if (summary.missing_cost_products.length) {
      html += `\n\n<b>Fuera por falta de costo</b>\n`;
      html += summary.missing_cost_products
        .slice(0, 10)
        .map(
          (product) =>
            `• ${escapeHtml(product.name)} <code>(${escapeHtml(product.store)} / stock ${formatQty(
              product.stock_actual
            )})</code>`
        )
        .join("\n");
    }

    return sendMessage(chatId, html);
  }

  if (cmd === "/valor_producto") {
    const rawName = String(text || "").replace(/^\/valor_producto\s*/i, "").trim();
    if (!rawName) {
      return sendMessage(
        chatId,
        `Usa:\n<pre>/valor_producto Nombre del producto</pre>\nTambién funciona con aliases.`
      );
    }

    const result = await inventory.getInventoryValueByProductName(rawName);
    if (result?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    if (result.status === "missing") {
      return sendMessage(chatId, `No reconocí el producto: <code>${escapeHtml(result.rawName)}</code>`);
    }

    if (result.status === "ambiguous") {
      const options = result.candidates.map((candidate) => `• ${escapeHtml(candidate.name)}`).join("\n");
      return sendMessage(
        chatId,
        `El producto quedó ambiguo: <code>${escapeHtml(result.rawName)}</code>\n${options}`
      );
    }

    if (result.status === "missing_in_stock") {
      return sendMessage(
        chatId,
        `No encontré el producto en el stock activo: <code>${escapeHtml(result.productName)}</code>`
      );
    }

    const row = result.row;
    return sendMessage(
      chatId,
      `<b>${escapeHtml(row.name)}</b>\n` +
        `Tienda: <b>${escapeHtml(row.store)}</b>\n` +
        `Stock actual: <b>${formatQty(row.stock_actual)}</b>\n` +
        `Costo unitario: <b>${escapeHtml(formatCostOrMissing(row.unit_cost))}</b>\n` +
        `Valor inventario: <b>${escapeHtml(formatCostOrMissing(row.inventory_value))}</b>`
    );
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    if (!rows.length) {
      return sendMessage(chatId, `<b>Compras sugeridas</b>\n\nNo hace falta comprar nada ✅`);
    }

    const lines = rows.map((row) => {
      const faltante = formatQty(row.faltante);
      const stockActual = formatQty(row.stock_actual);
      const base = formatQty(row.base_qty);
      return `• ${escapeHtml(row.name)}: <b>comprar ${faltante}</b> <code>(hay ${stockActual} / base ${base} / ${escapeHtml(
        renderReplacementCost(row.costo_reponer)
      )})</code>`;
    });

    return sendMessage(chatId, `<b>Compras sugeridas</b>\n\n${lines.join("\n")}`);
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    return sendMessage(
      chatId,
      renderGroupedStoreList({
        title: "Compras sugeridas por tienda",
        rows,
        emptyMessage: "No hace falta comprar nada ✅",
        renderRow: (row) => {
          const faltante = formatQty(row.faltante);
          const stockActual = formatQty(row.stock_actual);
          const base = formatQty(row.base_qty);
          return `• ${escapeHtml(row.name)}: <b>comprar ${faltante}</b> <code>(hay ${stockActual} / base ${base} / ${escapeHtml(
            renderReplacementCost(row.costo_reponer)
          )})</code>`;
        },
      })
    );
  }

  if (st) {
    return sendMessage(
      chatId,
      `Tienes un lote activo (<code>${escapeHtml(st.mode)}</code>). Envía foto, PDF o texto, o <code>/fin</code>.`
    );
  }

  return sendMessage(chatId, `No entendí. Usa <code>/menu</code>.`);
}

async function handleNonCommand(chatId, message) {
  const wealthResult = await wealthTelegram.handleNonCommand({ chatId, message });
  if (wealthResult) return wealthResult;

  const st = getState(chatId);

  if (!st) {
    const hasFile = !!pickTelegramFileFromMessage(message);
    if (hasFile) return sendMessage(chatId, `Primero inicia: <code>/semana</code> o <code>/ingreso</code>.`);
    return sendMessage(chatId, `Usa <code>/menu</code>.`);
  }

  // =========================
  // TEXTO (semana/ingreso/base)
  // =========================
  if (message.text) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      return sendMessage(
        chatId,
        `No pude leer el formato. Usa líneas como:\n<pre>Producto = cantidad\n• Producto: 1,5</pre>`
      );
    }

    const { resolvedLines, missingNames, ambiguousItems } = await resolveItemsToBatchLines(parsed);

    if (resolvedLines.length) {
      if (st.mode === "base") setLines(st.batch, resolvedLines);
      else mergeLines(st.batch, resolvedLines);
      st.batch.rawSeen += resolvedLines.length;
    }

    return sendMessage(
      chatId,
      buildBatchOutcomeMessage({
        successLabel: "Texto agregado",
        sourceLabel: "texto",
        batch: st.batch,
        resolvedCount: resolvedLines.length,
        missingNames,
        ambiguousItems,
      })
    );
  }

  if (st.mode === "base") {
    return sendMessage(
      chatId,
      `Para cambiar stock base usa texto:\n<pre>Producto = cantidad</pre>\nLuego <code>/fin</code>.`
    );
  }

  // =========================
  // FOTO / DOCUMENTO (semana/ingreso)
  // =========================
  const fileMeta = pickTelegramFileFromMessage(message);
  if (!fileMeta) {
    return sendMessage(chatId, `Envíame una <b>foto</b>, <b>PDF</b> o texto <pre>Producto = cantidad</pre>.`);
  }

  const ingest = await db.query(
    `insert into ingests (chat_id, mode, telegram_file_id, telegram_file_unique_id, mime_type, file_name, file_size)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      chatId,
      st.mode,
      fileMeta.fileId,
      fileMeta.fileUniqueId,
      fileMeta.mimeType,
      fileMeta.fileName,
      fileMeta.fileSize || null,
    ]
  );
  const ingestId = ingest.rows[0].id;

  await sendMessage(
    chatId,
    `Procesando con IA… 🤖\nModo: <code>${escapeHtml(st.mode)}</code>\nArchivo: <code>${escapeHtml(
      fileMeta.fileName
    )}</code>\nIngest: <code>${ingestId}</code>`
  );

  try {
    const file = await getFile(fileMeta.fileId);
    const buffer = await downloadFile(file.file_path);

    const extracted = await extractItemsFromBuffer({
      mode: st.mode,
      buffer,
      mimeType: fileMeta.mimeType,
    });

    await sendMessage(chatId, `IA leyó: <b>${extracted.length}</b> filas 📄`);

    if (!extracted?.length) {
      await db.query(`update ingests set status='failed', error=$2 where id=$1`, [
        ingestId,
        "extractor_returned_empty",
      ]);
      return sendMessage(
        chatId,
        `No pude leer ese archivo 😵‍💫\nTip: más luz, recto y completo.\nO pega texto <pre>Coca = 2</pre>`
      );
    }

    const { resolvedLines, missingNames, ambiguousItems } = await resolveItemsToBatchLines(extracted);

    if (resolvedLines.length) {
      mergeLines(st.batch, resolvedLines);
      st.batch.rawSeen += resolvedLines.length;
    }

    const hasWarnings = missingNames.length > 0 || ambiguousItems.length > 0;
    if (hasWarnings) {
      const unresolvedTokens = [
        ...missingNames.map((name) => `missing:${name}`),
        ...ambiguousItems.map((item) => `ambiguous:${item.rawName}`),
      ];

      await db.query(`update ingests set status='processed_with_missing', error=$2 where id=$1`, [
        ingestId,
        unresolvedTokens.join(","),
      ]);
    } else {
      await db.query(`update ingests set status='processed' where id=$1`, [ingestId]);
    }

    return sendMessage(
      chatId,
      buildBatchOutcomeMessage({
        successLabel: "Foto agregada",
        sourceLabel: "foto",
        batch: st.batch,
        resolvedCount: resolvedLines.length,
        missingNames,
        ambiguousItems,
        ingestId,
      })
    );
  } catch (error) {
    const msg = error?.message || "unknown_error";
    await db.query(`update ingests set status='failed', error=$2 where id=$1`, [ingestId, msg]);

    if (String(msg).startsWith("unsupported_mime:")) {
      return sendMessage(chatId, `Ese documento no se pudo leer.\nPrueba como <b>Foto</b> y reintenta ✅`);
    }

    console.error("photo pipeline error:", error?.response?.data || msg);
    return sendMessage(
      chatId,
      `Falló el procesamiento 😵\nIngest: <code>${ingestId}</code>\nTip: intenta otra foto con mejor luz.`
    );
  }
}

module.exports = { handleCommand, handleNonCommand };
