function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[’']/g, "") // quita apostrofes
    .replace(/\s+/g, " ");
}

module.exports = { norm };