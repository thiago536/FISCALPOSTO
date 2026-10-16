const { v4: uuid } = require("uuid");
const { all, get, insert, update } = require("../db");
const { gerarNumeroCiot, onlyDigits, FORMAS_PAGTO } = require("../utils/fiscal");
const { ValidacaoError, normalizarDoc } = require("../utils/documentos");
const { auditFiscal } = require("../services/audit");
const antt = require("../services/antt");
const P = require("../services/anttPayload");

const AVISO_SIMULADO =
  "CIOT SIMULADO (CIOT_PROVIDER=local): número gerado localmente, sem registro na ANTT e sem validade legal.";
const AVISO_ID_EXPERIMENTAL =
  "IdOperacaoTransporte gerado por sequencial local EXPERIMENTAL; o DCS PEF (regras B4/B16) exige ID gerado pela DLL/executável da ANTT, com DV.";
// Status em que o mesmo IdOperacaoTransporte pode ser reenviado: a ANTT recusou,
// o acesso nem chegou a ela, ou a consulta confirmou que ele não foi registrado.
const ID_REUSAVEL = new Set(["rejeitado", "nao_enviado", "nao_registrado"]);
const STATUS_HTTP = { rejeicao: 400, indeterminado: 502, configuracao: 503 };
// DCS B17: 219 = "Código de identificação da operação já cadastrado". O ID existe
// na ANTT (talvez pela nossa tentativa anterior): nunca é rejeição definitiva.
const COD_ID_JA_CADASTRADO = "219";
// Consulta sem operação: 297 (visto na homologação em 15/10/2026: "O CIOT
// informado não existe na base de dados da ANTT") e 220 (DCS, regra B34).
const COD_NAO_ENCONTRADO = new Set(["297", "220"]);
// DCS: 222 = "Operação de Transporte já está cancelada"; 251 = "... já está encerrada".
const COD_JA_CANCELADO = "222";
const COD_JA_ENCERRADO = "251";
// Uma operação na ANTT por CIOT de cada vez (processo único: o banco tem lock).
const emOperacao = new Set();
function travar(res, id) {
  if (emOperacao.has(id)) {
    res.status(409).json({ error: "Já existe uma operação em andamento na ANTT para este CIOT. Aguarde e consulte." });
    return false;
  }
  emOperacao.add(id);
  return true;
}
// Pendente só vira "não registrado" depois que qualquer requisição antiga já
// expirou: evita concluir "não existe" enquanto a declaração ainda processa.
function margemPendenteMs() {
  const t = Number(process.env.ANTT_TIMEOUT_MS);
  return Math.max(60000, 2 * (Number.isFinite(t) && t > 0 ? t : 30000));
}

// Validacao/rejeicao -> 400; resposta indeterminada -> 502; configuracao local -> 503.
function erroAntt(res, e, extra = {}) {
  if (e instanceof P.AnttValidationError || e instanceof ValidacaoError) return res.status(400).json({ error: e.message, ...extra });
  if (e instanceof antt.AnttError) {
    return res.status(STATUS_HTTP[e.tipo] || 502).json({
      error: e.message,
      tipo: e.tipo,
      codigo: e.codigo,
      protocolo: e.protocolo,
      ...extra,
    });
  }
  return res.status(500).json({ error: "Erro interno ao falar com a ANTT", ...extra });
}

const achar = (req) => get("ciot", (c) => c.id === req.params.id && c.empresa_id === req.user.empresa_id);
const cnpjEmpresa = (req) => normalizarDoc(get("empresas", (e) => e.id === req.user.empresa_id)?.cnpj || "");
const ehAntt = (row) => row.provider === "antt";
// "pendente" nunca é autorizado: oficial só para CIOT da ANTT já emitido.
const apresentar = (row) => ({ ...row, oficial: ehAntt(row) && row.status === "emitido", simulado: !ehAntt(row) });

function trilha(req, row, operacao, de, para, { codigo, mensagem, proxima_acao } = {}) {
  auditFiscal({
    empresa_id: req.user.empresa_id,
    usuario_id: req.user.id,
    entidade: "ciot",
    entidade_id: row.id,
    operacao,
    status_anterior: de,
    status_novo: para,
    ambiente: ehAntt(row) ? row.ambiente : null,
    provedor: ehAntt(row) ? "antt" : "local",
    codigo,
    mensagem,
    correlacao: req.correlacao || null,
    proxima_acao,
  });
}

