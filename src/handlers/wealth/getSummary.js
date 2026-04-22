const wealthService = require("../../services/wealthService");
const { clampInteger } = require("../../utils/dateUtils");

async function getSummary(req, res) {
  try {
    const weeks = clampInteger(req.query.weeks, { defaultValue: 4, min: 1, max: 104 });
    const summary = await wealthService.getWealthSummary({ weeks });

    if (summary?.error === "no_wealth_snapshots") {
      return res.status(404).json(summary);
    }

    return res.json(summary);
  } catch (error) {
    console.error("wealth summary handler error:", error);
    return res.status(500).json({ error: "wealth_summary_failed" });
  }
}

module.exports = { getSummary };
