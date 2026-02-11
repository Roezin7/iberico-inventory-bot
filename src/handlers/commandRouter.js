// src/handlers/commandRouter.js
const { sendMessage, escapeHtml } = require("../services/telegramService");
const inventory = require("../services/inventoryService");
const { parseLinesFromText } = require("../services/parserService");

const state = new Map(); // chatId -> { mode: 'semana'|'ingreso'|null }

function setMode(chatId, mode) {
  if (!mode) state.delete(chatId);
  else state.set(chatId, { mode });
}
function getMode(chatId) {
  return state.get(chatId)?.mode || null;
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
        `Por ahora puedes pegar texto así:\n` +
        `<pre>Coca = 2\nAbsolut 750 ml = 1.5</pre>`
    );
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    return sendMessage(
      chatId,
      `Envíame las <b>compras/ingresos</b>.\n\n` +
        `Formato:\n` +
        `<pre>Coca = 6\nTonica = 12</pre>`
    );
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, `Aún no hay inventario semanal. Usa <code>/semana</code>.`);
    }

    const lines = rows.map(r => {
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

    const lines = rows.map(r => {
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
        .map(x => `• ${escapeHtml(x.name)}: <b>${Number(x.faltante || 0).toFixed(2)}</b>`)
        .join("\n");
      out += "\n";
    }

    return sendMessage(chatId, out.trim());
  }

  return sendMessage(chatId, `No entendí. Usa <code>/menu</code>.`);
}

async function handleNonCommand(chatId, message) {
  const mode = getMode(chatId);

  // MVP: texto directo
  if (message.text && mode) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      return sendMessage(chatId, `No pude leer el formato. Usa:\n<pre>Producto = cantidad</pre>`);
    }

    const names = parsed.map(x => x.rawName);
    const map = await inventory.resolveProductsByNames(names);

    const missing = [];
    const lines = [];

    for (const it of parsed) {
      const resolved = map.get(it.rawName);
      if (!resolved) {
        missing.push(it.rawName);
        continue;
      }
      lines.push({ product_id: resolved.product_id, qty: it.qty });
    }

    if (missing.length) {
      const m = missing.map(x => `• ${escapeHtml(x)}`).join("\n");
      return sendMessage(
        chatId,
        `<b>No reconocí:</b>\n${m}\n\nCorrige el nombre o agrega alias.`
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

  // Foto/documento: lo conectamos después
  return sendMessage(chatId, `Usa <code>/menu</code> para ver comandos.`);
}

module.exports = { handleCommand, handleNonCommand };