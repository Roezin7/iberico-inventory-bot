const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN;
const api = `https://api.telegram.org/bot${token}`;

async function sendMessage(chatId, text, opts = {}) {
  return axios.post(`${api}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    ...opts,
  });
}

async function getFile(fileId) {
  const { data } = await axios.get(`${api}/getFile`, { params: { file_id: fileId } });
  if (!data.ok) throw new Error("getFile_failed");
  return data.result; // {file_path,...}
}

async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

module.exports = { sendMessage, getFile, downloadFile };