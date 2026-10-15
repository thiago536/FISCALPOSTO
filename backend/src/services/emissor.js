/**
 * Ponto único de decisão entre o emissor local (simulado, sem valor fiscal)
 * e a Focus NFe (transmissão real à SEFAZ).
 *
 *   FISCAL_PROVIDER=local  -> services/sefaz.js aprova na hora (desenvolvimento)
 *   FISCAL_PROVIDER=focus  -> services/focus.js; emissão assíncrona, o registro
 *                             fica "processando" até a SEFAZ responder
 *
 * O id interno do documento é usado como `ref` na Focus.
 */
const { all, get, update } = require("../db");
const focus = require("./focus");
const logger = require("../middleware/logger");

const TIPOS = ["nfe", "cte", "mdfe"];

function modo() {
  return String(process.env.FISCAL_PROVIDER || "local").toLowerCase() === "focus" ? "focus" : "local";
}

// Ambiente SEFAZ (tpAmb) que corresponde à configuração atual.
function ambiente(empresa) {
  if (modo() === "local") return empresa.ambiente;
  return focus.config().ambiente === "producao" ? 1 : 2;
}

const STATUS = {
  autorizado: "autorizada",
  processando_autorizacao: "processando",
  erro_autorizacao: "rejeitada",
  denegado: "denegada",
  cancelado: "cancelada",
  encerrado: "encerrada",
};

const semPrefixo = (c) => (c ? String(c).replace(/^\D+/, "") : null);

function caminhos(r) {
  return {
    xml: r.caminho_xml_nota_fiscal || r.caminho_xml || null,
    pdf: r.caminho_danfe || r.caminho_dacte || r.caminho_damdfe || null,
  };
}

// Ordem de maturidade do status: uma resposta atrasada (consulta lenta,
// download do XML) nunca pode levar o registro para trás, p.ex. de
// "cancelada" de volta para "autorizada".
const NIVEL = { processando: 0, rejeitada: 1, autorizada: 1, denegada: 2, encerrada: 2, cancelada: 2 };
const nivel = (s) => NIVEL[s] ?? 0;

// Documentos cujo POST de emissão ainda não voltou. O sincronizador não os
// consulta: a Focus pode responder 404 antes de registrar o envio.
const enviando = new Set();
const chaveEnvio = (tipo, id) => `${tipo}:${id}`;

// Manifesto rejeitado não pode prender o CIOT vinculado.
function liberarCiot(tipo, row) {
  if (tipo === "mdfe" && row && row.ciot_id) {
    update("ciot", (c) => c.id === row.ciot_id && c.mdfe_id === row.id, { mdfe_id: null });
  }
}

function gravar(tipo, id, patch) {
  // Relê na hora de gravar: entre a leitura inicial e aqui houve await.
  const atual = get(tipo, (x) => x.id === id);
  if (!atual) return null;
  if (patch.status && nivel(patch.status) < nivel(atual.status)) {
    logger.warn(`Ignorada transição ${atual.status} -> ${patch.status} de ${tipo} ${id}`);
    return atual;
  }
  if (patch.status && atual.status !== "processando" && nivel(patch.status) === nivel(atual.status) && patch.status !== atual.status) {
    // autorizada <-> rejeitada só a partir de "processando".
    logger.warn(`Ignorada transição ${atual.status} -> ${patch.status} de ${tipo} ${id}`);
    return atual;
  }
  update(tipo, (x) => x.id === id, patch);
  const novo = get(tipo, (x) => x.id === id);
  if (novo.status === "rejeitada" && atual.status !== "rejeitada") liberarCiot(tipo, novo);
  return novo;
}

// Grava no registro o que a Focus devolveu (na emissão ou numa consulta).
async function aplicar(tipo, id, r) {
  const atual = get(tipo, (x) => x.id === id);
  if (!atual) return null;
  const status = STATUS[r.status] || atual.status;
  const { xml, pdf } = caminhos(r);
  const patch = {
    status,
    focus_status: r.status,
    cstat: r.status_sefaz || atual.cstat || null,
    motivo: r.mensagem_sefaz || r.mensagem || atual.motivo,
  };
  const chave = semPrefixo(r.chave_nfe || r.chave_cte || r.chave_mdfe || r.chave);
  if (chave) patch.chave = chave;
  if (r.numero) patch.numero = Number(r.numero);
  if (r.serie) patch.serie = Number(r.serie);
  if (r.protocolo) patch.protocolo = r.protocolo;
  if (xml) patch.caminho_xml = xml;
  if (pdf) patch.caminho_pdf = pdf;
  if (status === "autorizada" && !atual.autorizado_em) patch.autorizado_em = new Date().toISOString();

  // Troca o XML de pré-visualização pelo XML assinado e autorizado.
  if (status === "autorizada" && xml && !atual.xml_oficial) {
    try {
      patch.xml = (await focus.baixar(xml)).toString("utf8");
      patch.xml_oficial = true;
    } catch (err) {
      logger.warn(`XML autorizado de ${tipo} ${id} não baixado: ${err.message}`);
    }
  }
  return gravar(tipo, id, patch);
}

