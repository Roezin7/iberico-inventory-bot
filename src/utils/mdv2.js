const { escapeMarkdownV2 } = require("../services/telegramService");

function bold(s) {
  return `*${escapeMarkdownV2(s)}*`;
}

function mono(s) {
  // Inline code en MarkdownV2 usa backticks, pero adentro debes escapar ` y \
  const t = String(s ?? "").replace(/([`\\])/g, "\\$1");
  return `\`${t}\``;
}

// Para líneas normales ya escapadas
function line(s) {
  return escapeMarkdownV2(s);
}

module.exports = { bold, mono, line };