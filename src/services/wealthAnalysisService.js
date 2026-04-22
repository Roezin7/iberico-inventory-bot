const OpenAI = require("openai");
const wealthService = require("./wealthService");

const ANALYSIS_MODEL = process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-5.2";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

function buildFallbackAnalysis({ history, summary, monthly }) {
  const latest = history[history.length - 1];
  const lines = [];

  lines.push(
    `El ultimo corte del ${latest.snapshot_date} deja un valor total de ${formatMoney(
      latest.total_wealth
    )}.`
  );

  if (summary.percent_change !== null && summary.percent_change !== undefined) {
    lines.push(
      `Contra el corte previo, el negocio cambio ${formatMoney(
        summary.absolute_change
      )}, equivalente a ${formatPercent(summary.percent_change)}.`
    );
  } else {
    lines.push("Aun no hay suficiente historial para comparar contra una semana previa.");
  }

  if (monthly.net_percent_change !== null && monthly.net_percent_change !== undefined) {
    lines.push(
      `En la ventana analizada el cambio neto fue de ${formatMoney(
        monthly.net_change
      )}, o ${formatPercent(monthly.net_percent_change)}.`
    );
  }

  if (summary.cash_ratio !== null && summary.inventory_ratio !== null) {
    lines.push(
      `La liquidez actual representa ${formatPercent(
        summary.cash_ratio * 100
      )} del valor total, mientras que inventario representa ${formatPercent(
        summary.inventory_ratio * 100
      )}.`
    );

    if (summary.inventory_ratio > 0.65) {
      lines.push("El inventario pesa demasiado en el valor total y conviene vigilar rotacion y liquidez.");
    } else if (summary.cash_ratio < 0.15) {
      lines.push("La liquidez esta baja frente al valor total; conviene cuidar caja y banco.");
    }
  }

  if (monthly.best_week) {
    lines.push(
      `La mejor semana fue ${monthly.best_week.from_date} -> ${monthly.best_week.to_date} con un cambio de ${formatMoney(
        monthly.best_week.absolute_change
      )}.`
    );
  }

  if (monthly.worst_week) {
    lines.push(
      `La semana mas debil fue ${monthly.worst_week.from_date} -> ${monthly.worst_week.to_date} con un cambio de ${formatMoney(
        monthly.worst_week.absolute_change
      )}.`
    );
  }

  return lines.join(" ");
}

async function generateWealthAnalysis({ weeks = 4 } = {}) {
  const data = await wealthService.getWealthAnalysisData({ weeks });
  if (data?.error) return data;

  const fallback = buildFallbackAnalysis(data);
  if (!openai) {
    return {
      ...data,
      analysis: fallback,
      analysis_source: "fallback",
    };
  }

  const latest = data.history[data.history.length - 1];
  const payload = {
    latest_snapshot: latest,
    summary: data.summary,
    monthly: {
      current_total: data.monthly.current_total,
      starting_total: data.monthly.starting_total,
      net_change: data.monthly.net_change,
      net_percent_change: data.monthly.net_percent_change,
      average_total: data.monthly.average_total,
      average_weekly_change: data.monthly.average_weekly_change,
      best_week: data.monthly.best_week,
      worst_week: data.monthly.worst_week,
    },
    history: data.history.map((snapshot) => ({
      snapshot_date: snapshot.snapshot_date,
      total_wealth: snapshot.total_wealth,
      cash_total: snapshot.cash_total,
      inventory: snapshot.inventario,
    })),
  };

  try {
    const response = await openai.responses.create({
      model: ANALYSIS_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Eres un analista financiero para un negocio restaurantero. Responde en espanol neutro, breve y util. No recalcules numeros: usa solo los datos proporcionados. Enfocate en tendencia, liquidez, inventario y alertas practicas.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Analiza el valor semanal del negocio con este resumen estructurado:\n${JSON.stringify(
                  payload
                )}\n\nDevuelve un parrafo breve y luego 3 bullets concretos con insights accionables.`,
            },
          ],
        },
      ],
    });

    const text = String(response.output_text || "").trim();
    return {
      ...data,
      analysis: text || fallback,
      analysis_source: text ? "openai" : "fallback",
    };
  } catch (error) {
    console.error("wealth analysis error:", error?.response?.data || error?.message || error);
    return {
      ...data,
      analysis: fallback,
      analysis_source: "fallback",
    };
  }
}

module.exports = {
  generateWealthAnalysis,
};