// Mapeia o corpo da requisicao (campos legados + campos PEF) para o formato do builder.
// Sem Instituição de Pagamento, a ETC declara só em nome próprio (B115): a
// contratada padrão é a própria empresa, nunca o motorista.
function dadosAntt(f, valor, empresaDoc) {
  return {
    tipo_operacao: f.tipo_operacao ?? 1,
    contratado_doc: f.contratado_doc || empresaDoc,
    contratado_rntrc: f.contratado_rntrc,
    contratante_doc: f.contratante_doc,
    contratante_rntrc: f.contratante_rntrc,
    destinatario_doc: f.destinatario_doc,
    valor_frete: valor,
    contingencia: f.contingencia,
    justificativa_contingencia: f.justificativa_contingencia,
    data_inicio_viagem: f.data_inicio_viagem,
    data_fim_viagem: f.data_fim_viagem,
    veiculos: Array.isArray(f.veiculos) && f.veiculos.length ? f.veiculos : [{ placa: f.placa, rntrc: f.rntrc_veiculo, eixos: f.eixos }],
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

// Origem oficial do IdOperacaoTransporte não é pública (B16: "informado pela
// administradora"). Padrão "manual": o usuário traz o ID; nunca chamamos geradores de terceiros.
function modoId() {
  const m = String(process.env.ANTT_ID_MODO || "manual").toLowerCase();
  if (m !== "manual" && m !== "sequencial_experimental") {
    throw new antt.AnttError("ANTT_ID_MODO inválido (use manual ou sequencial_experimental)", { tipo: "configuracao" });
  }
  return m;
}

exports.listar = (req, res) => {
  const { placa, status } = req.query;
  let rows = all("ciot", (c) => c.empresa_id === req.user.empresa_id);
  if (placa) rows = rows.filter((c) => (c.placa || "").includes(String(placa).toUpperCase()));
  if (status) rows = rows.filter((c) => c.status === status);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.json({ data: rows.slice(0, 200).map(apresentar), total: rows.length, formas: FORMAS_PAGTO });
};

exports.detalhe = (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  return res.json(apresentar(row));
};

// A trava do CIOT recém-gravado vale até a resposta da declaração: uma consulta
// simultânea recebe 409 em vez de competir pelo status.
exports.emitir = async (req, res) => {
  try {
    return await emitir(req, res);
  } finally {
    if (req.ciotTravado) emOperacao.delete(req.ciotTravado);
  }
};

async function emitir(req, res) {
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
  // Idempotency-Key: pedido repetido (clique duplo, reenvio após timeout do
  // navegador) devolve a operação já criada, sem nova declaração na ANTT.
  const idemp = typeof req.get === "function" ? req.get("Idempotency-Key") || null : null;
  if (idemp) {
    if (!/^[A-Za-z0-9-]{8,100}$/.test(idemp)) return res.status(400).json({ error: "Idempotency-Key inválida (8 a 100 letras, números ou hífen)" });
    const reg = get("idempotencia", (r) => r.empresa_id === req.user.empresa_id && r.tipo === "ciot" && r.chave === idemp);
    const anterior = reg && get("ciot", (c) => c.id === reg.recurso_id && c.empresa_id === req.user.empresa_id);
    if (anterior) {
      return res.status(200).json({ ...apresentar(anterior), reaproveitado: true, proxima_acao: anterior.status === "pendente" ? "consultar" : undefined });
    }
  }
  const registrarIdemp = () => {
    if (idemp) insert("idempotencia", { empresa_id: req.user.empresa_id, tipo: "ciot", chave: idemp, recurso_id: row.id, created_at: new Date().toISOString() });
  };
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
    Object.assign(row, { numero: gerarNumeroCiot(), provider: "local", simulado: true });
    insert("ciot", row);
    registrarIdemp();
    trilha(req, row, "emitir", null, "emitido", { mensagem: "CIOT simulado (local)" });
    return res.status(201).json({ id, numero: row.numero, status: "emitido", simulado: true, oficial: false, aviso: AVISO_SIMULADO });
  }

  // Tudo que pode falhar sem rede é conferido ANTES de reservar ID ou gravar.
  let payload;
  let modo;
  let cert;
  const empCnpj = cnpjEmpresa(req);
  try {
    modo = modoId();
    cert = antt.verificarCertificado();
    if (cert && cert.cnpj && empCnpj && normalizarDoc(cert.cnpj) !== empCnpj) {
      return res.status(400).json({
        error: `Certificado A1 é do CNPJ ${cert.cnpj}, diferente do CNPJ da empresa (${empCnpj}). Nada foi enviado à ANTT.`,
      });
    }
    const opts = { emissorDoc: (cert && cert.cnpj && normalizarDoc(cert.cnpj)) || empCnpj || undefined };
    if (modo === "manual") {
      const idm = String(f.id_operacao ?? "").trim();
      if (!/^[0-9A-Z]{12}$/.test(idm)) {
        return res.status(400).json({
          error: "id_operacao obrigatório: 12 caracteres [0-9A-Z] gerados pela DLL/executável oficial da ANTT (DCS PEF, regra B4)",
        });
      }
      payload = P.montarDeclaracao(dadosAntt(f, valor, empCnpj), idm, new Date(), opts);
    } else {
      // ID provisório só para validar; o sequencial é reservado depois.
      payload = P.montarDeclaracao(dadosAntt(f, valor, empCnpj), "000000000000", new Date(), opts);
    }
  } catch (e) {
    return erroAntt(res, e);
  }
  const ano = Number(payload.DataDeclaracao.slice(0, 4));
  let idOperacao;
  if (modo === "manual") {
    idOperacao = payload.IdOperacaoTransporte;
    // B17: ID único por ano por declarante. Recusa localmente antes da ANTT.
    const repetido = get(
      "ciot",
      (c) =>
        c.empresa_id === req.user.empresa_id &&
        ehAntt(c) &&
        c.ano_declaracao === ano &&
        c.id_operacao === idOperacao &&
        !ID_REUSAVEL.has(c.status)
    );
    if (repetido) {
      return res.status(400).json({
        error: `IdOperacaoTransporte ${idOperacao} já usado em ${ano} (CIOT ${repetido.id}, status ${repetido.status})`,
      });
    }
  } else {
    idOperacao = antt.gerarIdOperacao(req.user.empresa_id, ano);
    payload.IdOperacaoTransporte = idOperacao;
  }

  // Grava ANTES de falar com a ANTT: se a resposta se perder, o id_operacao fica salvo
  // (status pendente) e a consulta o recupera, sem declarar um novo ID (CIOT duplicado).
  const experimental = modo !== "manual";
  Object.assign(row, {
    status: "pendente",
    administradora: "ANTT",
    provider: "antt",
    simulado: false,
    ambiente: antt.ambiente(),
    id_operacao: idOperacao,
    id_modo: modo,
    id_experimental: experimental,
    tipo_operacao: payload.TipoOperacao,
    ano_declaracao: ano,
    // Placas declaradas (o vínculo com MDF-e confere a placa contra esta lista).
    veiculos: payload.Veiculos.map((v) => ({ placa: v.Placa, eixos: v.NumeroEixos })),
    contratado_doc: payload.CpfCnpjContratado,
    data_inicio_viagem: payload.DataInicioViagem || null,
    data_fim_viagem: payload.DataFimViagem,
    declarado_em: new Date().toISOString(),
  });
  insert("ciot", row);
  registrarIdemp();
  emOperacao.add(id);
  req.ciotTravado = id;
  trilha(req, row, "emitir", null, "pendente", { mensagem: "Declaração enviada à ANTT", proxima_acao: "aguardar_resposta" });
  // Só altera o registro se ele ainda estiver pendente (nunca sobrescreve estado posterior).
  const aindaPendente = (c) => c.id === id && c.status === "pendente";
  const extras = experimental ? { id_experimental: true, aviso: AVISO_ID_EXPERIMENTAL } : {};
  const pend = (msg, codigo, extraPend = {}) => {
    const mensagem = `${msg} CIOT ${id} ficou pendente; use a consulta (GET /api/ciot/${id}/consulta) antes de emitir novamente.`;
    update("ciot", aindaPendente, { mensagem_antt: msg, codigo_antt: codigo ?? null, ...extraPend });
    trilha(req, row, "emitir", "pendente", "pendente", { codigo, mensagem: msg, proxima_acao: "consultar" });
    return res.status(502).json({ error: mensagem, id, status: "pendente", oficial: false, proxima_acao: "consultar", ...extras });
  };

  let r;
  try {
    r = await antt.declarar(payload);
  } catch (e) {
    if (!(e instanceof antt.AnttError) || e.tipo === "indeterminado") return pend(`Sem confirmação da ANTT (${e.message}).`, e.codigo);
    if (e.tipo === "rejeicao" && e.codigo === COD_ID_JA_CADASTRADO) {
      // O ID já existe na ANTT: pode ser desta mesma operação. Só a consulta decide.
      return pend(`ANTT informou que o IdOperacaoTransporte ${idOperacao} já está cadastrado (${e.message}).`, e.codigo, { id_ja_cadastrado: true });
    }
    const novo = e.tipo === "rejeicao" ? "rejeitado" : "nao_enviado";
    update("ciot", aindaPendente, { status: novo, mensagem_antt: e.message, codigo_antt: e.codigo ?? null, protocolo: e.protocolo });
    const proxima = e.tipo === "rejeicao" ? "corrigir_e_reenviar" : "corrigir_configuracao";
    trilha(req, row, "emitir", "pendente", novo, { codigo: e.codigo, mensagem: e.message, proxima_acao: proxima });
    return erroAntt(res, e, { id, status: novo, oficial: false, proxima_acao: proxima, ...extras });
  }

  const idRet = String(r.CodigoIdentificacaoOperacao ?? r.IdOperacaoTransporte ?? "").trim();
  // DV aceito só como veio (4 caracteres). Outra forma (ex.: número sem zeros à
  // esquerda) não é completada aqui: o CIOT completo vem da consulta oficial.
  let dv = typeof r.CodigoVerificador === "string" && /^[0-9A-Z]{4}$/.test(r.CodigoVerificador.trim()) ? r.CodigoVerificador.trim() : "";
  if (idRet && idRet.slice(0, 12) !== idOperacao) {
    return pend(`ANTT devolveu código ${idRet} diferente do IdOperacaoTransporte enviado (${idOperacao}).`, r.Codigo);
  }
  if (!dv && idRet.length === 16) dv = idRet.slice(12);
  if (!idRet || !dv) {
    // Sem código+DV o numero ficaria incompleto e cancelar/encerrar falhariam: busca o CIOT completo.
    dv = "";
    try {
      const c = await antt.consultarCiotGerado(P.montarConsultaCiot(idOperacao, ano));
      const n = String(c.CodigoIdentificacaoOperacao || "");
      if (n.length === 16 && n.startsWith(idOperacao)) dv = n.slice(12);
    } catch {
      /* mantem pendente */
    }
  }
  if (!dv) {
    update("ciot", aindaPendente, { protocolo: r.Protocolo });
    return pend("ANTT não retornou o CIOT completo (código + verificador).", r.Codigo);
  }
  const patch = {
    status: "emitido",
    numero: idOperacao + dv,
    codigo_verificador: dv,
    protocolo: r.Protocolo,
    codigo_antt: r.Codigo != null ? String(Array.isArray(r.Codigo) ? r.Codigo[0] : r.Codigo) : null,
    mensagem_antt: antt.textoMensagem(r.Mensagem),
    aviso_transportador: r.AvisoTransportador,
    emitido_em: new Date().toISOString(),
  };
  update("ciot", aindaPendente, patch);
  trilha(req, row, "emitir", "pendente", "emitido", { codigo: patch.codigo_antt, mensagem: patch.mensagem_antt });
  return res.status(201).json({
    id,
    numero: patch.numero,
    status: "emitido",
    oficial: true,
    simulado: false,
    ambiente: row.ambiente,
    protocolo: patch.protocolo,
    codigo_verificador: dv,
    mensagem: patch.mensagem_antt,
    aviso_transportador: patch.aviso_transportador,
    ...extras,
  });
}

// Cancelamento/encerramento na ANTT: status só muda com sucesso confirmado.
async function operarAntt(req, res, row, { tipo, chamada, novoStatus, campoData, campoProtocolo, proximaRetry }) {
  try {
    const r = await chamada();
    const patch = {
      status: novoStatus,
      [campoData]: new Date().toISOString(),
      [campoProtocolo]: r.Protocolo,
      operacao_pendente: null,
    };
    update("ciot", (c) => c.id === row.id, patch);
    const msg = antt.textoMensagem(r.Mensagem);
    trilha(req, row, tipo, row.status, novoStatus, { codigo: Array.isArray(r.Codigo) ? r.Codigo[0] : r.Codigo, mensagem: msg });
    return res.json({ ok: true, status: novoStatus, protocolo: r.Protocolo, mensagem: msg });
  } catch (e) {
    if (e instanceof antt.AnttError && e.tipo === "indeterminado") {
      update("ciot", (c) => c.id === row.id, { operacao_pendente: { tipo, em: new Date().toISOString(), mensagem: e.message } });
      trilha(req, row, tipo, row.status, row.status, { codigo: e.codigo, mensagem: e.message, proxima_acao: proximaRetry });
      return erroAntt(res, e, {
        error: `Sem confirmação da ANTT para ${tipo} (${e.message}). Status mantido (${row.status}); verifique na ANTT e repita.`,
        status: row.status,
        operacao_pendente: tipo,
        proxima_acao: proximaRetry,
      });
    }
    // A ANTT afirma o estado atual da operação: reflete-o (é dela a palavra final).
    const jaFinal =
      e instanceof antt.AnttError && e.tipo === "rejeicao"
        ? e.codigo === COD_JA_CANCELADO
          ? { status: "cancelado", campo: "cancelado_em" }
          : e.codigo === COD_JA_ENCERRADO
            ? { status: "encerrado", campo: "encerrado_em" }
            : null
        : null;
    if (jaFinal) {
      update("ciot", (c) => c.id === row.id, {
        status: jaFinal.status,
        [jaFinal.campo]: row[jaFinal.campo] || new Date().toISOString(),
        operacao_pendente: null,
        mensagem_antt: e.message,
        codigo_antt: e.codigo,
      });
      trilha(req, row, tipo, row.status, jaFinal.status, { codigo: e.codigo, mensagem: `Estado confirmado pela ANTT: ${e.message}` });
      return res.status(409).json({
        error: `ANTT informa que a operação já está ${jaFinal.status === "cancelado" ? "cancelada" : "encerrada"} (${e.message}). Status atualizado.`,
        codigo: e.codigo,
        status: jaFinal.status,
      });
    }
    if (e instanceof antt.AnttError) {
      trilha(req, row, tipo, row.status, row.status, { codigo: e.codigo, mensagem: e.message, proxima_acao: "verificar_mensagem_antt" });
    }
    return erroAntt(res, e, { status: row.status });
  }
}

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
  if (ehAntt(row)) {
    let payload;
    try {
      payload = P.montarCancelamento(row.numero, (req.body || {}).motivo);
    } catch (e) {
      return erroAntt(res, e);
    }
    if (!travar(res, row.id)) return undefined;
    try {
      return await operarAntt(req, res, row, {
        tipo: "cancelamento",
        chamada: () => antt.cancelar(payload),
        novoStatus: "cancelado",
        campoData: "cancelado_em",
        campoProtocolo: "protocolo_cancelamento",
        proximaRetry: "repetir_cancelamento",
      });
    } finally {
      emOperacao.delete(row.id);
    }
  }
  update("ciot", (c) => c.id === row.id, { status: "cancelado", cancelado_em: new Date().toISOString() });
  trilha(req, row, "cancelamento", row.status, "cancelado", { mensagem: "CIOT simulado (local)" });
  return res.json({ ok: true, simulado: true });
};

