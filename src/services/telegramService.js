const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN;
const api = `https://api.telegram.org/bot${token}`;

// Escapa MarkdownV2 (Telegram)
function escapeMarkdownV2(text) {
  // Caracteres que Telegram MarkdownV2 requiere escapar:
  // _ * [ ] ( ) ~ ` > # + - = | { } . !
  return String(text ?? "").replace(/([_*$begin:math:display$$end:math:display$$begin:math:text$$end:math:text$~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Para texto dentro de code block o inline code es distinto.
// Truco práctico: si vas a mandar un bloque de código, NO lo escapes por dentro,
// mejor envíalo como preformateado sin parsear o en HTML.
// Aquí vamos a evitar code blocks en mensajes normales.
async function sendMessage(chatId, text, opts = {}) {
  return axios.post(`${api}/sendMessage`, {
    chat_id: chatId,
    text: String(text ?? ""),
    parse_mode: "MarkdownV2",
    ...opts,
  });
}


module.exports = { sendMessage, escapeMarkdownV2 };