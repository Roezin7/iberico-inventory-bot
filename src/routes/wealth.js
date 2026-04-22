const express = require("express");
const { getHistory } = require("../handlers/wealth/getHistory");
const { getSummary } = require("../handlers/wealth/getSummary");

const router = express.Router();

router.get("/history", getHistory);
router.get("/summary", getSummary);

module.exports = router;
