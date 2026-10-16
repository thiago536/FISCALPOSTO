// Montagem dos payloads JSON do PEF/ANTT (DCS PEF v1.1). Funcoes puras.
// Nomes de campos seguem os EXEMPLOS JSON do manual (onde a tabela diverge:
// ContratantesCargFrac, RNTRC do veiculo, PesoTotalCarga no encerramento).

const D = require("../utils/documentos");

class AnttValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnttValidationError";
  }
}

// Validadores de documentos.js lançam ValidacaoError; aqui viram AnttValidationError
// (mesma mensagem) para o controller e os testes tratarem um tipo só.
function oficial(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof D.ValidacaoError) throw new AnttValidationError(e.message);
    throw e;
  }
}

const digits = (v) => String(v ?? "").replace(/\D/g, "");
const fail = (msg) => {
  throw new AnttValidationError(msg);
};
const has = (v) => v !== undefined && v !== null && String(v) !== "";

const cpfValido = D.cpfValido;
const cnpjValido = D.cnpjValido;

// B4: CPF/CNPJ com DV valido (CNPJ alfanumérico aceito). Retorna sem máscara.
function docObrig(v, nome) {
  return oficial(() => D.exigirDoc(v, nome));
}

// 9 digitos; 8 -> zero a esquerda; 7 invalido.
function rntrc(v, nome, obrig = true) {
  if (!has(v)) {
    if (obrig) fail(`${nome} é obrigatório`);
    return undefined;
  }
  const d = oficial(() => D.normalizarRntrc(v, nome));
  return d.padStart(9, "0"); // 8 dígitos recebem zero à esquerda (manual PEF)
}

function placa(v, nome = "Placa") {
  return oficial(() => D.exigirPlaca(v, nome));
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

// DCS (OrigemDestino): havendo mais de uma forma de localização no par, usa-se
// sempre a mais específica: LatLong -> CEP -> Cidade. Só ela vai no payload.
// Retorna { o, tipo } para a regra B111 (origem e destino com o mesmo tipo).
function ponto(p, sufixo, nome) {
  if (!p) return undefined;
  const mun = p.municipio ?? p.codigo_municipio;
  if (has(p.latitude) || has(p.longitude)) {
    if (!has(p.latitude) || !has(p.longitude)) fail(`${nome}: latitude e longitude devem ser informadas juntas`); // B110
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      fail(`${nome}: latitude/longitude inválidas`);
    }
    return { tipo: "coordenadas", o: { [`Latitude${sufixo}`]: Number(lat.toFixed(6)), [`Longitude${sufixo}`]: Number(lon.toFixed(6)) } };
  }
  if (has(p.cep)) {
    const c = digits(p.cep);
    if (c.length !== 8) fail(`${nome}: CEP deve ter 8 dígitos`);
    return { tipo: "CEP", o: { [`Cep${sufixo}`]: c } };
  }
  if (has(mun)) {
    const m = oficial(() => D.exigirMunicipio(mun, null, `${nome}: código IBGE do município`));
    // Os 2 primeiros dígitos do código IBGE são o código da UF.
    if (!Object.values(D.CUF).includes(m.slice(0, 2))) fail(`${nome}: código IBGE ${m} não começa por código de UF válido`);
    return { tipo: "município", o: { [`CodigoMunicipio${sufixo}`]: Number(m) } };
  }
  fail(`${nome}: informe município, CEP ou latitude/longitude`); // B109
}

