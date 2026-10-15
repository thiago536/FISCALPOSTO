/**
 * Converte os registros internos (empresa, NF-e, CT-e, MDF-e) no JSON da
 * Focus NFe. Referência dos campos: https://campos.focusnfe.com.br
 *
 * Número e série não são enviados: a Focus controla a numeração por empresa,
 * o que evita furo/duplicidade quando uma nota é rejeitada.
 */
const { onlyDigits, dhEmi } = require("../utils/fiscal");

// Remove chaves vazias: a Focus valida "" como valor informado e rejeita.
function limpo(obj) {
  if (Array.isArray(obj)) return obj.map(limpo);
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "object" ? limpo(v) : v;
  }
  return out;
}

const dec = (n, casas = 2) => Number(Number(n || 0).toFixed(casas));

// Monta os campos de uma parte (remetente, destinatario, ...) no padrão
// `<campo>_<papel>` que a Focus usa em todos os documentos.
function parte(papel, p) {
  const doc = onlyDigits(p.doc);
  return {
    [`nome_${papel}`]: p.nome,
    [doc.length === 11 ? `cpf_${papel}` : `cnpj_${papel}`]: doc || undefined,
    [`inscricao_estadual_${papel}`]: p.ie,
    [`logradouro_${papel}`]: p.logradouro,
    [`numero_${papel}`]: p.numero || (p.logradouro ? "SN" : undefined),
    [`bairro_${papel}`]: p.bairro,
    [`codigo_municipio_${papel}`]: onlyDigits(p.cmun) || undefined,
    [`municipio_${papel}`]: p.municipio,
    [`uf_${papel}`]: p.uf,
    [`cep_${papel}`]: onlyDigits(p.cep) || undefined,
    [`telefone_${papel}`]: onlyDigits(p.fone) || undefined,
  };
}

// Empresa e cliente gravam endereço com nomes próprios; normaliza aqui.
function deEmpresa(e) {
  return { nome: e.razao_social, doc: e.cnpj, ie: e.ie, logradouro: e.logradouro, numero: e.numero, bairro: e.bairro, cmun: e.cmun, municipio: e.municipio, uf: e.uf, cep: e.cep, fone: e.fone };
}
function deCliente(c) {
  return { nome: c.nome, doc: c.cpf_cnpj, ie: c.ie, logradouro: c.logradouro, numero: c.numero, bairro: c.bairro, cmun: c.cmun, municipio: c.municipio, uf: c.uf, cep: c.cep, fone: c.fone };
}

function emitente(e) {
  const p = parte("emitente", deEmpresa(e));
  delete p.telefone_emitente;
  p.nome_fantasia_emitente = e.nome_fantasia;
  return p;
}

// Tabela tPag da NF-e.
const T_PAG = { DINHEIRO: "01", CHEQUE: "02", CARTAO: "03", CREDITO: "03", DEBITO: "04", BOLETO: "15", PIX: "17", TED: "18", PRAZO: "90", OUTROS: "99" };

function nfe(e, nota, itens, dest) {
  const destDoc = onlyDigits(dest.doc);
  const ieDest = dest.ie && String(dest.ie).toUpperCase() !== "ISENTO" ? onlyDigits(dest.ie) : "";
  const destUf = dest.uf || e.uf;
  const total = dec(itens.reduce((s, i) => s + Number(i.valor_total), 0));
  const forma = T_PAG[String(nota.forma_pagamento || "DINHEIRO").toUpperCase()] || "99";
  const destino = parte("destinatario", dest);
  delete destino.inscricao_estadual_destinatario;
  return limpo({
    natureza_operacao: nota.natureza,
    data_emissao: dhEmi(nota.emitido_em),
    tipo_documento: 1,
    finalidade_emissao: 1,
    local_destino: destUf === e.uf ? 1 : 2,
    // Sem IE o destinatário é tratado como consumidor final (indFinal=1).
    consumidor_final: ieDest ? 0 : 1,
    presenca_comprador: 1,
    ...emitente(e),
    regime_tributario_emitente: Number(e.crt) || 3,
    ...destino,
    inscricao_estadual_destinatario: ieDest,
    indicador_inscricao_estadual_destinatario: ieDest ? 1 : 9,
    modalidade_frete: 9,
    valor_produtos: total,
    valor_total: total,
    formas_pagamento: [{ forma_pagamento: forma, descricao_pagamento: forma === "99" ? "OUTROS" : undefined, valor_pagamento: total }],
    items: itens.map((it) => {
      const combustivel = !!it.anp;
      return {
        numero_item: it.item,
        codigo_produto: it.codigo || String(it.item),
        descricao: it.descricao,
        codigo_ncm: onlyDigits(it.ncm || "27101259"),
        cfop: onlyDigits(it.cfop || "5656"),
        unidade_comercial: it.unidade || "LT",
        quantidade_comercial: dec(it.quantidade, 4),
        valor_unitario_comercial: dec(it.valor_unitario, 10),
        unidade_tributavel: it.unidade || "LT",
        quantidade_tributavel: dec(it.quantidade, 4),
        valor_unitario_tributavel: dec(it.valor_unitario, 10),
        valor_bruto: dec(it.valor_total),
        inclui_no_total: 1,
        icms_origem: 0,
        icms_situacao_tributaria: it.icms_cst,
        icms_modalidade_base_calculo: it.icms_base > 0 ? 3 : undefined,
        icms_base_calculo: it.icms_base > 0 ? dec(it.icms_base) : undefined,
        icms_aliquota: it.icms_base > 0 ? dec(it.icms_aliq) : undefined,
        icms_valor: it.icms_base > 0 ? dec(it.icms_valor) : undefined,
        // Combustível é monofásico em PIS/COFINS (CST 04); demais itens, 49.
        pis_situacao_tributaria: it.pis_cst || (combustivel ? "04" : "49"),
        cofins_situacao_tributaria: it.cofins_cst || (combustivel ? "04" : "49"),
        combustivel_codigo_anp: combustivel ? onlyDigits(it.anp) : undefined,
        combustivel_descricao_anp: combustivel ? it.desc_anp || it.descricao : undefined,
        combustivel_sigla_uf: combustivel ? it.uf_consumo || destUf : undefined,
      };
    }),
  });
}

