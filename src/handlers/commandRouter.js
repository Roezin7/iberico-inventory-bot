// src/handlers/commandRouter.js
const { sendMessage } = require("../services/telegramService");
const inventory = require("../services/inventoryService");
const { parseLinesFromText } = require("../services/parserService");

// =========================
// MarkdownV2 helpers (Telegram)
// =========================
// Escapa caracteres especiales de MarkdownV2:
// _ * [ ] ( ) ~ ` > # + - = | { } . ! \
function esc(text) {
  return String(text ?? "").replace(/([_*$begin:math:display$$end:math:display$$begin:math:text$$end:math:text$~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Para comandos tipo /compras_tienda: SOLO escapamos "_" y "\" (suficiente y legible)
function escCmd(text) {
  return String(text ?? "").replace(/([_\\])/g, "\\$1");
}

function bold(text) {
  return `*${esc(text)}*`;
}

function codeInline(text) {
  // Inline code en MarkdownV2: escapamos ` y \
  const t = String(text ?? "").replace(/([`\\])/g, "\\$1");
  return `\`${t}\``;
}

function fmtNum(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

// Telegram tiene límite ~4096 chars por mensaje
const TG_MAX = 3800; // margen
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
// Simple in-memory state
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
    // OJO: En MarkdownV2, "_" debe ir escapado
    const menuText = [
      bold("Ibérico Inventario"),
      "",
      `${escCmd("/semana")} — ${esc("subir inventario semanal")} ${esc("(texto por ahora)")}`,
      `${escCmd("/ingreso")} — ${esc("subir compras")} ${esc("(texto por ahora)")}`,
      `${escCmd("/stock")} — ${esc("ver stock actual")}`,
      `${escCmd("/compras")} — ${esc("lista de compras sugerida")}`,
      `${escCmd("/compras_tienda")} — ${esc("compras sugeridas por tienda")}`,
      "",
      `${esc("Formato")}:`,
      codeInline("Producto = cantidad"),
      `${esc("Ej")}:`,
      codeInline("Coca = 2"),
    ].join("\n");

    return sendMessage(chatId, menuText);
  }

  if (cmd === "/semana") {
    setMode(chatId, "semana");
    const msg = [
      bold("Inventario semanal"),
      "",
      esc("Envíame el inventario semanal en texto."),
      `${esc("Formato")}: ${codeInline("Producto = cantidad")}`,
      `${esc("Ej")}: ${codeInline("Absolut 750 ml = 1.5")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    const msg = [
      bold("Compras / Ingresos"),
      "",
      esc("Envíame las compras en texto."),
      `${esc("Formato")}: ${codeInline("Producto = cantidad")}`,
      `${esc("Ej")}: ${codeInline("Coca = 6")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, esc("Aún no hay inventario semanal. Usa /semana."));
    }

    const header = bold("Stock actual");
    const lines = rows.map(r => `• ${esc(r.name)}: *${esc(fmtNum(r.stock_actual))}*`);
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, esc("Aún no hay inventario semanal. Usa /semana."));
    }

    const header = bold("Compras sugeridas");
    const lines = rows.map(r => `• ${esc(r.name)}: *${esc(fmtNum(r.faltante))}*`);
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, esc("Aún no hay inventario semanal. Usa /semana."));
    }

    const byStore = new Map();
    for (const r of rows) {
      const store = r.store || "Sin tienda";
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(r);
    }

    // Orden alfabético para salida estable
    const stores = Array.from(byStore.keys()).sort((a, b) => a.localeCompare(b, "es"));

    let out = `${bold("Compras sugeridas por tienda")}\n`;

    for (const store of stores) {
      const list = byStore.get(store) || [];
      out += `\n${bold(store)}\n`;
      out += list
        .map(x => `• ${esc(x.name)}: *${esc(fmtNum(x.faltante))}*`)
        .join("\n");
      out += "\n";
    }

    out = out.trim();

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  return sendMessage(chatId, esc("No entendí. Usa /menu."));
}

// =========================
// Non-command handler
// =========================
async function handleNonCommand(chatId, message) {
  const mode = getMode(chatId);

  // MVP: texto directo
  if (message?.text && mode) {
    const parsed = parseLinesFromText(message.text);
    if (!parsed.length) {
      const msg = [
        esc("No pude leer el formato."),
        `${esc("Usa")}: ${codeInline("Producto = cantidad")}`,
      ].join("\n");
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
        `${bold("No reconocí estos productos:")}\n` +
        missing.map(x => `• ${esc(x)}`).join("\n") +
        "\n\n" +
        esc("Agrega alias o corrige el nombre y vuelve a enviar.");

      for (const part of chunkBySize(msg)) {
        await sendMessage(chatId, part);
      }
      return;
    }

    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      const msg = [
        esc("Inventario semanal guardado ✅"),
        esc("Usa /compras o /stock."),
      ].join("\n");
      return sendMessage(chatId, msg);
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      const msg = [
        esc("Compras guardadas ✅"),
        esc("Usa /stock."),
      ].join("\n");
      return sendMessage(chatId, msg);
    }
  }

  // Foto/documento: siguiente paso (IA)
  return sendMessage(chatId, esc("Mándame /menu para ver comandos."));
}

module.exports = { handleCommand, handleNonCommand };