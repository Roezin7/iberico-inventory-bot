const { sendMessage, escapeHtml } = require("../../services/telegramService");
const inventoryService = require("../../services/inventoryService");
const wealthService = require("../../services/wealthService");
const { getTodayDateString } = require("../../utils/dateUtils");
const {
  cleanHumanText,
  parseFlexibleNumber,
  stripWrappingQuotes,
} = require("../../utils/textUtils");

const sessions = new Map();

const DIRECT_ARG_RE = /([a-z_]+)=("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+)/gi;

function getSession(chatId) {
  return sessions.get(chatId) || null;
}

function hasSession(chatId) {
  return sessions.has(chatId);
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

function setSession(chatId, session) {
  sessions.set(chatId, session);
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatPercent(value) {
  if (value === null || value === undefined) return "n/d";
  return `${Number(value).toFixed(2)}%`;
}

function isTruthyWord(value) {
  return ["1", "si", "sí", "true", "yes", "y", "sobrescribir", "actualizar"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function parseDirectArgs(text) {
  const rawArgs = String(text || "").replace(/^\/valor_semanal\s*/i, "").trim();
  if (!rawArgs) return null;

  const parsed = {};
  let foundAny = false;

  for (const match of rawArgs.matchAll(DIRECT_ARG_RE)) {
    foundAny = true;
    const key = String(match[1] || "").trim().toLowerCase();
    const rawValue = stripWrappingQuotes(match[2]);
    parsed[key] = cleanHumanText(rawValue);
  }

  return foundAny ? parsed : {};
}

function parseDirectPayload(args) {
  const cajaRaw = args.caja ?? args.caja_operativa;
  const fuerteRaw = args.fuerte ?? args.caja_fuerte;
  const bancoRaw = args.banco;
  const inventarioRaw = args.inventario;

  if (cajaRaw === undefined || fuerteRaw === undefined || bancoRaw === undefined) {
    return { error: "missing_required_fields" };
  }

  const cajaOperativa = parseFlexibleNumber(cajaRaw);
  const cajaFuerte = parseFlexibleNumber(fuerteRaw);
  const banco = parseFlexibleNumber(bancoRaw);

  if (cajaOperativa === null || cajaFuerte === null || banco === null) {
    return { error: "invalid_number_fields" };
  }

  let inventario = null;
  let inventarioSource = "auto";
  if (inventarioRaw !== undefined) {
    if (String(inventarioRaw).trim().toLowerCase() === "auto") {
      inventario = null;
      inventarioSource = "auto";
    } else {
      inventario = parseFlexibleNumber(inventarioRaw);
      if (inventario === null) return { error: "invalid_inventario" };
      inventarioSource = "manual";
    }
  }

  return {
    value: {
      snapshotDate: args.fecha || args.date || getTodayDateString(),
      cajaOperativa,
      cajaFuerte,
      banco,
      inventario,
      inventarioSource,
      notes: args.notes || args.note || args.nota || null,
      overwrite: isTruthyWord(args.overwrite || args.sobrescribir || args.update),
    },
  };
}

function buildInventoryInfo(snapshot) {
  const parts = [snapshot.inventario_source];

  if (snapshot.inventario_source === "auto") {
    parts.push(`${snapshot.inventory_total_products} prod.`);
    if (snapshot.inventory_missing_cost_products > 0) {
      parts.push(`${snapshot.inventory_missing_cost_products} sin costo fuera`);
    }
  }

  return parts.join(" / ");
}

function renderSnapshotBreakdown(snapshot) {
  return (
    `Fecha: <b>${escapeHtml(snapshot.snapshot_date)}</b>\n` +
    `Caja operativa: <b>${escapeHtml(formatMoney(snapshot.caja_operativa))}</b>\n` +
    `Caja fuerte: <b>${escapeHtml(formatMoney(snapshot.caja_fuerte))}</b>\n` +
    `Banco: <b>${escapeHtml(formatMoney(snapshot.banco))}</b>\n` +
    `Inventario: <b>${escapeHtml(formatMoney(snapshot.inventario))}</b> <code>(${escapeHtml(
      buildInventoryInfo(snapshot)
    )})</code>\n` +
    `Total: <b>${escapeHtml(formatMoney(snapshot.total_wealth))}</b>`
  );
}

function buildInventoryPrompt(autoSummary) {
  if (!autoSummary || autoSummary.error === "no_snapshot") {
    return (
      `Escribe el valor del inventario manualmente.\n` +
      `Aun no hay snapshot de inventario para usar modo automatico.`
    );
  }

  let message =
    `Escribe el inventario manual o responde <code>auto</code> para usar el calculado.\n` +
    `Auto actual: <b>${escapeHtml(formatMoney(autoSummary.inventory_value))}</b>`;

  if (autoSummary.missing_cost_count > 0) {
    message += `\nProductos fuera por falta de costo: <b>${autoSummary.missing_cost_count}</b>`;
  }

  return message;
}

function buildValidationMessage(errorCode) {
  switch (errorCode) {
    case "missing_required_fields":
      return (
        `Faltan campos requeridos.\n` +
        `Usa:\n<pre>/valor_semanal caja=5000 fuerte=20000 banco=35000 inventario=120000</pre>\n` +
        `Si omites inventario, se usa el inventario actual calculado.`
      );
    case "invalid_number_fields":
      return `No pude leer caja, fuerte o banco. Revisa los numeros y vuelve a intentar.`;
    case "invalid_inventario":
      return `No pude leer el valor de inventario. Usa un numero o <code>inventario=auto</code>.`;
    case "invalid_snapshot_date":
      return `La fecha no es valida. Usa formato <code>YYYY-MM-DD</code>.`;
    case "negative_requires_notes":
      return (
        `Los valores negativos requieren una nota explicita.\n` +
        `Ejemplo:\n<pre>/valor_semanal caja=-500 fuerte=20000 banco=35000 notes=\"ajuste de caja\"</pre>`
      );
    case "no_inventory_snapshot":
      return (
        `No pude usar inventario automatico porque aun no existe snapshot de inventario.\n` +
        `Manda inventario manual con <code>inventario=...</code> o registra primero <code>/semana</code>.`
      );
    default:
      if (String(errorCode || "").startsWith("missing_")) {
        return `Falta un dato requerido para guardar el corte semanal.`;
      }
      if (String(errorCode || "").startsWith("invalid_")) {
        return `Hay un dato invalido en el corte semanal. Revisa el formato e intenta de nuevo.`;
      }
      return `No pude guardar el corte semanal por un error de validacion.`;
  }
}

async function saveDraft(chatId, draft, { overwrite = false } = {}) {
  const result = await wealthService.saveWeeklyWealthSnapshot({
    snapshotDate: draft.snapshotDate,
    cajaOperativa: draft.cajaOperativa,
    cajaFuerte: draft.cajaFuerte,
    banco: draft.banco,
    inventario: draft.inventario,
    inventarioSource: draft.inventarioSource,
    notes: draft.notes,
    overwrite,
  });

  if (result.status === "exists") {
    setSession(chatId, {
      type: "wealth_guided",
      step: "overwrite_confirm",
      draft,
      existingSnapshot: result.snapshot,
    });

    return sendMessage(
      chatId,
      `<b>Ya existe un corte para ${escapeHtml(result.snapshot.snapshot_date)}</b>\n` +
        `${renderSnapshotBreakdown(result.snapshot)}\n\n` +
        `Responde <code>sobrescribir</code> para actualizarlo o <code>/cancel</code>.`
    );
  }

  if (result.error) {
    return sendMessage(chatId, buildValidationMessage(result.error));
  }

  clearSession(chatId);

  let html =
    `${result.status === "updated" ? "Corte semanal actualizado" : "Corte semanal guardado"} ✅\n\n` +
    `${renderSnapshotBreakdown(result.snapshot)}`;

  if (result.inventoryAutoSummary?.missing_cost_count > 0) {
    html += `\n\nInventario auto calculado con <b>${result.inventoryAutoSummary.missing_cost_count}</b> productos fuera por falta de costo.`;
  }

  return sendMessage(chatId, html);
}

async function startGuidedFlow(chatId) {
  setSession(chatId, {
    type: "wealth_guided",
    step: "caja_operativa",
    draft: {
      snapshotDate: getTodayDateString(),
      cajaOperativa: null,
      cajaFuerte: null,
      banco: null,
      inventario: null,
      inventarioSource: "auto",
      notes: null,
    },
    autoInventorySummary: null,
  });

  return sendMessage(
    chatId,
    `<b>Registro de valor semanal</b>\n` +
      `Fecha: <b>${escapeHtml(getTodayDateString())}</b>\n\n` +
      `Escribe la <b>caja operativa</b>.`
  );
}

function buildGuidedConfirmation(session) {
  const draft = session.draft;
  const autoInfo =
    draft.inventarioSource === "auto" && session.autoInventorySummary?.missing_cost_count
      ? `\nProductos fuera por falta de costo: <b>${session.autoInventorySummary.missing_cost_count}</b>`
      : "";

  return (
    `<b>Confirma el corte semanal</b>\n` +
    `Fecha: <b>${escapeHtml(draft.snapshotDate)}</b>\n` +
    `Caja operativa: <b>${escapeHtml(formatMoney(draft.cajaOperativa))}</b>\n` +
    `Caja fuerte: <b>${escapeHtml(formatMoney(draft.cajaFuerte))}</b>\n` +
    `Banco: <b>${escapeHtml(formatMoney(draft.banco))}</b>\n` +
    `Inventario: <b>${escapeHtml(
      formatMoney(
        draft.inventarioSource === "manual"
          ? draft.inventario
          : session.autoInventorySummary?.inventory_value || 0
      )
    )}</b> <code>(${escapeHtml(draft.inventarioSource)})</code>${autoInfo}\n\n` +
    `Responde <code>guardar</code> para guardar o <code>/cancel</code>.`
  );
}

async function handleGuidedText(chatId, message) {
  const session = getSession(chatId);
  if (!session) return null;

  const text = cleanHumanText(message.text || "");
  const lowered = text.toLowerCase();

  if (session.step === "overwrite_confirm") {
    if (["sobrescribir", "actualizar", "si", "sí", "guardar"].includes(lowered)) {
      return saveDraft(chatId, session.draft, { overwrite: true });
    }

    return sendMessage(
      chatId,
      `Responde <code>sobrescribir</code> para actualizar el corte existente o <code>/cancel</code>.`
    );
  }

  if (session.step === "confirm") {
    if (["guardar", "si", "sí", "confirmar"].includes(lowered)) {
      return saveDraft(chatId, session.draft);
    }

    return sendMessage(
      chatId,
      `Responde <code>guardar</code> para confirmar o <code>/cancel</code> para cancelar.`
    );
  }

  const parsedNumber = parseFlexibleNumber(text);
  if (session.step !== "inventario") {
    if (parsedNumber === null) {
      return sendMessage(chatId, `Necesito un numero valido para continuar.`);
    }

    if (parsedNumber < 0) {
      return sendMessage(
        chatId,
        `En modo guiado no acepto negativos. Si necesitas un ajuste negativo, usa <code>/valor_semanal ... notes=\"motivo\"</code>.`
      );
    }
  }

  if (session.step === "caja_operativa") {
    session.draft.cajaOperativa = parsedNumber;
    session.step = "caja_fuerte";
    setSession(chatId, session);
    return sendMessage(chatId, `Escribe la <b>caja fuerte</b>.`);
  }

  if (session.step === "caja_fuerte") {
    session.draft.cajaFuerte = parsedNumber;
    session.step = "banco";
    setSession(chatId, session);
    return sendMessage(chatId, `Escribe el saldo de <b>banco</b>.`);
  }

  if (session.step === "banco") {
    session.draft.banco = parsedNumber;
    session.step = "inventario";
    session.autoInventorySummary = await inventoryService.getCurrentInventoryValue();
    setSession(chatId, session);
    return sendMessage(chatId, buildInventoryPrompt(session.autoInventorySummary));
  }

  if (session.step === "inventario") {
    if (["auto", "usar inventario", "inventario actual"].includes(lowered)) {
      if (session.autoInventorySummary?.error === "no_snapshot") {
        return sendMessage(
          chatId,
          `Aun no hay inventario automatico disponible. Escribe el inventario manualmente.`
        );
      }

      session.draft.inventario = null;
      session.draft.inventarioSource = "auto";
    } else {
      if (parsedNumber === null) {
        return sendMessage(
          chatId,
          `Escribe un numero para inventario o responde <code>auto</code>.`
        );
      }

      if (parsedNumber < 0) {
        return sendMessage(
          chatId,
          `En modo guiado no acepto inventario negativo. Si necesitas ajuste negativo, usa modo directo con nota.`
        );
      }

      session.draft.inventario = parsedNumber;
      session.draft.inventarioSource = "manual";
    }

    session.step = "confirm";
    setSession(chatId, session);
    return sendMessage(chatId, buildGuidedConfirmation(session));
  }

  return null;
}

async function handleCommand({ chatId, text, hasConflictingBatch = false }) {
  const cmd = String(text || "").trim().split(/\s+/)[0];

  if (cmd === "/cancel" && hasSession(chatId)) {
    clearSession(chatId);
    return sendMessage(chatId, `Registro de valor semanal cancelado ✅`);
  }

  if (cmd === "/fin" && hasSession(chatId)) {
    return sendMessage(
      chatId,
      `Tienes un registro de valor semanal en progreso. Responde <code>guardar</code> o <code>/cancel</code>.`
    );
  }

  if (cmd === "/valor_semanal") {
    if (hasConflictingBatch) {
      return sendMessage(
        chatId,
        `Primero termina o cancela tu lote activo antes de registrar el valor semanal.`
      );
    }

    const args = parseDirectArgs(text);
    if (args === null) {
      return startGuidedFlow(chatId);
    }

    const parsed = parseDirectPayload(args);
    if (parsed.error) {
      return sendMessage(chatId, buildValidationMessage(parsed.error));
    }

    const result = await wealthService.saveWeeklyWealthSnapshot(parsed.value);

    if (result.status === "exists") {
      setSession(chatId, {
        type: "wealth_guided",
        step: "overwrite_confirm",
        draft: parsed.value,
        existingSnapshot: result.snapshot,
      });

      return sendMessage(
        chatId,
        `<b>Ya existe un corte para ${escapeHtml(result.snapshot.snapshot_date)}</b>\n` +
          `${renderSnapshotBreakdown(result.snapshot)}\n\n` +
          `Responde <code>sobrescribir</code> para actualizarlo o <code>/cancel</code>.`
      );
    }

    if (result.error) {
      return sendMessage(chatId, buildValidationMessage(result.error));
    }

    let html =
      `${result.status === "updated" ? "Corte semanal actualizado" : "Corte semanal guardado"} ✅\n\n` +
      `${renderSnapshotBreakdown(result.snapshot)}`;

    if (result.inventoryAutoSummary?.missing_cost_count > 0) {
      html += `\n\nInventario auto calculado con <b>${result.inventoryAutoSummary.missing_cost_count}</b> productos fuera por falta de costo.`;
    }

    return sendMessage(chatId, html);
  }

  if (cmd === "/valor_total") {
    const snapshot = await wealthService.getLatestWealthSnapshot();
    if (!snapshot) {
      return sendMessage(chatId, `Aun no hay cortes de valor semanal registrados.`);
    }

    return sendMessage(chatId, `<b>Ultimo valor total del negocio</b>\n\n${renderSnapshotBreakdown(snapshot)}`);
  }

  if (cmd === "/valor_historial") {
    const history = await wealthService.getWealthHistory({ weeks: 8, order: "desc" });
    if (!history.length) {
      return sendMessage(chatId, `Aun no hay cortes de valor semanal registrados.`);
    }

    const lines = history.map(
      (snapshot) =>
        `• ${escapeHtml(snapshot.snapshot_date)}: <b>${escapeHtml(
          formatMoney(snapshot.total_wealth)
        )}</b>`
    );
    return sendMessage(chatId, `<b>Historial de valor semanal</b>\n\n${lines.join("\n")}`);
  }

  if (cmd === "/valor_cambio") {
    const change = await wealthService.getWealthChange();
    if (change?.error === "no_wealth_snapshots") {
      return sendMessage(chatId, `Aun no hay cortes de valor semanal registrados.`);
    }
    if (change?.error === "insufficient_wealth_history") {
      return sendMessage(chatId, `Necesito al menos 2 cortes para comparar cambios semanales.`);
    }

    return sendMessage(
      chatId,
      `<b>Cambio semanal</b>\n` +
        `Actual: <b>${escapeHtml(formatMoney(change.current.total_wealth))}</b> <code>(${escapeHtml(
          change.current.snapshot_date
        )})</code>\n` +
        `Anterior: <b>${escapeHtml(formatMoney(change.previous.total_wealth))}</b> <code>(${escapeHtml(
          change.previous.snapshot_date
        )})</code>\n` +
        `Diferencia: <b>${escapeHtml(formatMoney(change.absolute_change))}</b>\n` +
        `Porcentaje: <b>${escapeHtml(formatPercent(change.percent_change))}</b>\n\n` +
        `Caja: <code>${escapeHtml(formatMoney(change.component_changes.caja_operativa))}</code>\n` +
        `Fuerte: <code>${escapeHtml(formatMoney(change.component_changes.caja_fuerte))}</code>\n` +
        `Banco: <code>${escapeHtml(formatMoney(change.component_changes.banco))}</code>\n` +
        `Inventario: <code>${escapeHtml(formatMoney(change.component_changes.inventario))}</code>`
    );
  }

  if (cmd === "/valor_mes") {
    const summary = await wealthService.getWealthMonthSummary({ weeks: 5 });
    if (summary?.error === "no_wealth_snapshots") {
      return sendMessage(chatId, `Aun no hay cortes de valor semanal registrados.`);
    }

    let html =
      `<b>Resumen ultimas semanas</b>\n` +
      `Cortes analizados: <b>${summary.snapshot_count}</b>\n` +
      `Cambio neto: <b>${escapeHtml(formatMoney(summary.net_change))}</b> <code>(${escapeHtml(
        formatPercent(summary.net_percent_change)
      )})</code>\n` +
      `Promedio semanal: <b>${escapeHtml(formatMoney(summary.average_weekly_change || 0))}</b>\n` +
      `Promedio total: <b>${escapeHtml(formatMoney(summary.average_total || 0))}</b>`;

    if (summary.best_week) {
      html += `\nMejor semana: <b>${escapeHtml(formatMoney(summary.best_week.absolute_change))}</b> <code>(${escapeHtml(
        summary.best_week.from_date
      )} -> ${escapeHtml(summary.best_week.to_date)})</code>`;
    }

    if (summary.worst_week) {
      html += `\nPeor semana: <b>${escapeHtml(formatMoney(summary.worst_week.absolute_change))}</b> <code>(${escapeHtml(
        summary.worst_week.from_date
      )} -> ${escapeHtml(summary.worst_week.to_date)})</code>`;
    }

    return sendMessage(chatId, html);
  }

  return null;
}

async function handleNonCommand({ chatId, message }) {
  if (!hasSession(chatId)) return null;
  if (!message.text) {
    return sendMessage(chatId, `Escribe el dato solicitado o usa <code>/cancel</code>.`);
  }

  return handleGuidedText(chatId, message);
}

module.exports = {
  clearSession,
  getSession,
  handleCommand,
  handleNonCommand,
  hasSession,
  parseDirectArgs,
  parseDirectPayload,
};
