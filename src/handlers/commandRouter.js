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

// Estado simple por chat (modo actual)
const state = new Map(); // chatId -> { mode: 'semana'|'ingreso'|null }

function setMode(chatId, mode) {
  if (!mode) state.delete(chatId);
  else state.set(chatId, { mode });
}
function getMode(chatId) {
  return state.get(chatId)?.mode || null;
}

// Helpers
function pickTelegramFileFromMessage(message) {
  // Foto: toma la de mayor resolución (última)
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

  // Documento: puede ser imagen o PDF
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

async function handleCommand(chatId, text) {
  const cmd = String(text || "").trim().split(/\s+/)[0];

  if (cmd === "/menu") {
    const html =
      `<b>Ibérico Inventario</b>\n\n` +
      `<code>/semana</code> — subir inventario semanal (foto o texto)\n` +
      `<code>/ingreso</code> — subir compras (foto o texto)\n` +
      `<code>/stock</code> — ver stock actual\n` +
      `<code>/compras</code> — lista de compras sugerida\n` +
      `<code>/compras_tienda</code> — compras sugeridas por tienda`;

    return sendMessage(chatId, html);
  }

  if (cmd === "/semana") {
    setMode(chatId, "semana");
    return sendMessage(
      chatId,
      `Envíame el <b>inventario semanal</b>.\n\n` +
        `Puedes mandar <b>foto</b> del formato o pegar texto así:\n` +
        `<pre>Coca = 2\nAbsolut 750 ml = 1.5</pre>`
    );
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    return sendMessage(
      chatId,
      `Envíame las <b>compras/ingresos</b>.\n\n` +
        `Puedes mandar <b>foto</b> del formato o texto:\n` +
        `<pre>Coca = 6\nTonica = 12</pre>`
    );
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    const lines = rows.map((r) => {
      const name = escapeHtml(r.name);
      const qty = Number(r.stock_actual || 0).toFixed(2);
      return `• ${name}: <b>${qty}</b>`;
    });

    return sendMessage(chatId, `<b>Stock actual</b>\n\n${lines.join("\n")}`);
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    const lines = rows.map((r) => {
      const name = escapeHtml(r.name);
      const falt = Number(r.faltante || 0).toFixed(2);
      return `• ${name}: <b>${falt}</b>`;
    });

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

  return sendMessage(chatId, `No entendí. Usa <code>/menu</code>.`);
}

async function handleNonCommand(chatId, message) {
  const mode = getMode(chatId);

  // Si manda algo sin modo
  if (!mode) {
    const hasFile = !!pickTelegramFileFromMessage(message);
    if (hasFile) {
      return sendMessage(chatId, `Antes dime qué es: <code>/semana</code> o <code>/ingreso</code>.`);
    }
    return sendMessage(chatId, `Usa <code>/menu</code> para ver comandos.`);
  }

  // =========================
  // 1) TEXTO: "Producto = cantidad"
  // =========================
  if (message.text) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      return sendMessage(chatId, `No pude leer el formato. Usa:\n<pre>Producto = cantidad</pre>`);
    }

    const names = parsed.map((x) => x.rawName);
    const map = await inventory.resolveProductsByNames(names);

    const missing = [];
    const lines = [];

    for (const it of parsed) {
      const resolved = map.get(it.rawName);
      if (!resolved) missing.push(it.rawName);
      else lines.push({ product_id: resolved.product_id, qty: it.qty });
    }

    if (missing.length) {
      return sendMessage(
        chatId,
        `<b>No reconocí:</b>\n${missing.map((x) => `• ${escapeHtml(x)}`).join("\n")}\n\n` +
          `Corrige el nombre o agrega alias.`
      );
    }

    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      return sendMessage(chatId, `Inventario semanal guardado ✅\nUsa <code>/compras</code> o <code>/stock</code>.`);
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      return sendMessage(chatId, `Compras guardadas ✅\nUsa <code>/stock</code>.`);
    }
  }

  // =========================
  // 2) FOTO / DOCUMENTO: OpenAI Vision
  // =========================
  const fileMeta = pickTelegramFileFromMessage(message);
  if (!fileMeta) {
    return sendMessage(chatId, `Mándame una <b>foto</b> del formato o texto <code>Producto = cantidad</code>.`);
  }

  // Guardar ingest (debug + reintentos)
  const ingest = await db.query(
    `insert into ingests (chat_id, mode, telegram_file_id, telegram_file_unique_id, mime_type, file_name, file_size)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      chatId,
      mode,
      fileMeta.fileId,
      fileMeta.fileUniqueId,
      fileMeta.mimeType,
      fileMeta.fileName,
      fileMeta.fileSize || null,
    ]
  );
  const ingestId = ingest.rows[0].id;

  // Aviso inmediato
  await sendMessage(
    chatId,
    `Procesando con IA… 🤖\n` +
      `Modo: <code>${escapeHtml(mode)}</code>\n` +
      `Archivo: <code>${escapeHtml(fileMeta.fileName)}</code>\n` +
      `Ingest: <code>${ingestId}</code>`
  );

  try {
    // Descargar binario desde Telegram
    const f = await getFile(fileMeta.fileId);
    const buffer = await downloadFile(f.file_path);

    // 1) IA extrae items [{ rawName, qty }]
    const extracted = await extractItemsFromBuffer({
      mode,
      buffer,
      mimeType: fileMeta.mimeType,
    });

    if (!extracted?.length) {
      await db.query(`update ingests set status='failed', error=$2 where id=$1`, [
        ingestId,
        "extractor_returned_empty",
      ]);
      return sendMessage(
        chatId,
        `No pude leer esa imagen 😵‍💫\n` +
          `Tip: mejor luz, foto derecha y que se vea completa la tabla.\n` +
          `También puedes pegar texto: <pre>Coca = 2</pre>`
      );
    }

    // 2) Resolver productos por name/alias
    const names = extracted.map((x) => x.rawName);
    const map = await inventory.resolveProductsByNames(names);

    const missing = [];
    const lines = [];

    for (const it of extracted) {
      const resolved = map.get(it.rawName);
      if (!resolved) missing.push(it.rawName);
      else lines.push({ product_id: resolved.product_id, qty: it.qty });
    }

    if (missing.length) {
      await db.query(`update ingests set status='failed', error=$2 where id=$1`, [
        ingestId,
        `missing_products:${missing.join(",")}`,
      ]);
      return sendMessage(
        chatId,
        `<b>La IA leyó la foto, pero no reconocí estos productos:</b>\n` +
          `${missing.map((x) => `• ${escapeHtml(x)}`).join("\n")}\n\n` +
          `Solución: agrégalos como alias en la tabla <code>product_aliases</code> y reintenta.\n` +
          `Ingest: <code>${ingestId}</code>`
      );
    }

    // 3) Guardar a DB según modo
    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      await db.query(`update ingests set status='processed' where id=$1`, [ingestId]);
      return sendMessage(chatId, `Inventario semanal guardado ✅\nUsa <code>/compras</code> o <code>/stock</code>.`);
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      await db.query(`update ingests set status='processed' where id=$1`, [ingestId]);
      return sendMessage(chatId, `Compras guardadas ✅\nUsa <code>/stock</code>.`);
    }

    // fallback (no debería pasar)
    await db.query(`update ingests set status='failed', error=$2 where id=$1`, [
      ingestId,
      "unknown_mode",
    ]);
    return sendMessage(chatId, `Modo inválido. Usa <code>/semana</code> o <code>/ingreso</code>.`);
  } catch (e) {
    console.error("photo pipeline error:", e?.response?.data || e?.message || e);
    await db.query(`update ingests set status='failed', error=$2 where id=$1`, [
      ingestId,
      e?.message || "unknown_error",
    ]);
    return sendMessage(
      chatId,
      `Falló el procesamiento 😵\n` +
        `Ingest: <code>${ingestId}</code>\n` +
        `Tip: intenta otra foto (más luz, sin sombras, centrada).`
    );
  }
}

module.exports = { handleCommand, handleNonCommand };