function origemDestino(lista, { distancia, qtdViagens }) {
  if (!Array.isArray(lista) || !lista.length) fail("OrigemDestino é obrigatório para este tipo de operação");
  return lista.map((od, i) => {
    const po = ponto(od.origem, "Origem", `Origem[${i + 1}]`);
    const pd = ponto(od.destino, "Destino", `Destino[${i + 1}]`);
    if (!po || !pd) fail(`OrigemDestino[${i + 1}]: origem e destino são obrigatórios`);
    if (po.tipo !== pd.tipo) {
      fail(`OrigemDestino[${i + 1}]: origem (${po.tipo}) e destino (${pd.tipo}) devem usar o mesmo tipo de localização (regra B111)`);
    }
    const r = { Origem: po.o, Destino: pd.o };
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

function pagamento(p, creditadoPadrao, { ip = false } = {}) {
  const tipo = Number(has(p.tipo_pagamento) ? p.tipo_pagamento : TIPO_PAGTO[String(p.forma_pagto || "PIX").toUpperCase()]);
  if (![1, 2, 3, 4, 5, 6].includes(tipo)) fail("TipoPagamento inválido (1 a 6)");
  // B118: cartão pré-pago (1) só quando quem transmite é Instituição de Pagamento.
  if (tipo === 1 && !ip) fail("TipoPagamento 1 (cartão pré-pago de IP) não é permitido quando o certificado não é de Instituição de Pagamento (regra B118)");
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
    const cod = String(p.codigo_pagamento).trim();
    if (cod.length > 50) fail("CodigoPagamento excede 50 caracteres");
    // Linha digitável de boleto tem 47-48 dígitos: como Number perderia dígitos
    // (limite 2^53). Só vira número quando cabe sem perda.
    const n = /^\d+$/.test(cod) ? Number(cod) : NaN;
    r.CodigoPagamento = Number.isSafeInteger(n) ? n : cod;
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

const DIA_MS = 86400000;
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DIA_MS);

// f: dados ja normalizados pelo controller (ver controller para nomes).
// opts.ip: certificado de Instituição de Pagamento (este sistema não é IP).
// opts.emissorDoc: CNPJ do certificado; sem IP, B115 exige contratado = emissor.
function montarDeclaracao(f, idOperacao, agora = new Date(), { ip = false, emissorDoc } = {}) {
  if (!/^[0-9A-Z]{12}$/.test(String(idOperacao || ""))) fail("IdOperacaoTransporte deve ter 12 caracteres [0-9A-Z]");
  const tipo = Number(f.tipo_operacao ?? 1);
  if (![1, 2, 3].includes(tipo)) fail("TipoOperacao inválido (1, 2 ou 3)");

  const p = {
    IdOperacaoTransporte: String(idOperacao),
    TipoOperacao: tipo,
    CpfCnpjContratado: docObrig(f.contratado_doc, "CpfCnpjContratado"),
    RNTRCContratado: rntrc(f.contratado_rntrc, "RNTRCContratado"),
    CpfCnpjContratante: docObrig(f.contratante_doc, "CpfCnpjContratante"),
  };
  if (!ip && emissorDoc && p.CpfCnpjContratado !== emissorDoc) {
    // B115 + Portaria SUROC 6/2026 art. 3º: sem IP, a ETC só declara em nome
    // próprio (ela é a contratada). Operação com TAC/equiparado exige IP.
    fail(
      `CpfCnpjContratado (${p.CpfCnpjContratado}) deve ser o CNPJ do certificado (${emissorDoc}): pelo web service direto a ETC só declara operação em que ela é a transportadora contratada (regra B115). Operação com TAC ou equiparado deve ser gerada por Instituição de Pagamento.`
    );
  }
  if (tipo === 3 && !ip) {
    // B27: TAC-Agregado exige contratado TAC; com B115 isso só é possível via IP.
    fail("TAC-Agregado (TipoOperacao 3) exige contratado TAC e só pode ser declarado por Instituição de Pagamento (regras B27/B115)");
  }
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

  const hoje = p.DataDeclaracao.slice(0, 10);
  // B56: TAC-Agregado não informa DataInicioViagem (a ANTT usa a data da declaração).
  const inicio = tipo === 3 ? hoje : dataISO(f.data_inicio_viagem, "DataInicioViagem");
  if (tipo === 3) {
    if (has(f.data_inicio_viagem)) fail("DataInicioViagem não deve ser informada para TAC-Agregado (regra B56)");
  } else {
    p.DataInicioViagem = inicio;
    if (!p.IndContingencia && inicio < hoje) fail("A data de início da viagem não pode ser inferior à data atual"); // B6
    if (!p.IndContingencia && diasEntre(hoje, inicio) > 30) fail("A data de início da viagem excede 30 dias da data atual (regra B22)");
  }
  p.DataFimViagem = dataISO(f.data_fim_viagem, "DataFimViagem");
  if (p.DataFimViagem < inicio) fail("DataFimViagem deve ser maior ou igual à DataInicioViagem"); // B13
  const limite = tipo === 3 ? 30 : 90; // B30 / B21
  if (diasEntre(inicio, p.DataFimViagem) > limite) fail(`O intervalo entre início e fim da viagem não pode passar de ${limite} dias (regra ${tipo === 3 ? "B30" : "B21"})`);

  const veic = f.veiculos;
  if (!Array.isArray(veic) || !veic.length) fail("Veiculos é obrigatório (ao menos uma placa)");
  if (veic.length > 5) fail("Somente é permitido informar até 5 veículos (regra B49)");
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
      if (p.DadosCarga.ContratantesCargFrac.includes(p.CpfCnpjContratante)) {
        fail("ContratantesCargFrac não pode repetir o CpfCnpjContratante da operação (regra B119)");
      }
    }
  }

  p.InfPagamento = [pagamento(f.pagamento || {}, p.CpfCnpjContratado, { ip })];

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
  if (!/^[0-9A-Z]{16}$/.test(s)) fail(`${nome} deve ter 16 caracteres (ID + código verificador)`);
  return s;
}

function montarCancelamento(ciot, motivo) {
  if (!has(motivo)) fail("MotivoCancelamento é obrigatório");
  if (String(motivo).length > 500) fail("MotivoCancelamento excede 500 caracteres");
  return { CodigoIdentificacaoOperacao: codigoCiot(ciot), MotivoCancelamento: String(motivo) };
}

// Encerramento (DCS serviço 06):
// - OrigemDestino (com distância e qtd_viagens) só no TAC-Agregado (B43/B44/B58);
// - PesoCarga obrigatório na lotação (B65) e proibido na fracionada (B57) e no TAC-Agregado (B62).
function montarEncerramento(ciot, tipo, f = {}) {
  const p = { CodigoIdentificacaoOperacao: codigoCiot(ciot) };
  if (tipo === 3) {
    p.OrigemDestino = origemDestino(f.origem_destino, { distancia: true, qtdViagens: true });
  } else if (has(f.origem_destino) && (!Array.isArray(f.origem_destino) || f.origem_destino.length)) {
    fail("OrigemDestino não deve ser informado no encerramento de lotação/fracionada (regra B44)");
  }
  if (tipo === 1) {
    p.DadosCarga = { PesoTotalCarga: dec(f.peso_carga, "PesoCarga", { max: 9999999.99 }) };
  } else if (has(f.peso_carga)) {
    fail(`PesoCarga não deve ser informado no encerramento de ${tipo === 2 ? "carga fracionada (regra B57)" : "TAC-Agregado (regra B62)"}`);
  }
  return p;
}

function montarConsultaCiot(id, ano) {
  const s = String(id ?? "");
  if (!/^[0-9A-Z]{12}$/.test(s)) fail("CodigoIdentificacaoOperacao deve ter 12 caracteres");
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