// toma: 0 remetente, 3 destinatário (os dois casos que o formulário oferece).
function cte(e, c, rem, dest, chavesNfe) {
  const tomador = Number(c.tomador) === 3 ? 3 : 0;
  const tomadorParte = tomador === 3 ? dest : rem;
  const ieToma = tomadorParte.ie && String(tomadorParte.ie).toUpperCase() !== "ISENTO";
  return limpo({
    cfop: onlyDigits(c.cfop),
    natureza_operacao: c.natureza,
    data_emissao: dhEmi(c.emitido_em),
    tipo_documento: 0,
    modal: "01",
    tipo_servico: 0,
    codigo_municipio_envio: onlyDigits(e.cmun),
    municipio_envio: e.municipio,
    uf_envio: e.uf,
    codigo_municipio_inicio: onlyDigits(rem.cmun),
    municipio_inicio: rem.municipio,
    uf_inicio: rem.uf,
    codigo_municipio_fim: onlyDigits(dest.cmun),
    municipio_fim: dest.municipio,
    uf_fim: dest.uf,
    retirar_mercadoria: 1,
    tomador,
    indicador_inscricao_estadual_tomador: ieToma ? 1 : 9,
    ...emitente(e),
    ...parte("remetente", rem),
    ...parte("destinatario", dest),
    valor_total: dec(c.valor_servico),
    valor_receber: dec(c.valor_servico),
    icms_situacao_tributaria: c.icms_aliq > 0 ? "00" : "41",
    icms_base_calculo: c.icms_aliq > 0 ? dec(c.icms_base) : undefined,
    icms_aliquota: c.icms_aliq > 0 ? dec(c.icms_aliq) : undefined,
    icms_valor: c.icms_aliq > 0 ? dec(c.icms_valor) : undefined,
    valor_total_carga: dec(c.valor_carga),
    produto_predominante: c.carga,
    quantidades: [{ codigo_unidade_medida: "01", tipo_medida: "PESO BRUTO", quantidade: dec(c.peso_kg, 4) }],
    nfes: chavesNfe.map((chave) => ({ chave_nfe: chave })),
    modal_rodoviario: { rntrc: onlyDigits(c.rntrc) },
  });
}

// emitente (tpEmit): 1 prestador de serviço (carga de terceiros, com CT-e),
// 2 transportador de carga própria (posto levando a própria NF-e).
function mdfe(e, m, condutores, percurso, documentos, ciot) {
  const nfes = documentos.filter((d) => d.tipo !== "cte").map((d) => ({ chave_nfe: d.chave }));
  const ctes = documentos.filter((d) => d.tipo === "cte").map((d) => ({ chave_cte: d.chave }));
  const tpEmit = Number(m.tipo_emitente) || (ctes.length ? 1 : 2);
  return limpo({
    emitente: tpEmit,
    data_emissao: dhEmi(m.emitido_em),
    uf_inicio: m.uf_ini,
    uf_fim: m.uf_fim,
    ...emitente(e),
    municipios_carregamento: [{ codigo: onlyDigits(m.carregamento_cmun || e.cmun), nome: m.carregamento_municipio || e.municipio }],
    percursos: percurso.map((p) => ({ uf_percurso: p.uf })),
    municipios_descarregamento: [{
      codigo: onlyDigits(m.descarregamento_cmun),
      nome: m.descarregamento_municipio,
      notas_fiscais: nfes.length ? nfes : undefined,
      conhecimentos_transporte: ctes.length ? ctes : undefined,
    }],
    quantidade_total_nfe: nfes.length || undefined,
    quantidade_total_cte: ctes.length || undefined,
    valor_total_carga: dec(m.valor_carga),
    codigo_unidade_medida_peso_bruto: "01",
    peso_bruto: dec(m.peso_kg, 4),
    tipo_carga: m.tipo_carga || "02",
    descricao_produto: m.produto || "COMBUSTIVEL",
    codigo_ncm_produto: onlyDigits(m.ncm_produto) || undefined,
    modal_rodoviario: {
      registro_nacional_transporte: onlyDigits(m.rntrc) || undefined,
      ciot: ciot ? [{
        // Layout do MDF-e aceita só os 12 dígitos do ID; no modo ANTT o número guardado inclui o DV.
        ciot: String(ciot.numero).slice(0, 12),
        [onlyDigits(ciot.contratante_doc).length === 11 ? "cpf_responsavel" : "cnpj_responsavel"]: onlyDigits(ciot.contratante_doc),
      }] : undefined,
      placa_veiculo: m.placa,
      renavam_veiculo: onlyDigits(m.renavam) || undefined,
      tara_veiculo: Number(m.tara_kg) || undefined,
      tipo_rodado_veiculo: m.tipo_rodado || "03",
      // tpRod 03 = cavalo mecânico, que não tem carroceria própria (tpCar 00).
      tipo_carroceria_veiculo: m.tipo_carroceria || "00",
      uf_licenciamento_veiculo: m.uf_veiculo || e.uf,
      condutores: condutores.map((c) => ({ nome: c.nome, cpf: onlyDigits(c.cpf) })),
    },
  });
}

module.exports = { nfe, cte, mdfe, deCliente, deEmpresa, limpo };
