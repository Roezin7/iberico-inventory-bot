// src/services/telegramService.js
const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN;
const api = `https://api.telegram.org/bot${token}`;

async function sendMessage(chatId, text, opts = {}) {
  return axios.post(`${api}/sendMessage`, {
    chat_id: chatId,
    text: String(text ?? ""),
    parse_mode: "MarkdownV2",
    ...opts,
  });
}

module.exports = { sendMessage };