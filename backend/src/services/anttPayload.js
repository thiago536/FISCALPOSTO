// Montagem dos payloads JSON do PEF/ANTT (DCS PEF v1.1). Funcoes puras.
// Nomes de campos seguem os EXEMPLOS JSON do manual (onde a tabela diverge:
// ContratantesCargFrac, RNTRC do veiculo, PesoTotalCarga no encerramento).

class AnttValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnttValidationError";
  }
}

const digits = (v) => String(v ?? "").replace(/\D/g, "");
const fail = (msg) => {
  throw new AnttValidationError(msg);
};
const has = (v) => v !== undefined && v !== null && String(v) !== "";

function cpfValido(c) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[n])) return false;
  }
  return true;
}

function cnpjValido(c) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [12, 13]) {
    let s = 0;
    let p = n - 7;
    for (let i = 0; i < n; i++) {
      s += Number(c[i]) * p--;
      if (p < 2) p = 9;
    }
    const dv = s % 11 < 2 ? 0 : 11 - (s % 11);
    if (dv !== Number(c[n])) return false;
  }
  return true;
}

// B4: CPF/CNPJ com DV valido. Retorna so digitos.
function docObrig(v, nome) {
  const d = digits(v);
  if (!(cpfValido(d) || cnpjValido(d))) fail(`${nome} inválido (CPF/CNPJ com dígito verificador)`);
  return d;
}

// 9 digitos; 8 -> zero a esquerda; 7 invalido.
function rntrc(v, nome, obrig = true) {
  if (!has(v)) {
    if (obrig) fail(`${nome} é obrigatório`);
    return undefined;
  }
  let d = digits(v);
  if (d.length === 8) d = "0" + d;
  if (d.length !== 9) fail(`${nome} inválido (informe 9 dígitos; 8 recebem zero à esquerda)`);
  return d;
}

function placa(v, nome = "Placa") {
  const p = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p)) fail(`${nome} inválida: ${v}`);
  return p;
}

