const { handleCommand, handleNonCommand } = require("./commandRouter");

async function handleUpdate(req, res) {
  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;

    if (msg.text && msg.text.startsWith("/")) {
      await handleCommand(chatId, msg.text);
    } else {
      await handleNonCommand(chatId, msg);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("telegram webhook error:", e);
    res.sendStatus(200);
  }
}

module.exports = { handleUpdate };