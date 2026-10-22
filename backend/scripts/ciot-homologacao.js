#!/usr/bin/env node
/**
 * Roteiro da 1ª homologação do CIOT na ANTT (DCS PEF v1.1).
 *
 *   node scripts/ciot-homologacao.js validar  <arquivo.json>
 *       Offline: normaliza como o controller, roda anttPayload.montarDeclaracao
 *       e imprime o payload (sem senha). Verifica o certificado se configurado.
 *
 *   node scripts/ciot-homologacao.js executar <arquivo.json> [--cancelar <id_operacao2>]
 *       ATENÇÃO: fala com a ANTT de verdade. Só roda com ANTT_AMBIENTE=homologacao
 *       e CIOT_PROVIDER=antt. Declara -> consulta -> encerra e imprime a tabela
 *       de evidência. Com --cancelar, declara outra operação (id_operacao2) e a cancela.
 *       O servidor precisa estar PARADO (o banco tem lock de processo único).
 *
 * Arquivo: veja docs/ciot-homologacao.exemplo.json. Datas aceitam "+N" (dias a
 * partir de hoje, fuso de São Paulo) para não vencerem (regras B6/B22).
 * O arquivo com dados reais fica em backend/data/ (fora do git).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: process.env.ENV_FILE || path.join(__dirname, "../.env") });

const P = require("../src/services/anttPayload");
const { normalizarDoc } = require("../src/utils/documentos");

const [, , comando, arquivo, ...resto] = process.argv;

function sair(msg, codigo = 1) {
  console.error(msg);
  process.exit(codigo);
}

// "+3" -> data de hoje + 3 dias (America/Sao_Paulo); outros valores passam como vieram.
function resolverData(v) {
  const m = /^\+(\d{1,3})$/.exec(String(v ?? "").trim());
  if (!m) return v;
  return P.dataHora(new Date(Date.now() + Number(m[1]) * 86400000)).slice(0, 10);
}

function ler(caminho) {
  if (!caminho) sair("Uso: node scripts/ciot-homologacao.js <validar|executar> <arquivo.json>");
  let f;
  try {
    f = JSON.parse(fs.readFileSync(caminho, "utf8"));
  } catch (e) {
    sair(`Não foi possível ler ${caminho}: ${e.message}`);
  }
  f.data_inicio_viagem = resolverData(f.data_inicio_viagem);
  f.data_fim_viagem = resolverData(f.data_fim_viagem);
  return f;
}

// Mesmo mapeamento de ciotController.dadosAntt (não exportado): manter em sincronia.
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

// Remove qualquer ocorrência da senha do PFX de um texto antes de imprimir.
function sanitizar(v) {
  let s = typeof v === "string" ? v : JSON.stringify(v);
  const senha = process.env.ANTT_PFX_SENHA;
  if (senha && s) s = s.split(senha).join("***");
  return s;
}

function validar(f) {
  const empresaDoc = normalizarDoc(f.empresa_cnpj || "");
  const valor = Number(f.valor_contrato);
  if (!(valor > 0)) sair("Valor do contrato inválido (valor_contrato)");
  let emissorDoc = empresaDoc || undefined;
  if (process.env.ANTT_PFX_PATH) {
    try {
      const cert = require("../src/services/antt").verificarCertificado();
      console.log(`Certificado: CNPJ ${cert.cnpj || "?"}, válido até ${cert.valido_ate || "?"}`);
      if (cert.cnpj) {
        if (empresaDoc && normalizarDoc(cert.cnpj) !== empresaDoc) {
          sair(`Certificado é do CNPJ ${cert.cnpj}, diferente de empresa_cnpj (${empresaDoc}).`);
        }
        emissorDoc = normalizarDoc(cert.cnpj);
      }
    } catch (e) {
      sair(`Certificado inválido: ${sanitizar(e.message)}`);
    }
  } else {
    console.log("Certificado: não configurado (ANTT_PFX_PATH vazio); conferência B115 usa empresa_cnpj.");
  }
  const idm = String(f.id_operacao ?? "").trim();
  if (!/^[0-9A-Z]{12}$/.test(idm)) sair("id_operacao obrigatório: 12 caracteres [0-9A-Z] do gerador oficial da ANTT (regra B4)");
  try {
    return P.montarDeclaracao(dadosAntt(f, valor, empresaDoc), idm, new Date(), { emissorDoc });
  } catch (e) {
    sair(`Rejeitado localmente: ${sanitizar(e.message)}`);
  }
  return null;
}

// Fake de req/res para chamar os handlers do controller (mesmo caminho dos testes).
function chamar(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { code: 200 };
    res.status = (c) => ((res.code = c), res);
    res.json = (b) => {
      res.body = b;
      resolve(res);
      return res;
    };
    Promise.resolve(handler(req, res)).then(() => resolve(res), reject);
  });
}

async function executar(f) {
  if (String(process.env.ANTT_AMBIENTE || "").toLowerCase() !== "homologacao") {
    sair("Recusado: executar só roda com ANTT_AMBIENTE=homologacao. Nada foi enviado.");
  }
  if (String(process.env.CIOT_PROVIDER || "").toLowerCase() !== "antt") {
    sair("Recusado: executar exige CIOT_PROVIDER=antt. Nada foi enviado.");
  }
  validar(f); // aborta antes de qualquer rede se algo estiver errado

  const { get, all } = require("../src/db");
  const C = require("../src/controllers/ciotController");
  const empDoc = normalizarDoc(f.empresa_cnpj || "");
  const emp = all("empresas", (e) => normalizarDoc(e.cnpj) === empDoc)[0] || (empDoc ? null : get("empresas", () => true));
  if (!emp) sair(`Empresa com CNPJ ${empDoc} não encontrada em backend/data.`);
  const user = { id: "script-homologacao", empresa_id: emp.id };
  const correlacao = `homolog-${Date.now()}`;
  const mk = (body, params, query) => ({ body: body || {}, params: params || {}, query: query || {}, user, correlacao });
  const linhas = [];
  const reg = (servico, res, ciot) => {
    const b = res.body || {};
    linhas.push({
      servico,
      http: res.code,
      codigo: b.codigo || (ciot && ciot.codigo_antt) || "",
      protocolo: b.protocolo || (ciot && ciot.protocolo) || "",
      mensagem: b.mensagem || b.error || "",
      resposta_antt: ciot && ciot.resposta_antt ? sanitizar(ciot.resposta_antt).slice(0, 400) : "",
    });
  };
  const achar = (id) => get("ciot", (c) => c.id === id);

  const declarar = async (dados) => {
    const r = await chamar(C.emitir, mk(dados));
    reg("DeclaracaoOperacaoTransporte", r, r.body && r.body.id ? achar(r.body.id) : null);
    return r;
  };

  const r1 = await declarar(f);
  const id1 = r1.body && r1.body.id;
  if (id1) {
    await new Promise(setImmediate); // trava da declaração é solta no finally do controller
    const rc = await chamar(C.consultarGerado, mk({}, { id: id1 }));
    reg("ConsultarCIOTGerado", rc, achar(id1));
    if (achar(id1).status === "emitido") {
      const re = await chamar(C.encerrar, mk(f.encerramento || {}, { id: id1 }));
      reg("EncerramentoOperacaoTransporte", re, achar(id1));
    }
  }

  const i = resto.indexOf("--cancelar");
  if (i >= 0) {
    const id2 = resto[i + 1];
    if (!id2) sair("--cancelar exige o id_operacao da 2ª operação");
    const r2 = await declarar({ ...f, id_operacao: id2 });
    const idc = r2.body && r2.body.id;
    if (idc && achar(idc).status === "emitido") {
      const rx = await chamar(C.cancelar, mk({ motivo: f.motivo_cancelamento || "Teste de homologação" }, { id: idc }));
      reg("CancelamentoOperacaoTransporte", rx, achar(idc));
    }
  }

  console.log("\nEvidência (colar em docs/CIOT-STATUS.md; conferir antes que não há dado real):");
  console.log("| Serviço | HTTP | Código | Protocolo | Mensagem | resposta_antt |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const l of linhas) {
    const c = (v) => sanitizar(String(v ?? "")).replace(/\|/g, "/").replace(/\s+/g, " ");
    console.log(`| ${c(l.servico)} | ${l.http} | ${c(l.codigo)} | ${c(l.protocolo)} | ${c(l.mensagem)} | ${c(l.resposta_antt)} |`);
  }
}

(async () => {
  if (comando === "validar") {
    const payload = validar(ler(arquivo));
    console.log("Payload da declaração (sem rede, nada foi enviado):");
    console.log(sanitizar(JSON.stringify(payload, null, 2)));
    console.log("OK: validação local passou.");
  } else if (comando === "executar") {
    await executar(ler(arquivo));
  } else {
    sair("Uso: node scripts/ciot-homologacao.js <validar|executar> <arquivo.json>");
  }
})().catch((e) => sair(`Erro: ${sanitizar(e.message)}`));