function dec(v, nome, { max = 99999999.99, obrig = true } = {}) {
  if (!has(v)) {
    if (obrig) fail(`${nome} é obrigatório`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) fail(`${nome} deve ser maior que zero`);
  return Math.round(n * 100) / 100;
}

function dataISO(v, nome) {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(`${nome} inválida (yyyy-MM-dd)`);
  return s;
}

// yyyy-MM-ddTHH:mm:ss em America/Sao_Paulo (B4, B11)
function dataHora(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}:${g("second")}`;
}

function ponto(p, sufixo, nome) {
  if (!p) return undefined;
  const o = {};
  const mun = p.municipio ?? p.codigo_municipio;
  if (has(mun)) {
    const m = digits(mun);
    if (m.length !== 7) fail(`${nome}: código IBGE do município deve ter 7 dígitos`);
    o[`CodigoMunicipio${sufixo}`] = Number(m);
  }
  if (has(p.cep)) {
    const c = digits(p.cep);
    if (c.length !== 8) fail(`${nome}: CEP deve ter 8 dígitos`);
    o[`Cep${sufixo}`] = c;
  }
  if (has(p.latitude) || has(p.longitude)) {
    if (!has(p.latitude) || !has(p.longitude)) fail(`${nome}: latitude e longitude devem ser informadas juntas`);
    o[`Latitude${sufixo}`] = Number(Number(p.latitude).toFixed(6));
    o[`Longitude${sufixo}`] = Number(Number(p.longitude).toFixed(6));
  }
  if (!Object.keys(o).length) fail(`${nome}: informe município, CEP ou latitude/longitude`);
  return o;
}

function origemDestino(lista, { distancia, qtdViagens }) {
  if (!Array.isArray(lista) || !lista.length) fail("OrigemDestino é obrigatório para este tipo de operação");
  return lista.map((od, i) => {
    const o = ponto(od.origem, "Origem", `Origem[${i + 1}]`);
    const d = ponto(od.destino, "Destino", `Destino[${i + 1}]`);
    if (!o || !d) fail(`OrigemDestino[${i + 1}]: origem e destino são obrigatórios`);
    const r = { Origem: o, Destino: d };
    if (distancia) {
      const km = Math.round(Number(od.distancia));
      if (!(km > 0) || String(km).length > 8) fail(`OrigemDestino[${i + 1}]: distância (km) deve ser maior que zero`);
      r.DistanciaPercorrida = km;
    }
    if (qtdViagens) {
      const q = Math.round(Number(od.qtd_viagens));
      if (!(q > 0) || q > 999) fail(`OrigemDestino[${i + 1}]: qtd_viagens inválida`);
      r.QtdViagens = q;
    }
    return r;
  });
}

// 1-IP/cartao, 2-CC, 3-Poupanca, 4-Conta pagamento, 5-Outros, 6-Pix
const TIPO_PAGTO = { PIX: 6, TED: 2, CARTAO: 1, DINHEIRO: 5, OUTROS: 5 };

function pagamento(p, creditadoPadrao) {
  const tipo = Number(has(p.tipo_pagamento) ? p.tipo_pagamento : TIPO_PAGTO[String(p.forma_pagto || "PIX").toUpperCase()]);
  if (![1, 2, 3, 4, 5, 6].includes(tipo)) fail("TipoPagamento inválido (1 a 6)");
  const r = { TipoPagamento: tipo };
  if ([1, 2, 3, 4].includes(tipo)) {
    // B92/B99
    const banco = digits(p.banco);
    if (!banco || banco.length > 3) fail("CodigoInstituicaoFinanceira (banco) obrigatório, até 3 dígitos");
    if (!has(p.conta)) fail("NumeroConta obrigatório para este tipo de pagamento");
    if (String(p.conta).length > 20) fail("NumeroConta excede 20 caracteres");
    r.CodigoInstituicaoFinanceira = Number(banco);
    if (tipo !== 1) {
      if (!has(p.agencia)) fail("NumeroAgencia obrigatório para este tipo de pagamento");
      if (String(p.agencia).length > 10) fail("NumeroAgencia excede 10 caracteres");
      r.NumeroAgencia = String(p.agencia);
    }
    r.NumeroConta = String(p.conta);
  } else if (tipo === 6) {
    if (!has(p.chave_pix)) fail("ChavePix obrigatória para pagamento via Pix");
    if (String(p.chave_pix).length > 77) fail("ChavePix excede 77 caracteres");
    if (!has(p.identificador_pix)) fail("IdentificadorPix obrigatório para pagamento via Pix");
    if (String(p.identificador_pix).length > 32) fail("IdentificadorPix excede 32 caracteres");
    r.ChavePix = String(p.chave_pix);
    r.IdentificadorPix = String(p.identificador_pix);
  }
  r.CpfCnpjCreditado = docObrig(p.creditado_doc || creditadoPadrao, "CpfCnpjCreditado");
  if (has(p.codigo_pagamento)) {
    if (String(p.codigo_pagamento).length > 50) fail("CodigoPagamento excede 50 caracteres");
    r.CodigoPagamento = Number(digits(p.codigo_pagamento)) || String(p.codigo_pagamento);
  }
  const prazo = Number(p.ind_pagamento ?? 0);
  if (![0, 1].includes(prazo)) fail("IndPagamento deve ser 0 (à vista) ou 1 (a prazo)");
  r.IndPagamento = prazo;
  if (prazo === 1) {
    // B105
    if (!has(p.numero_parcela) || !has(p.data_vencimento) || !has(p.valor_parcela)) {
      fail("NumeroParcela, DataVencimento e ValorParcela são obrigatórios quando IndPagamento = 1");
    }
    r.NumeroParcela = Math.round(Number(p.numero_parcela));
    r.DataVencimento = dataISO(p.data_vencimento, "DataVencimento");
    r.ValorParcela = dec(p.valor_parcela, "ValorParcela", { max: 9999999999.99 });
  } else if (has(p.numero_parcela) || has(p.data_vencimento) || has(p.valor_parcela)) {
    fail("Campos de parcela não devem ser informados quando IndPagamento = 0");
  }
  return r;
}

// f: dados ja normalizados pelo controller (ver controller para nomes).
function montarDeclaracao(f, idOperacao, agora = new Date()) {
  if (!/^[A-Za-z0-9]{12}$/.test(String(idOperacao || ""))) fail("IdOperacaoTransporte deve ter 12 caracteres");
  const tipo = Number(f.tipo_operacao ?? 1);
  if (![1, 2, 3].includes(tipo)) fail("TipoOperacao inválido (1, 2 ou 3)");

  const p = {
    IdOperacaoTransporte: String(idOperacao),
    TipoOperacao: tipo,
    CpfCnpjContratado: docObrig(f.contratado_doc, "CpfCnpjContratado"),
    RNTRCContratado: rntrc(f.contratado_rntrc, "RNTRCContratado"),
    CpfCnpjContratante: docObrig(f.contratante_doc, "CpfCnpjContratante"),
  };
  const rc = rntrc(f.contratante_rntrc, "RNTRCContratante", false);
  if (rc) p.RNTRCContratante = rc;

  if (tipo !== 3) p.CpfCnpjDestinatario = docObrig(f.destinatario_doc, "CpfCnpjDestinatario");
  else if (has(f.destinatario_doc)) fail("CpfCnpjDestinatario não deve ser informado para TAC-Agregado");

  p.ValorFrete = dec(f.valor_frete, "ValorFrete", { max: 99999999.99 });
  p.DataDeclaracao = dataHora(agora);
  p.IndContingencia = !!f.contingencia;
  if (p.IndContingencia) {
    if (!has(f.justificativa_contingencia)) fail("JustificativaContingencia obrigatória em contingência");
    if (String(f.justificativa_contingencia).length > 255) fail("JustificativaContingencia excede 255 caracteres");
    p.JustificativaContingencia = String(f.justificativa_contingencia);
  } else if (has(f.justificativa_contingencia)) {
    fail("JustificativaContingencia não permitida fora de contingência");
  }

  p.DataInicioViagem = dataISO(f.data_inicio_viagem, "DataInicioViagem");
  if (!p.IndContingencia && p.DataInicioViagem < p.DataDeclaracao.slice(0, 10)) {
    fail("A data de início da viagem não pode ser inferior à data atual"); // B6
  }
  p.DataFimViagem = dataISO(f.data_fim_viagem, "DataFimViagem");
  if (p.DataFimViagem < p.DataInicioViagem) fail("DataFimViagem deve ser maior ou igual à DataInicioViagem"); // B13

  const veic = f.veiculos;
  if (!Array.isArray(veic) || !veic.length) fail("Veiculos é obrigatório (ao menos uma placa)");
  const vistas = new Set();
  p.Veiculos = veic.map((v) => {
    const pl = placa(v.placa);
    if (vistas.has(pl)) fail(`Placa duplicada na lista de veículos: ${pl}`); // B5
    vistas.add(pl);
    const eixos = Number(v.eixos);
    if (!Number.isInteger(eixos) || eixos < 1 || eixos > 4) fail(`Veículo ${pl}: NumeroEixos deve ser de 1 a 4`); // B101
    const o = { Placa: pl };
    const r = rntrc(v.rntrc, `RNTRC do veículo ${pl}`, false);
    if (r) o.RNTRC = r;
    o.NumeroEixos = String(eixos);
    return o;
  });

  if (tipo === 1 || tipo === 2) {
    p.OrigemDestino = origemDestino(f.origem_destino, { distancia: true });
    const c = f.carga || {};
    const nat = digits(c.natureza);
    if (!nat || nat.length > 4) fail("DadosCarga.CodigoNaturezaCarga obrigatório (até 4 dígitos)");
    const tc = Number(c.tipo);
    if (!Number.isInteger(tc) || tc < 1 || tc > 12) fail("DadosCarga.CodigoTipoCarga deve ser de 1 a 12");
    p.DadosCarga = {
      CodigoNaturezaCarga: Number(nat),
      PesoCarga: dec(c.peso, "DadosCarga.PesoCarga", { max: 9999999.99 }),
      CodigoTipoCarga: tc,
    };
    if (tipo === 2) {
      const cf = c.contratantes_frac;
      if (!Array.isArray(cf) || !cf.length) fail("ContratantesCargFrac obrigatório para carga fracionada");
      p.DadosCarga.ContratantesCargFrac = cf.map((d) => docObrig(d, "ContratantesCargFrac"));
    }
  }

  p.InfPagamento = [pagamento(f.pagamento || {}, p.CpfCnpjContratado)];

  if (tipo === 1) {
    const i = f.indicadores || {};
    p.InfIndicadoresOperacionais = {
      IndAltoDesempenho: !!i.alto_desempenho,
      IndRetornoVazio: !!i.retorno_vazio,
      ComposicaoVeicular: !!i.composicao_veicular,
    };
  }
  return p;
}

function codigoCiot(v, nome = "CodigoIdentificacaoOperacao") {
  const s = String(v ?? "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9]{16}$/.test(s)) fail(`${nome} deve ter 16 caracteres (ID + código verificador)`);
  return s;
}

function montarCancelamento(ciot, motivo) {
  if (!has(motivo)) fail("MotivoCancelamento é obrigatório");
  if (String(motivo).length > 500) fail("MotivoCancelamento excede 500 caracteres");
  return { CodigoIdentificacaoOperacao: codigoCiot(ciot), MotivoCancelamento: String(motivo) };
}

// Encerramento: tipo 1 exige peso; tipo 3 exige OrigemDestino (com distancia e qtd_viagens).
function montarEncerramento(ciot, tipo, f = {}) {
  const p = { CodigoIdentificacaoOperacao: codigoCiot(ciot) };
  if (tipo === 3) {
    p.OrigemDestino = origemDestino(f.origem_destino, { distancia: true, qtdViagens: true });
  }
  if (tipo === 1) {
    p.DadosCarga = { PesoTotalCarga: dec(f.peso_carga, "PesoCarga", { max: 9999999.99 }) };
  } else if (has(f.peso_carga)) {
    p.DadosCarga = { PesoTotalCarga: dec(f.peso_carga, "PesoCarga", { max: 9999999.99 }) };
  }
  return p;
}

function montarConsultaCiot(id, ano) {
  const s = String(id ?? "");
  if (!/^[A-Za-z0-9]{12}$/.test(s)) fail("CodigoIdentificacaoOperacao deve ter 12 caracteres");
  const o = { CodigoIdentificacaoOperacao: s };
  if (has(ano)) o.AnoDeclaracao = Number(ano);
  return o;
}

function montarSituacao({ interessado, transportador, rntrc: r }) {
  return {
    CpfCnpjInteressado: docObrig(interessado, "CpfCnpjInteressado"),
    CpfCnpjTransportador: docObrig(transportador, "CpfCnpjTransportador"),
    RNTRCTransportador: rntrc(r, "RNTRCTransportador"),
  };
}

function montarFrota({ interessado, transportador, rntrc: r, placas }) {
  if (!Array.isArray(placas) || !placas.length) fail("Placas é obrigatório");
  return { ...montarSituacao({ interessado, transportador, rntrc: r }), Placas: placas.map((x) => placa(x)) };
}

module.exports = {
  AnttValidationError,
  montarDeclaracao,
  montarCancelamento,
  montarEncerramento,
  montarConsultaCiot,
  montarSituacao,
  montarFrota,
  cpfValido,
  cnpjValido,
  dataHora,
  TIPO_PAGTO,
};
