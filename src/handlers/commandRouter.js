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

// state: chatId -> { mode, batch: { linesByProductId: Map<number, number>, rawSeen: number } }
const state = new Map();

function startBatch(chatId, mode) {
  state.set(chatId, {
    mode,
    batch: {
      // product_id -> qty acumulada (sumamos por si un producto aparece en 2 fotos)
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
    const p = message.photo[message.photo.length - 1];
    return {
      fileId: p.file_id,
      fileUniqueId: p.file_unique_id,
      mimeType: "image/jpeg",
      fileName: `photo_${Date.now()}.jpg`,
      fileSize: p.file_size,
      kind: "photo",
    };
  }
  if (message.document) {
    const d = message.document;
    return {
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      mimeType: d.mime_type || "application/octet-stream",
      fileName: d.file_name || `document_${Date.now()}`,
      fileSize: d.file_size,
      kind: "document",
    };
  }
  return null;
}

function mergeLines(batch, resolvedLines /* [{product_id, qty}] */) {
  for (const l of resolvedLines) {
    const prev = Number(batch.linesByProductId.get(l.product_id) || 0);
    batch.linesByProductId.set(l.product_id, prev + Number(l.qty || 0));
  }
}

function batchToLines(batch) {
  return Array.from(batch.linesByProductId.entries()).map(([product_id, qty]) => ({
    product_id,
    qty,
  }));
}

async function handleCommand(chatId, text) {
  const cmd = String(text || "").trim().split(/\s+/)[0];
  const st = getState(chatId);

  if (cmd === "/menu") {
    const html =
      `<b>Ibérico Inventario</b>\n\n` +
      `<code>/semana</code> — iniciar lote inventario semanal (manda 2 fotos: Alcohol y Cocina, luego <code>/fin</code>)\n` +
      `<code>/ingreso</code> — iniciar lote compras (manda 1 o más fotos, luego <code>/fin</code>)\n` +
      `<code>/fin</code> — guardar lote actual\n` +
      `<code>/cancel</code> — cancelar lote actual\n\n` +
      `<code>/stock</code> — ver stock actual\n` +
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
    if (!st) return sendMessage(chatId, `No hay lote activo. Usa <code>/semana</code> o <code>/ingreso</code>.`);

    const lines = batchToLines(st.batch);
    if (!lines.length) {
      clearBatch(chatId);
      return sendMessage(chatId, `Lote vacío. Cancelo ✅`);
    }

    if (st.mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      clearBatch(chatId);
      return sendMessage(chatId, `Inventario semanal guardado ✅\nUsa <code>/compras</code> o <code>/stock</code>.`);
    }

    if (st.mode === "ingreso") {
      await inventory.addPurchase(lines);
      clearBatch(chatId);
      return sendMessage(chatId, `Compras guardadas ✅\nUsa <code>/stock</code>.`);
    }

    clearBatch(chatId);
    return sendMessage(chatId, `Modo inválido. Usa <code>/menu</code>.`);
  }

  if (cmd === "/semana") {
    startBatch(chatId, "semana");
    return sendMessage(
      chatId,
      `Lote semanal iniciado ✅\n` +
        `Envíame <b>foto Alcohol</b> y luego <b>foto Cocina</b>.\n` +
        `Cuando termines: <code>/fin</code>\n` +
        `Si te equivocas: <code>/cancel</code>`
    );
  }

  if (cmd === "/ingreso") {
    startBatch(chatId, "ingreso");
    return sendMessage(
      chatId,
      `Lote de compras iniciado ✅\n` +
        `Envíame la(s) foto(s) de compras (Alcohol / Cocina si aplica).\n` +
        `Cuando termines: <code>/fin</code>\n` +
        `Si te equivocas: <code>/cancel</code>`
    );
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }
    const lines = rows.map((r) => `• ${escapeHtml(r.name)}: <b>${Number(r.stock_actual || 0).toFixed(2)}</b>`);
    return sendMessage(chatId, `<b>Stock actual</b>\n\n${lines.join("\n")}`);
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }
    const lines = rows.map((r) => `• ${escapeHtml(r.name)}: <b>${Number(r.faltante || 0).toFixed(2)}</b>`);
    return sendMessage(chatId, `<b>Compras sugeridas</b>\n\n${lines.join("\n")}`);
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    const byStore = new Map();
    for (const r of rows) {
      const store = String(r.store || "Sin tienda");
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(r);
    }

    let out = `<b>Compras sugeridas por tienda</b>\n`;
    for (const [store, list] of byStore.entries()) {
      out += `\n<b>${escapeHtml(store)}</b>\n`;
      out += list
        .map((x) => `• ${escapeHtml(x.name)}: <b>${Number(x.faltante || 0).toFixed(2)}</b>`)
        .join("\n");
      out += "\n";
    }

    return sendMessage(chatId, out.trim());
  }

  // Si hay lote activo, recordatorio útil
  if (st) {
    return sendMessage(chatId, `Tienes un lote activo (<code>${escapeHtml(st.mode)}</code>). Envía foto o <code>/fin</code>.`);
  }

  return sendMessage(chatId, `No entendí. Usa <code>/menu</code>.`);
}

