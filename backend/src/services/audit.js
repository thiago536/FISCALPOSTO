const { v4: uuid } = require("uuid");
const { insert } = require("../db");

function audit(req, acao, entidade, entidadeId, detalhe = "") {
  insert("audit_logs", {
    id: uuid(),
    empresa_id: req.user.empresa_id,
    usuario_id: req.user.id,
    acao,
    entidade,
    entidade_id: entidadeId || null,
    detalhe,
    created_at: new Date().toISOString(),
  });
}

module.exports = { audit };