// 408/429 são limites temporários: o documento pode não ter sido aceito ainda,
// mas também não foi recusado. Demais 4xx são recusa definitiva da Focus.
const recusaDefinitiva = (err) =>
  err instanceof focus.FocusError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

// Envia à Focus. Erro de rede/5xx deixa "processando" para o sincronizador
// consultar depois, porque a Focus pode ter recebido o documento mesmo sem a
// resposta chegar aqui.
async function emitir(tipo, id, payload) {
  const k = chaveEnvio(tipo, id);
  enviando.add(k);
  try {
    const r = await focus.emitir(tipo, id, payload);
    return await aplicar(tipo, id, r);
  } catch (err) {
    if (recusaDefinitiva(err)) {
      return gravar(tipo, id, { status: "rejeitada", focus_status: err.codigo || "erro", motivo: err.message });
    }
    logger.error(`Envio de ${tipo} ${id} à Focus falhou: ${err.message}`);
    update(tipo, (x) => x.id === id && x.status === "processando", { motivo: `Aguardando confirmação da Focus: ${err.message}` });
    return get(tipo, (x) => x.id === id);
  } finally {
    enviando.delete(k);
  }
}

// Só depois deste prazo um 404 na consulta prova que o envio se perdeu.
const PRAZO_404_MS = Number(process.env.FOCUS_PRAZO_404_MS ?? 5 * 60 * 1000);

async function sincronizar(tipo, id) {
  if (enviando.has(chaveEnvio(tipo, id))) return get(tipo, (x) => x.id === id);
  try {
    return await aplicar(tipo, id, await focus.consultar(tipo, id));
  } catch (err) {
    const row = get(tipo, (x) => x.id === id);
    const idade = row ? Date.now() - new Date(row.created_at).getTime() : 0;
    if (err instanceof focus.FocusError && err.status === 404 && row && row.status === "processando"
      && !enviando.has(chaveEnvio(tipo, id)) && idade > PRAZO_404_MS) {
      return gravar(tipo, id, { status: "rejeitada", motivo: "Documento não recebido pela Focus. Emita novamente." });
    }
    if (!(err instanceof focus.FocusError && err.status === 404)) {
      logger.warn(`Consulta de ${tipo} ${id} falhou: ${err.message}`);
    }
    return row;
  }
}

// Justificativa da SEFAZ: 15 a 255 caracteres.
function justificativa(texto) {
  const j = String(texto || "").trim();
  if (j.length < 15 || j.length > 255) {
    const e = new Error("Justificativa deve ter de 15 a 255 caracteres");
    e.status = 400;
    throw e;
  }
  return j;
}

async function cancelar(tipo, row, texto) {
  const r = await focus.cancelar(tipo, row.id, justificativa(texto));
  if (r.status !== "cancelado") {
    const e = new Error(r.mensagem_sefaz || r.mensagem || `Cancelamento não aceito (${r.status})`);
    e.status = 400;
    throw e;
  }
  update(tipo, (x) => x.id === row.id, {
    status: "cancelada",
    motivo: r.mensagem_sefaz || "Cancelamento homologado",
    caminho_xml_cancelamento: r.caminho_xml_cancelamento || null,
    cancelado_em: new Date().toISOString(),
  });
  return r;
}

async function encerrarMdfe(row, { uf, municipio, data }) {
  if (!uf || !municipio) {
    const e = new Error("Informe UF e município de encerramento");
    e.status = 400;
    throw e;
  }
  const r = await focus.encerrarMdfe(row.id, {
    data: data || new Date().toISOString().slice(0, 10),
    sigla_uf: uf,
    nome_municipio: municipio,
  });
  if (r.status !== "encerrado") {
    const e = new Error(r.mensagem_sefaz || r.mensagem || `Encerramento não aceito (${r.status})`);
    e.status = 400;
    throw e;
  }
  update("mdfe", (x) => x.id === row.id, {
    status: "encerrada",
    motivo: r.mensagem_sefaz || "Encerramento homologado",
    encerrado_em: new Date().toISOString(),
  });
  return r;
}

async function pdf(row) {
  if (!row.caminho_pdf) return null;
  return focus.baixar(row.caminho_pdf);
}

let rodando = false;
async function sincronizarPendentes() {
  if (rodando || modo() !== "focus") return;
  rodando = true;
  try {
    for (const tipo of TIPOS) {
      for (const row of all(tipo, (x) => x.status === "processando" && !enviando.has(chaveEnvio(tipo, x.id)))) {
        await sincronizar(tipo, row.id);
      }
    }
  } finally {
    rodando = false;
  }
}

function iniciarSincronizador() {
  if (modo() !== "focus") return null;
  focus.config(); // falha cedo se token/ambiente estiverem errados
  const ms = Number(process.env.FOCUS_POLL_MS) || 15000;
  const t = setInterval(() => sincronizarPendentes().catch((e) => logger.error(e.message)), ms);
  t.unref();
  return t;
}

module.exports = {
  modo,
  ambiente,
  emitir,
  sincronizar,
  cancelar,
  encerrarMdfe,
  pdf,
  justificativa,
  sincronizarPendentes,
  iniciarSincronizador,
};
