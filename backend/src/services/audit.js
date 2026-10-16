const { v4: uuid } = require("uuid");
const { insert } = require("../db");
const logger = require("../middleware/logger");

// Ação de usuário (cadastro, login administrativo...). Mantida para os
// chamadores antigos.
function audit(req, acao, entidade, entidadeId, detalhe = "") {
  insert("audit_logs", {
    id: uuid(),
    empresa_id: req.user.empresa_id,
    usuario_id: req.user.id,
    acao,
    entidade,
    entidade_id: entidadeId || null,
    detalhe,
    correlacao: req.correlacao || null,
    created_at: new Date().toISOString(),
  });
}

// Mensagens de provedor às vezes ecoam o que recebemos; corta o tamanho e
// qualquer coisa que pareça credencial antes de gravar.
function higienizar(msg) {
  if (msg == null) return null;
  return String(msg)
    .replace(/(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1 ***")
    .replace(/(senha|password|token|passphrase)\s*[:=]\s*\S+/gi, "$1=***")
    .slice(0, 500);
}

/**
 * Trilha de uma operação fiscal: quem, o quê, estado antes/depois, com qual
 * provedor/ambiente, o que o provedor respondeu e o que fazer em seguida.
 * Nunca recebe senha, token, certificado ou corpo de requisição.
 */
function auditFiscal({
  empresa_id,
  usuario_id = null,
  entidade,
  entidade_id,
  operacao,
  status_anterior = null,
  status_novo = null,
  ambiente = null,
  provedor = null,
  codigo = null,
  mensagem = null,
  correlacao = null,
  proxima_acao = null,
}) {
  const row = {
    id: uuid(),
    tipo: "fiscal",
    empresa_id,
    usuario_id,
    acao: operacao,
    entidade,
    entidade_id,
    status_anterior,
    status_novo,
    ambiente,
    provedor,
    codigo: codigo == null ? null : String(codigo).slice(0, 20),
    mensagem: higienizar(mensagem),
    correlacao,
    proxima_acao,
    created_at: new Date().toISOString(),
  };
  insert("audit_logs", row);
  logger.info("fiscal", {
    correlacao, entidade, entidade_id, operacao, de: status_anterior, para: status_novo, provedor, codigo: row.codigo,
  });
  return row;
}

module.exports = { audit, auditFiscal, higienizar };
