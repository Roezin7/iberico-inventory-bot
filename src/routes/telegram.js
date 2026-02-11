const express = require("express");
const { handleUpdate } = require("../handlers/telegramWebhook");

const router = express.Router();
router.post("/webhook", handleUpdate);
module.exports = router;