async function handleNonCommand(chatId, message) {
  const st = getState(chatId);

  // Si manda archivo sin lote
  if (!st) {
    const hasFile = !!pickTelegramFileFromMessage(message);
    if (hasFile) return sendMessage(chatId, `Primero inicia: <code>/semana</code> o <code>/ingreso</code>.`);
    return sendMessage(chatId, `Usa <code>/menu</code>.`);
  }

  // TEXTO (permite sumar al lote)
  if (message.text) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      return sendMessage(chatId, `No pude leer el formato. Usa:\n<pre>Producto = cantidad</pre>`);
    }

    const names = parsed.map((x) => x.rawName);
    const map = await inventory.resolveProductsByNames(names);

    const missing = [];
    const resolvedLines = [];

    for (const it of parsed) {
      const resolved = map.get(it.rawName);
      if (!resolved) missing.push(it.rawName);
      else resolvedLines.push({ product_id: resolved.product_id, qty: it.qty });
    }

    if (missing.length) {
      return sendMessage(
        chatId,
        `<b>No reconocí:</b>\n${missing.map((x) => `• ${escapeHtml(x)}`).join("\n")}\n\nAgrega alias y reintenta.`
      );
    }

    mergeLines(st.batch, resolvedLines);
    st.batch.rawSeen += resolvedLines.length;

    return sendMessage(
      chatId,
      `Agregado al lote ✅ (${st.batch.linesByProductId.size} productos acumulados)\nCuando termines: <code>/fin</code>`
    );
  }

  // FOTO / DOCUMENTO
  const fileMeta = pickTelegramFileFromMessage(message);
  if (!fileMeta) {
    return sendMessage(chatId, `Envíame una <b>foto</b> del formato o texto <pre>Producto = cantidad</pre>.`);
  }

  // Log ingest
  const ingest = await db.query(
    `insert into ingests (chat_id, mode, telegram_file_id, telegram_file_unique_id, mime_type, file_name, file_size)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [chatId, st.mode, fileMeta.fileId, fileMeta.fileUniqueId, fileMeta.mimeType, fileMeta.fileName, fileMeta.fileSize || null]
  );
  const ingestId = ingest.rows[0].id;

  await sendMessage(
    chatId,
    `Procesando con IA… 🤖\nModo: <code>${escapeHtml(st.mode)}</code>\nArchivo: <code>${escapeHtml(fileMeta.fileName)}</code>\nIngest: <code>${ingestId}</code>`
  );

  try {
    const f = await getFile(fileMeta.fileId);
    const buffer = await downloadFile(f.file_path);

    const extracted = await extractItemsFromBuffer({
      mode: st.mode,
      buffer,
      mimeType: fileMeta.mimeType,
    });

    if (!extracted?.length) {
      await db.query(`update ingests set status='failed', error=$2 where id=$1`, [ingestId, "extractor_returned_empty"]);
      return sendMessage(chatId, `No pude leer esa foto 😵‍💫\nTip: más luz, recta, completa.\nO pega texto <pre>Coca = 2</pre>`);
    }

    const names = extracted.map((x) => x.rawName);
    const map = await inventory.resolveProductsByNames(names);

    const missing = [];
    const resolvedLines = [];

    for (const it of extracted) {
      const resolved = map.get(it.rawName);
      if (!resolved) missing.push(it.rawName);
      else resolvedLines.push({ product_id: resolved.product_id, qty: it.qty });
    }

    if (missing.length) {
      await db.query(`update ingests set status='failed', error=$2 where id=$1`, [ingestId, `missing_products:${missing.join(",")}`]);
      return sendMessage(
        chatId,
        `<b>Leí la foto, pero no reconocí:</b>\n${missing.map((x) => `• ${escapeHtml(x)}`).join("\n")}\n\n` +
          `Agrega alias y reintenta.\nIngest: <code>${ingestId}</code>`
      );
    }

    mergeLines(st.batch, resolvedLines);
    st.batch.rawSeen += resolvedLines.length;

    await db.query(`update ingests set status='processed' where id=$1`, [ingestId]);

    return sendMessage(
      chatId,
      `Foto agregada al lote ✅\n` +
        `Acumulado: <b>${st.batch.linesByProductId.size}</b> productos\n` +
        `Cuando termines: <code>/fin</code>`
    );
  } catch (e) {
    const msg = e?.message || "unknown_error";
    await db.query(`update ingests set status='failed', error=$2 where id=$1`, [ingestId, msg]);

    // Caso típico: PDF
    if (String(msg).startsWith("unsupported_mime:")) {
      return sendMessage(chatId, `Eso parece PDF/documento raro.\nEnvíalo como <b>Foto</b> (no archivo) y reintenta ✅`);
    }

    console.error("photo pipeline error:", e?.response?.data || msg);
    return sendMessage(chatId, `Falló el procesamiento 😵\nIngest: <code>${ingestId}</code>\nTip: intenta otra foto con mejor luz.`);
  }
}

module.exports = { handleCommand, handleNonCommand };