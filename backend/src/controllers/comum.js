const { get } = require("../db");
const emissor = require("../services/emissor");

// Resposta padrão de emissão, igual para NF-e, CT-e e MDF-e.
function resumo(row) {
  return {
    id: row.id,
    chave: row.chave,
    status: row.status,
    protocolo: row.protocolo,
    motivo: row.motivo,
    numero: row.numero,
    serie: row.serie,
  };
}

// POST /:id/sincronizar — consulta a Focus agora em vez de esperar o ciclo.
function sincronizar(tipo, nome) {
  return async (req, res) => {
    const row = get(tipo, (x) => x.id === req.params.id && x.empresa_id === req.user.empresa_id);
    if (!row) return res.status(404).json({ error: `${nome} não encontrado(a)` });
    if (emissor.modo() !== "focus") return res.json(resumo(row));
    return res.json(resumo(await emissor.sincronizar(tipo, row.id)));
  };
}

// GET /:id/pdf — DANFE / DACTE / DAMDFE gerado pela Focus.
function pdf(tipo, nome) {
  return async (req, res) => {
    const row = get(tipo, (x) => x.id === req.params.id && x.empresa_id === req.user.empresa_id);
    if (!row) return res.status(404).json({ error: `${nome} não encontrado(a)` });
    if (!row.caminho_pdf) return res.status(404).json({ error: "PDF disponível apenas para documento autorizado na emissão real" });
    try {
      const buf = await emissor.pdf(row);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${row.chave || tipo}.pdf"`);
      return res.send(buf);
    } catch (err) {
      return res.status(502).json({ error: `Falha ao baixar PDF: ${err.message}` });
    }
  };
}

module.exports = { resumo, sincronizar, pdf };
