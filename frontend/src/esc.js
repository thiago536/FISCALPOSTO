// Escape e formatação de valores vindos do servidor. Todo dado de servidor que
// vai para innerHTML passa por esc() (houve XSS; não reintroduza).
(function (g) {
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmt(val, type = "str") {
    if (val === null || val === undefined || val === "") return "—";
    if (type === "money") return esc("R$ " + Number(val).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
    if (type === "date") {
      const d = String(val).slice(0, 10);
      return esc(d.split("-").reverse().join("/"));
    }
    return esc(val);
  }

  const api = { esc, fmt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(g, api);
})(this);