exports.encerrar = async (req, res) => {
  const row = achar(req);
  if (!row) return res.status(404).json({ error: "CIOT não encontrado" });
  if (!ehAntt(row)) return res.status(400).json({ error: "Encerramento disponível apenas para CIOT emitido na ANTT" });
  if (row.status !== "emitido") return res.status(400).json({ error: `CIOT já está ${row.status}` });
  let payload;
  try {
    payload = P.montarEncerramento(row.numero, row.tipo_operacao, req.body || {});
  } catch (e) {
    return erroAntt(res, e);
  }
  if (!travar(res, row.id)) return undefined;
  try {
    return await operarAntt(req, res, row, {
      tipo: "encerramento",
      chamada: () => antt.encerrar(payload),
      novoStatus: "encerrado",
      campoData: "encerrado_em",
      campoProtocolo: "protocolo_encerramento",
      proximaRetry: "repetir_encerramento",
    });
  } finally {
    emOperacao.delete(row.id);
  }
};

// Consulta CIOT+DV gerado na ANTT (util se a resposta da declaracao se perdeu).
exports.consultarGerado = async (req, res) => {
  const row0 = achar(req);
  if (!row0) return res.status(404).json({ error: "CIOT não encontrado" });
  if (!ehAntt(row0)) return res.status(400).json({ error: "CIOT não foi emitido na ANTT" });
  if (!travar(res, row0.id)) return undefined;
  try {
    return await consultar(req, res, row0);
  } finally {
    emOperacao.delete(row0.id);
  }
};

