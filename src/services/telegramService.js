// src/services/telegramService.js
const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const api = `https://api.telegram.org/bot${token}`;

/**
 * Escapa HTML para Telegram parse_mode=HTML
 */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Envía mensaje en HTML (NO Markdown).
 * Importante: no metas tags raros, solo <b>, <i>, <code>, <pre>.
 */
async function sendMessage(chatId, htmlText, opts = {}) {
  const payload = {
    chat_id: chatId,
    text: String(htmlText ?? ""),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  };

  try {
    const res = await axios.post(`${api}/sendMessage`, payload);
    return res.data;
  } catch (err) {
    // Log útil pero sin tirar todo el server
    const data = err?.response?.data;
    console.error("Telegram sendMessage error:", data || err.message);
    throw err;
  }
}

async function getFile(fileId) {
  const { data } = await axios.get(`${api}/getFile`, { params: { file_id: fileId } });
  if (!data.ok) throw new Error("getFile_failed");
  return data.result;
}

async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

module.exports = {
  sendMessage,
  getFile,
  downloadFile,
  escapeHtml,
};