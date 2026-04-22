require("dotenv").config();
const express = require("express");
const telegramRouter = require("./src/routes/telegram");
const wealthRouter = require("./src/routes/wealth");

const app = express();
app.use(express.json({ limit: "20mb" }));

app.use("/telegram", telegramRouter);
app.use("/wealth", wealthRouter);

app.get("/", (_, res) => res.send("Ibérico Inventory Bot OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on", PORT));