async function consultar(req, res, row) {
  let r;
  try {
    r = await antt.consultarCiotGerado(P.montarConsultaCiot(row.id_operacao, row.ano_declaracao));
  } catch (e) {
    if (e instanceof antt.AnttError && e.tipo === "rejeicao" && row.status === "pendente" && COD_NAO_ENCONTRADO.has(e.codigo)) {
      // A ANTT afirma que o ID não existe. Só vale depois que qualquer envio antigo
      // já expirou; aí o mesmo ID pode ser reenviado (B17 barra duplicidade).
      const desde = Date.parse(row.declarado_em || row.created_at);
      const espera = margemPendenteMs() - (Date.now() - desde);
      if (espera > 0) {
        trilha(req, row, "consultar", "pendente", "pendente", { codigo: e.codigo, mensagem: e.message, proxima_acao: "consultar_novamente" });
        return res.status(409).json({
          error: `ANTT ainda não encontrou a operação (${e.message}). Envio recente: consulte de novo em ${Math.ceil(espera / 1000)} s antes de concluir.`,
          codigo: e.codigo,
          status: "pendente",
          oficial: false,
          proxima_acao: "consultar_novamente",
        });
      }
      update("ciot", (c) => c.id === row.id, { status: "nao_registrado", mensagem_antt: e.message, codigo_antt: e.codigo });
      trilha(req, row, "consultar", "pendente", "nao_registrado", { codigo: e.codigo, mensagem: e.message, proxima_acao: "reenviar_mesmo_id" });
      return res.status(404).json({
        error: `ANTT confirma que a operação ${row.id_operacao} não foi registrada (${e.message}). Reenvie a declaração com o MESMO id_operacao.`,
        codigo: e.codigo,
        status: "nao_registrado",
        oficial: false,
        id_operacao: row.id_operacao,
        proxima_acao: "reenviar_mesmo_id",
      });
    }
    if (e instanceof antt.AnttError && e.tipo === "rejeicao") {
      // Não interpreta o código: devolve o que a ANTT disse e mantém o status.
      trilha(req, row, "consultar", row.status, row.status, { codigo: e.codigo, mensagem: e.message, proxima_acao: "verificar_mensagem_antt" });
      return erroAntt(res, e, { status: row.status, oficial: apresentar(row).oficial, proxima_acao: "verificar_mensagem_antt" });
    }
    return erroAntt(res, e, { status: row.status, oficial: apresentar(row).oficial, proxima_acao: "consultar_novamente" });
  }
  const numero = String(r.CodigoIdentificacaoOperacao || "");
  const mensagem = antt.textoMensagem(r.Mensagem);
  if (row.status === "pendente") {
    const confere = numero.length === 16 && /^[0-9A-Z]{16}$/.test(numero) && numero.startsWith(row.id_operacao);
    if (confere && row.id_ja_cadastrado && String((req.query || {}).confirmar) !== "1") {
      // A ANTT disse 219: o ID já existia antes desta declaração. O CIOT encontrado
      // pode ser de outra operação (outro sistema/portal); exige conferência humana.
      trilha(req, row, "consultar", "pendente", "pendente", { codigo: r.Codigo, mensagem: `CIOT ${numero} encontrado após 219; aguardando confirmação`, proxima_acao: "confirmar_com_antt" });
      return res.status(409).json({
        error: `ANTT tem o CIOT ${numero} para este ID, mas o ID já estava cadastrado antes desta declaração (219). Confira na ANTT se é esta operação e confirme com GET /api/ciot/${row.id}/consulta?confirmar=1.`,
        numero,
        status: "pendente",
        oficial: false,
        proxima_acao: "confirmar_com_antt",
      });
    }
    if (confere) {
      update("ciot", (c) => c.id === row.id, {
        status: "emitido",
        numero,
        codigo_verificador: numero.slice(12),
        mensagem_antt: mensagem,
        emitido_em: new Date().toISOString(),
      });
      trilha(req, row, "consultar", "pendente", "emitido", { codigo: r.Codigo, mensagem });
      return res.json({ numero, mensagem, status: "emitido", oficial: true });
    }
    const erro = numero
      ? `ANTT devolveu ${numero}, que não corresponde ao IdOperacaoTransporte ${row.id_operacao}. CIOT mantido pendente.`
      : "ANTT não devolveu o CIOT completo (16 caracteres). CIOT mantido pendente.";
    trilha(req, row, "consultar", "pendente", "pendente", { codigo: r.Codigo, mensagem: erro, proxima_acao: "verificar_com_antt" });
    return res.status(502).json({ error: erro, numero: numero || null, mensagem, status: "pendente", oficial: false, proxima_acao: "verificar_com_antt" });
  }
  return res.json({ numero: numero || null, mensagem, status: row.status, oficial: apresentar(row).oficial });
}

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
