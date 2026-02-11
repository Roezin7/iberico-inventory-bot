const { sendMessage, getFile, downloadFile } = require("../services/telegramService");
const inventory = require("../services/inventoryService");
const { parseLinesFromText } = require("../services/parserService");

const state = new Map(); // chatId -> { mode: 'semana'|'ingreso' }

function setMode(chatId, mode) {
  state.set(chatId, { mode });
}
function getMode(chatId) {
  return state.get(chatId)?.mode || null;
}

async function handleCommand(chatId, text) {
  const cmd = String(text || "").trim().split(/\s+/)[0];

  if (cmd === "/menu") {
    return sendMessage(
      chatId,
      [
        "*Ibérico Inventario*",
        "",
        "/semana — subir inventario semanal (foto o texto)",
        "/ingreso — subir compras (foto o texto)",
        "/stock — ver stock actual",
        "/compras — lista de compras sugerida",
        "/compras_tienda — compras sugeridas por tienda",
      ].join("\n")
    );
  }

  if (cmd === "/semana") {
    setMode(chatId, "semana");
    return sendMessage(chatId, "Envíame el inventario semanal.\nPuedes pegar texto como:\n`Coca = 2`");
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    return sendMessage(chatId, "Envíame las compras/ingresos.\nFormato:\n`Coca = 6`");
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows.error === "no_snapshot") return sendMessage(chatId, "Aún no hay inventario semanal. Usa /semana.");
    const msg = rows.map(r => `• ${r.name}: *${Number(r.stock_actual).toFixed(2)}*`).join("\n");
    return sendMessage(chatId, `*Stock actual*\n\n${msg}`);
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows.error === "no_snapshot") return sendMessage(chatId, "Aún no hay inventario semanal. Usa /semana.");
    const msg = rows.map(r => `• ${r.name}: *${Number(r.faltante).toFixed(2)}*`).join("\n");
    return sendMessage(chatId, `*Compras sugeridas*\n\n${msg}`);
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows.error === "no_snapshot") return sendMessage(chatId, "Aún no hay inventario semanal. Usa /semana.");

    const byStore = new Map();
    for (const r of rows) {
      if (!byStore.has(r.store)) byStore.set(r.store, []);
      byStore.get(r.store).push(r);
    }

    let out = "*Compras sugeridas por tienda*\n";
    for (const [store, list] of byStore.entries()) {
      out += `\n*${store}*\n`;
      out += list.map(x => `• ${x.name}: *${Number(x.faltante).toFixed(2)}*`).join("\n");
      out += "\n";
    }
    return sendMessage(chatId, out.trim());
  }

  return sendMessage(chatId, "No entendí. Usa /menu.");
}

async function handleNonCommand(chatId, message) {
  const mode = getMode(chatId);

  // MVP: texto directo
  if (message.text && mode) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      return sendMessage(chatId, "No pude leer el formato. Usa `Producto = cantidad`.");
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
      return sendMessage(chatId, `No reconocí:\n${missing.map(x => `• ${x}`).join("\n")}\nAgrega alias o corrige nombre.`);
    }

    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      return sendMessage(chatId, "Inventario semanal guardado ✅\nUsa /compras o /stock.");
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      return sendMessage(chatId, "Compras guardadas ✅\nUsa /stock.");
    }
  }

  // Foto/documento: lo conectamos en el siguiente paso (IA)
  return sendMessage(chatId, "Mándame /menu para ver comandos.");
}

module.exports = { handleCommand, handleNonCommand };