function parseLinesFromText(text) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*=\s*([0-9]+(?:\.[0-9]+)?)$/);
    if (!m) continue;
    items.push({ rawName: m[1].trim(), qty: Number(m[2]) });
  }
  return items;
}

module.exports = { parseLinesFromText };