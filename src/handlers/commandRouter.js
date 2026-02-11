// src/handlers/commandRouter.js
const { sendMessage } = require("../services/telegramService");
const inventory = require("../services/inventoryService");
const { parseLinesFromText } = require("../services/parserService");

// =========================
// MarkdownV2 (Telegram) - ÚNICO escape correcto
// Escapa: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
// =========================
function md(text) {
  return String(text ?? "").replace(/([_*$begin:math:display$$end:math:display$$begin:math:text$$end:math:text$~`>#+\-=|{}.!\\])/g, "\\$1");
}

function b(text) {
  return `*${md(text)}*`;
}

function code(text) {
  // Inline code: lo más seguro es escaparlo normal también
  // (Telegram es muy quisquilloso con backticks)
  return `\`${md(text)}\``;
}

function fmtNum(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

// Telegram ~4096 chars
const TG_MAX = 3800;
function chunkBySize(text, max = TG_MAX) {
  const parts = [];
  let buf = "";
  for (const line of String(text || "").split("\n")) {
    if (buf.length + line.length + 1 > max) {
      if (buf.trim()) parts.push(buf.trimEnd());
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim()) parts.push(buf.trimEnd());
  return parts.length ? parts : [""];
}

// =========================
// State
// =========================
const state = new Map(); // chatId -> { mode: 'semana'|'ingreso' }

function setMode(chatId, mode) {
  if (!mode) state.delete(chatId);
  else state.set(chatId, { mode });
}
function getMode(chatId) {
  return state.get(chatId)?.mode || null;
}

// =========================
// Commands
// =========================
async function handleCommand(chatId, text) {
  const cmd = String(text || "").trim().split(/\s+/)[0];

  if (cmd === "/menu") {
    // OJO: aquí NO escribimos escapes a mano.
    // Todo lo “normal” va con md(), y el formato solo lo ponemos con *...* y `...`
    const msg = [
      b("Ibérico Inventario"),
      "",
      `${md("/semana")} — ${md("subir inventario semanal")} ${md("(texto por ahora)")}`,
      `${md("/ingreso")} — ${md("subir compras")} ${md("(texto por ahora)")}`,
      `${md("/stock")} — ${md("ver stock actual")}`,
      `${md("/compras")} — ${md("lista de compras sugerida")}`,
      `${md("/compras_tienda")} — ${md("compras sugeridas por tienda")}`,
      "",
      `${md("Formato")}:`,
      code("Producto = cantidad"),
      `${md("Ej")}:`,
      code("Coca = 2"),
    ].join("\n");

    return sendMessage(chatId, msg);
  }

  if (cmd === "/semana") {
    setMode(chatId, "semana");
    const msg = [
      b("Inventario semanal"),
      "",
      md("Envíame el inventario semanal en texto."),
      `${md("Formato")}: ${code("Producto = cantidad")}`,
      `${md("Ej")}: ${code("Absolut 750 ml = 1.5")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    const msg = [
      b("Compras / Ingresos"),
      "",
      md("Envíame las compras en texto."),
      `${md("Formato")}: ${code("Producto = cantidad")}`,
      `${md("Ej")}: ${code("Coca = 6")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, md("Aún no hay inventario semanal. Usa /semana."));
    }

    const header = b("Stock actual");
    const lines = rows.map(r => `• ${md(r.name)}: *${md(fmtNum(r.stock_actual))}*`);
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) await sendMessage(chatId, part);
    return;
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, md("Aún no hay inventario semanal. Usa /semana."));
    }

    const header = b("Compras sugeridas");
    const lines = rows.map(r => `• ${md(r.name)}: *${md(fmtNum(r.faltante))}*`);
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) await sendMessage(chatId, part);
    return;
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, md("Aún no hay inventario semanal. Usa /semana."));
    }

    const byStore = new Map();
    for (const r of rows) {
      const store = r.store || "Sin tienda";
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(r);
    }

    const stores = Array.from(byStore.keys()).sort((a, b) => a.localeCompare(b, "es"));

    let out = `${b("Compras sugeridas por tienda")}\n`;

    for (const store of stores) {
      const list = byStore.get(store) || [];
      out += `\n${b(store)}\n`;
      out += list.map(x => `• ${md(x.name)}: *${md(fmtNum(x.faltante))}*`).join("\n");
      out += "\n";
    }

    out = out.trim();
    for (const part of chunkBySize(out)) await sendMessage(chatId, part);
    return;
  }

  return sendMessage(chatId, md("No entendí. Usa /menu."));
}

// =========================
// Non-command handler
// =========================
async function handleNonCommand(chatId, message) {
  const mode = getMode(chatId);

  if (message?.text && mode) {
    const parsed = parseLinesFromText(message.text);

    if (!parsed.length) {
      const msg = [md("No pude leer el formato."), `${md("Usa")}: ${code("Producto = cantidad")}`].join("\n");
      return sendMessage(chatId, msg);
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
      const msg =
        `${b("No reconocí estos productos:")}\n` +
        missing.map(x => `• ${md(x)}`).join("\n") +
        "\n\n" +
        md("Agrega alias o corrige el nombre y vuelve a enviar.");

      for (const part of chunkBySize(msg)) await sendMessage(chatId, part);
      return;
    }

    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      return sendMessage(chatId, [md("Inventario semanal guardado ✅"), md("Usa /compras o /stock.")].join("\n"));
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      return sendMessage(chatId, [md("Compras guardadas ✅"), md("Usa /stock.")].join("\n"));
    }
  }

  return sendMessage(chatId, md("Mándame /menu para ver comandos."));
}

module.exports = { handleCommand, handleNonCommand };