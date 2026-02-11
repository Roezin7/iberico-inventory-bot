// src/handlers/commandRouter.js
const { sendMessage } = require("../services/telegramService");
const inventory = require("../services/inventoryService");
const { parseLinesFromText } = require("../services/parserService");

// =========================
// MarkdownV2 helpers (Telegram)
// =========================
// Escapa caracteres especiales de MarkdownV2:
// _ * [ ] ( ) ~ ` > # + - = | { } . ! \
function mdv2Escape(text) {
  return String(text ?? "").replace(/([_*$begin:math:display$$end:math:display$$begin:math:text$$end:math:text$~`>#+\-=|{}.!\\])/g, "\\$1");
}
function mdBold(text) {
  return `*${mdv2Escape(text)}*`;
}
function mdInlineCode(text) {
  // Dentro de `code`, Telegram recomienda escapar ` y \ al menos
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
    // +1 por el salto
    if ((buf.length + line.length + 1) > max) {
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
    const menuText = [
      mdBold("Ibérico Inventario"),
      "",
      `${mdv2Escape("/semana")} — subir inventario semanal (texto por ahora)`,
      `${mdv2Escape("/ingreso")} — subir compras (texto por ahora)`,
      `${mdv2Escape("/stock")} — ver stock actual`,
      `${mdv2Escape("/compras")} — lista de compras sugerida`,
      `${mdv2Escape("/compras_tienda")} — compras sugeridas por tienda`,
      "",
      `Formato: ${mdInlineCode("Producto = cantidad")}`,
      `Ej: ${mdInlineCode("Coca = 2")}`,
    ].join("\n");

    return sendMessage(chatId, menuText);
  }

  if (cmd === "/semana") {
    setMode(chatId, "semana");
    const msg = [
      mdBold("Inventario semanal"),
      "",
      "Envíame el inventario semanal en texto.",
      `Formato: ${mdInlineCode("Producto = cantidad")}`,
      `Ej: ${mdInlineCode("Absolut 750 ml = 1.5")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/ingreso") {
    setMode(chatId, "ingreso");
    const msg = [
      mdBold("Compras / Ingresos"),
      "",
      "Envíame las compras en texto.",
      `Formato: ${mdInlineCode("Producto = cantidad")}`,
      `Ej: ${mdInlineCode("Coca = 6")}`,
    ].join("\n");
    return sendMessage(chatId, msg);
  }

  if (cmd === "/stock") {
    const rows = await inventory.getStockActual();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, mdv2Escape("Aún no hay inventario semanal. Usa /semana."));
    }

    const lines = rows.map(r => {
      // name puede traer acentos, comillas, etc -> escapamos
      return `• ${mdv2Escape(r.name)}: *${mdv2Escape(fmtNum(r.stock_actual))}*`;
    });

    const header = mdBold("Stock actual");
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  if (cmd === "/compras") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, mdv2Escape("Aún no hay inventario semanal. Usa /semana."));
    }

    const lines = rows.map(r => {
      return `• ${mdv2Escape(r.name)}: *${mdv2Escape(fmtNum(r.faltante))}*`;
    });

    const header = mdBold("Compras sugeridas");
    const out = [header, "", ...lines].join("\n");

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  if (cmd === "/compras_tienda") {
    const rows = await inventory.getComprasSugeridas();
    if (rows?.error === "no_snapshot") {
      return sendMessage(chatId, mdv2Escape("Aún no hay inventario semanal. Usa /semana."));
    }

    const byStore = new Map();
    for (const r of rows) {
      const store = r.store || "Sin tienda";
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(r);
    }

    let out = `${mdBold("Compras sugeridas por tienda")}\n`;

    // Orden alfabético de tiendas para que siempre salga igual
    const stores = Array.from(byStore.keys()).sort((a, b) => a.localeCompare(b, "es"));
    for (const store of stores) {
      const list = byStore.get(store) || [];
      out += `\n${mdBold(store)}\n`;
      out += list
        .map(x => `• ${mdv2Escape(x.name)}: *${mdv2Escape(fmtNum(x.faltante))}*`)
        .join("\n");
      out += "\n";
    }

    out = out.trim();

    for (const part of chunkBySize(out)) {
      await sendMessage(chatId, part);
    }
    return;
  }

  return sendMessage(chatId, mdv2Escape("No entendí. Usa /menu."));
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
        mdv2Escape("No pude leer el formato."),
        `Usa: ${mdInlineCode("Producto = cantidad")}`,
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
      // Lista de no reconocidos, escapados
      const msg =
        `${mdBold("No reconocí estos productos:")}\n` +
        missing.map(x => `• ${mdv2Escape(x)}`).join("\n") +
        "\n\n" +
        mdv2Escape("Agrega alias o corrige el nombre y vuelve a enviar.");

      for (const part of chunkBySize(msg)) {
        await sendMessage(chatId, part);
      }
      return;
    }

    if (mode === "semana") {
      await inventory.resetCycleAndCreateSnapshot(lines);
      setMode(chatId, null);
      const msg = [
        "Inventario semanal guardado ✅",
        "Usa /compras o /stock.",
      ].map(mdv2Escape).join("\n");
      return sendMessage(chatId, msg);
    }

    if (mode === "ingreso") {
      await inventory.addPurchase(lines);
      setMode(chatId, null);
      const msg = [
        "Compras guardadas ✅",
        "Usa /stock.",
      ].map(mdv2Escape).join("\n");
      return sendMessage(chatId, msg);
    }
  }

  // Foto/documento: siguiente paso (IA)
  return sendMessage(chatId, mdv2Escape("Mándame /menu para ver comandos."));
}

module.exports = { handleCommand, handleNonCommand };