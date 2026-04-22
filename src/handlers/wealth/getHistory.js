const wealthService = require("../../services/wealthService");
const { clampInteger } = require("../../utils/dateUtils");

async function getHistory(req, res) {
  try {
    const weeks = clampInteger(req.query.weeks, { defaultValue: 12, min: 1, max: 104 });
    const history = await wealthService.getWealthHistory({ weeks, order: "asc" });
    return res.json(history);
  } catch (error) {
    console.error("wealth history handler error:", error);
    return res.status(500).json({ error: "wealth_history_failed" });
  }
}

module.exports = { getHistory };
