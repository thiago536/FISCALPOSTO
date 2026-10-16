const { get, insert } = require("../db");
const emissor = require("../services/emissor");
const { ValidacaoError } = require("../utils/documentos");

// Resposta padrão de emissão, igual para NF-e, CT-e e MDF-e. `simulado` deixa
// explícito quando o "autorizada" veio do emissor local, sem valor fiscal.
function resumo(row) {
  return {
    id: row.id,
    chave: row.chave,
    status: row.status,
    protocolo: row.protocolo,
    motivo: row.motivo,
    cstat: row.cstat,
    numero: row.numero,
    serie: row.serie,
    simulado: !!row.simulado,
    proxima_acao: proximaAcao(row),
  };
}

function proximaAcao(row) {
  switch (row.status) {
    case "processando": return "aguardar resposta da SEFAZ ou consultar (POST /:id/sincronizar); não emitir de novo";
    case "rejeitada": return "corrigir os dados indicados no motivo e emitir um novo documento";
    case "denegada": return "documento denegado pela SEFAZ; procurar o contador";
    default: return null;
  }
}

const ctxDe = (req) => ({ correlacao: req.correlacao, usuario_id: req.user && req.user.id });

// Idempotency-Key: o mesmo pedido repetido (clique duplo, reenvio após
// timeout do navegador) devolve o documento já criado em vez de emitir outro.
function chaveIdempotencia(req) {
  const k = req.get("Idempotency-Key");
  if (!k) return null;
  if (!/^[A-Za-z0-9-]{8,100}$/.test(k)) throw new ValidacaoError("Idempotency-Key inválida (8 a 100 letras, números ou hífen)", "Idempotency-Key");
  return k;
}

function documentoJaCriado(req, tipo, chave) {
  if (!chave) return null;
  const reg = get("idempotencia", (r) => r.empresa_id === req.user.empresa_id && r.tipo === tipo && r.chave === chave);
  return reg ? get(tipo, (d) => d.id === reg.recurso_id && d.empresa_id === req.user.empresa_id) : null;
}

function registrarIdempotencia(req, tipo, chave, recursoId) {
  if (!chave) return;
  insert("idempotencia", { empresa_id: req.user.empresa_id, tipo, chave, recurso_id: recursoId, created_at: new Date().toISOString() });
}

// POST /:id/sincronizar — consulta a Focus agora em vez de esperar o ciclo.
function sincronizar(tipo, nome) {
  return async (req, res) => {
    const row = get(tipo, (x) => x.id === req.params.id && x.empresa_id === req.user.empresa_id);
    if (!row) return res.status(404).json({ error: `${nome} não encontrado(a)` });
    if (row.simulado || emissor.modo() !== "focus") return res.json(resumo(row));
    return res.json(resumo(await emissor.sincronizar(tipo, row.id, ctxDe(req))));
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
      return res.status(502).json({ error: `Falha ao baixar PDF: ${err.message}`, correlacao: req.correlacao });
    }
  };
}

// Erro de provedor em cancelamento/encerramento: 4xx da regra de negócio vira
// 400; falha de comunicação vira 502 com a orientação de consultar antes de
// repetir (a operação pode ter sido aceita sem a resposta chegar).
function erroProvedor(req, res, err) {
  const transitorio = !err.status || err.status >= 500 || err.status === 408 || err.status === 429;
  if (!transitorio) return res.status(400).json({ error: err.message, correlacao: req.correlacao });
  return res.status(502).json({
    error: `Sem confirmação do provedor: ${err.message}`,
    proxima_acao: "consultar o documento (POST /:id/sincronizar) antes de repetir a operação",
    correlacao: req.correlacao,
  });
}

module.exports = { resumo, proximaAcao, ctxDe, chaveIdempotencia, documentoJaCriado, registrarIdempotencia, sincronizar, pdf, erroProvedor };
