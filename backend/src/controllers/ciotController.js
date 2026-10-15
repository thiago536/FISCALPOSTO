const { v4: uuid } = require("uuid");
const { all, get, insert, update } = require("../db");
const { gerarNumeroCiot, onlyDigits, FORMAS_PAGTO } = require("../utils/fiscal");
const { audit } = require("../services/audit");
const antt = require("../services/antt");
const P = require("../services/anttPayload");

// Validacao e rejeicao da ANTT -> 400 com mensagem; falha de rede/certificado -> 502.
function erroAntt(res, e) {
  if (e instanceof P.AnttValidationError) return res.status(400).json({ error: e.message });
  if (e instanceof antt.AnttError) {
    const rejeicao = e.codigo || (e.status && e.status < 500);
    return res.status(rejeicao ? 400 : 502).json({ error: e.message, codigo: e.codigo, protocolo: e.protocolo });
  }
  return res.status(500).json({ error: "Erro interno ao falar com a ANTT" });
}

const achar = (req) => get("ciot", (c) => c.id === req.params.id && c.empresa_id === req.user.empresa_id);
const cnpjEmpresa = (req) => onlyDigits(get("empresas", (e) => e.id === req.user.empresa_id)?.cnpj || "");

// Mapeia o corpo da requisicao (campos legados + campos PEF) para o formato do builder.
function dadosAntt(f, valor) {
  const placa = String(f.placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return {
    tipo_operacao: f.tipo_operacao ?? 1,
    contratado_doc: f.contratado_doc || f.motorista_cpf,
    contratado_rntrc: f.contratado_rntrc || f.motorista_rntrc,
    contratante_doc: f.contratante_doc,
    contratante_rntrc: f.contratante_rntrc,
    destinatario_doc: f.destinatario_doc,
    valor_frete: valor,
    contingencia: f.contingencia,
    justificativa_contingencia: f.justificativa_contingencia,
    data_inicio_viagem: f.data_inicio_viagem,
    data_fim_viagem: f.data_fim_viagem,
    veiculos: Array.isArray(f.veiculos) && f.veiculos.length ? f.veiculos : [{ placa, rntrc: f.rntrc_veiculo, eixos: f.eixos }],
    origem_destino: f.origem_destino,
    carga: f.carga,
    indicadores: f.indicadores,
    pagamento: {
      forma_pagto: f.forma_pagto,
      tipo_pagamento: f.tipo_pagamento,
      chave_pix: f.chave_pix,
      identificador_pix: f.identificador_pix,
      banco: f.banco,
      agencia: f.agencia,
      conta: f.conta,
      creditado_doc: f.creditado_doc,
      ind_pagamento: f.ind_pagamento,
      numero_parcela: f.numero_parcela,
      data_vencimento: f.data_vencimento,
      valor_parcela: f.valor_parcela,
      codigo_pagamento: f.codigo_pagamento,
    },
  };
}

exports.listar = (req, res) => {
  const { placa, status } = req.query;
  let rows = all("ciot", (c) => c.empresa_id === req.user.empresa_id);
  if (placa) rows = rows.filter((c) => (c.placa || "").includes(String(placa).toUpperCase()));
  if (status) rows = rows.filter((c) => c.status === status);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.json({ data: rows.slice(0, 200), total: rows.length, formas: FORMAS_PAGTO });
};

exports.detalhe = (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  return res.json(row);
};

exports.emitir = async (req, res) => {
  const f = req.body || {};
  if (!f.contratante_nome || !f.contratante_doc || !f.motorista_nome || !f.motorista_cpf || !f.placa) {
    return res.status(400).json({ error: "Contratante, motorista e placa são obrigatórios" });
  }
  const valor = Number(f.valor_contrato);
  if (!(valor > 0)) return res.status(400).json({ error: "Valor do contrato inválido" });
  const adiantamento = Number(f.valor_adiantamento ?? 0);
  if (!Number.isFinite(adiantamento) || adiantamento < 0) {
    return res.status(400).json({ error: "Valor de adiantamento inválido" });
  }
  if (adiantamento > valor) {
    return res.status(400).json({ error: "Adiantamento não pode exceder o valor do contrato" });
  }
  const id = uuid();
  const row = {
    id,
    empresa_id: req.user.empresa_id,
    administradora: f.administradora || "INTERNA",
    status: "emitido",
    contratante_nome: f.contratante_nome,
    contratante_doc: onlyDigits(f.contratante_doc),
    motorista_nome: f.motorista_nome,
    motorista_cpf: onlyDigits(f.motorista_cpf),
    placa: String(f.placa).toUpperCase().replace(/[^A-Z0-9]/g, ""),
    valor_contrato: valor,
    valor_adiantamento: adiantamento,
    forma_pagto: f.forma_pagto || "PIX",
    chave_pix: f.chave_pix,
    banco: f.banco,
    agencia: f.agencia,
    conta: f.conta,
    mdfe_id: null,
    usuario_id: req.user.id,
    created_at: new Date().toISOString(),
  };

  if (!antt.modoAntt()) {
    row.numero = gerarNumeroCiot();
    insert("ciot", row);
    audit(req, "emitir", "ciot", id, row.numero);
    return res.status(201).json({ id, numero: row.numero, status: "emitido" });
  }

  let payload;
  try {
    // Sem certificado nada vai à ANTT: recusa antes de reservar ID e gravar "pendente".
    antt.verificarCertificado();
    payload = P.montarDeclaracao(dadosAntt(f, valor), antt.gerarIdOperacao(req.user.empresa_id));
  } catch (e) {
    return erroAntt(res, e);
  }
  // Grava ANTES de falar com a ANTT: se a resposta se perder, o id_operacao reservado fica salvo
  // (status pendente) e a consulta o recupera, sem declarar um novo ID (CIOT duplicado).
  const idOperacao = payload.IdOperacaoTransporte;
  Object.assign(row, {
    status: "pendente",
    administradora: "ANTT",
    provider: "antt",
    ambiente: antt.ambiente(),
    id_operacao: String(idOperacao),
    tipo_operacao: payload.TipoOperacao,
    ano_declaracao: new Date().getFullYear(),
  });
  insert("ciot", row);
  const pend = (msg) =>
    res.status(502).json({
      error: `${msg} CIOT ${id} ficou pendente; use a consulta (GET /api/ciot/${id}/consulta) antes de emitir novamente.`,
      id,
      status: "pendente",
    });

  let r;
  try {
    r = await antt.declarar(payload);
  } catch (e) {
    const rejeitado = e instanceof antt.AnttError && (e.codigo || (e.status >= 400 && e.status < 500));
    if (rejeitado) {
      update("ciot", (c) => c.id === id, { status: "rejeitado", mensagem_antt: e.message });
      return erroAntt(res, e);
    }
    return pend("Sem confirmação da ANTT.");
  }

  let idRet = String(r.CodigoIdentificacaoOperacao || r.IdOperacaoTransporte || idOperacao);
  let dv = r.CodigoVerificador != null ? String(r.CodigoVerificador).padStart(4, "0") : "";
  if (!dv) {
    // Sem DV o numero teria 12 chars e cancelar/encerrar falhariam: busca o CIOT completo.
    try {
      const c = await antt.consultarCiotGerado(P.montarConsultaCiot(idOperacao, row.ano_declaracao));
      const n = String(c.CodigoIdentificacaoOperacao || "");
      if (n.length === 16) dv = n.slice(12);
    } catch {
      /* mantem pendente */
    }
  }
  if (!dv) {
    update("ciot", (c) => c.id === id, { protocolo: r.Protocolo, mensagem_antt: r.Mensagem });
    return pend("ANTT não retornou o código verificador.");
  }
  const base = idRet.slice(0, 12);
  const patch = {
    status: "emitido",
    numero: base + dv,
    id_operacao: base,
    codigo_verificador: dv,
    protocolo: r.Protocolo,
    mensagem_antt: r.Mensagem,
    aviso_transportador: r.AvisoTransportador,
  };
  update("ciot", (c) => c.id === id, patch);
  audit(req, "emitir", "ciot", id, patch.numero);
  return res.status(201).json({
    id,
    numero: patch.numero,
    status: "emitido",
    protocolo: patch.protocolo,
    codigo_verificador: dv,
    mensagem: patch.mensagem_antt,
    aviso_transportador: patch.aviso_transportador,
  });
};

exports.cancelar = async (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  if (row.status !== "emitido") return res.status(400).json({ error: `CIOT já está ${row.status}` });
  if (row.mdfe_id) {
    const mdfe = get("mdfe", (m) => m.id === row.mdfe_id);
    if (mdfe && mdfe.status === "autorizada") {
      return res.status(400).json({ error: "CIOT vinculado a MDF-e autorizado. Encerre ou cancele o manifesto primeiro." });
    }
  }
  const patch = { status: "cancelado", cancelado_em: new Date().toISOString() };
  if (row.provider === "antt") {
    try {
      const r = await antt.cancelar(P.montarCancelamento(row.numero, (req.body || {}).motivo));
      patch.protocolo_cancelamento = r.Protocolo;
    } catch (e) {
      return erroAntt(res, e);
    }
  }
  update("ciot", (c) => c.id === row.id, patch);
  audit(req, "cancelar", "ciot", row.id);
  return res.json({ ok: true, protocolo: patch.protocolo_cancelamento });
};

exports.encerrar = async (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  if (row.provider !== "antt") return res.status(400).json({ error: "Encerramento disponível apenas para CIOT emitido na ANTT" });
  if (row.status !== "emitido") return res.status(400).json({ error: `CIOT já está ${row.status}` });
  try {
    const r = await antt.encerrar(P.montarEncerramento(row.numero, row.tipo_operacao, req.body || {}));
    update("ciot", (c) => c.id === row.id, {
      status: "encerrado",
      encerrado_em: new Date().toISOString(),
      protocolo_encerramento: r.Protocolo,
    });
    audit(req, "encerrar", "ciot", row.id);
    return res.json({ ok: true, protocolo: r.Protocolo, mensagem: r.Mensagem });
  } catch (e) {
    return erroAntt(res, e);
  }
};

// Consulta CIOT+DV gerado na ANTT (util se a resposta da declaracao se perdeu).
exports.consultarGerado = async (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  if (row.provider !== "antt") return res.status(400).json({ error: "CIOT não foi emitido na ANTT" });
  try {
    const r = await antt.consultarCiotGerado(P.montarConsultaCiot(row.id_operacao, row.ano_declaracao));
    const numero = String(r.CodigoIdentificacaoOperacao || "");
    let status = row.status;
    if (row.status === "pendente" && numero.length === 16) {
      status = "emitido";
      update("ciot", (c) => c.id === row.id, {
        status,
        numero,
        id_operacao: numero.slice(0, 12),
        codigo_verificador: numero.slice(12),
        mensagem_antt: r.Mensagem,
      });
      audit(req, "emitir", "ciot", row.id, numero);
    }
    return res.json({ numero: r.CodigoIdentificacaoOperacao, mensagem: r.Mensagem, status });
  } catch (e) {
    return erroAntt(res, e);
  }
};

exports.situacaoTransportador = async (req, res) => {
  if (!antt.modoAntt()) return res.status(400).json({ error: "Consulta disponível apenas com CIOT_PROVIDER=antt" });
  const q = req.query;
  try {
    const r = await antt.consultarSituacaoTransportador(
      P.montarSituacao({ interessado: q.interessado || cnpjEmpresa(req), transportador: q.doc, rntrc: q.rntrc })
    );
    return res.json(r);
  } catch (e) {
    return erroAntt(res, e);
  }
};

exports.frota = async (req, res) => {
  if (!antt.modoAntt()) return res.status(400).json({ error: "Consulta disponível apenas com CIOT_PROVIDER=antt" });
  const b = req.body || {};
  try {
    const r = await antt.consultarFrotaTransportador(
      P.montarFrota({ interessado: b.interessado || cnpjEmpresa(req), transportador: b.doc, rntrc: b.rntrc, placas: b.placas })
    );
    return res.json(r);
  } catch (e) {
    return erroAntt(res, e);
  }
};
