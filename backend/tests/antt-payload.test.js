const assert = require("assert");
const P = require("../src/services/anttPayload");

const base = () => ({
  tipo_operacao: 1,
  contratado_doc: "529.982.247-25",
  contratado_rntrc: "12345678",
  contratante_doc: "11.222.333/0001-81",
  destinatario_doc: "52998224725",
  valor_frete: 1500.505,
  data_inicio_viagem: "2099-01-10",
  data_fim_viagem: "2099-01-12",
  veiculos: [{ placa: "abc-1d23", eixos: 3, rntrc: "123456789" }, { placa: "XYZ9876", eixos: 2 }],
  origem_destino: [{ origem: { municipio: "3550308" }, destino: { cep: "20040-020" }, distancia: 430.4 }],
  carga: { natureza: "0001", peso: 25000, tipo: 5 },
  indicadores: { retorno_vazio: true },
  pagamento: { forma_pagto: "PIX", chave_pix: "a@b.com", identificador_pix: "ID123" },
});
const ID = "000000000001";
const rejeita = (fn, re) => assert.throws(fn, (e) => e instanceof P.AnttValidationError && re.test(e.message));
let n = 0;
const t = (nome, fn) => { fn(); n++; console.log("ok -", nome); };

t("declaracao tipo 1 campos/tamanhos", () => {
  const p = P.montarDeclaracao(base(), ID, new Date("2099-01-01T15:00:00Z"));
  assert.strictEqual(p.IdOperacaoTransporte.length, 12);
  assert.strictEqual(p.TipoOperacao, 1);
  assert.strictEqual(p.CpfCnpjContratado, "52998224725");
  assert.strictEqual(p.RNTRCContratado, "012345678");
  assert.strictEqual(p.CpfCnpjContratante, "11222333000181");
  assert.strictEqual(p.ValorFrete, 1500.51);
  assert.strictEqual(p.DataDeclaracao, "2099-01-01T12:00:00");
  assert.strictEqual(p.IndContingencia, false);
  assert.ok(!("JustificativaContingencia" in p));
  assert.deepStrictEqual(p.Veiculos[0], { Placa: "ABC1D23", RNTRC: "123456789", NumeroEixos: "3" });
  assert.deepStrictEqual(p.OrigemDestino[0].Origem, { CodigoMunicipioOrigem: 3550308 });
  assert.deepStrictEqual(p.OrigemDestino[0].Destino, { CepDestino: "20040020" });
  assert.strictEqual(p.OrigemDestino[0].DistanciaPercorrida, 430);
  assert.deepStrictEqual(p.DadosCarga, { CodigoNaturezaCarga: 1, PesoCarga: 25000, CodigoTipoCarga: 5 });
  assert.deepStrictEqual(p.InfPagamento[0], {
    TipoPagamento: 6, ChavePix: "a@b.com", IdentificadorPix: "ID123", CpfCnpjCreditado: "52998224725", IndPagamento: 0,
  });
  assert.deepStrictEqual(p.InfIndicadoresOperacionais, { IndAltoDesempenho: false, IndRetornoVazio: true, ComposicaoVeicular: false });
});

t("tipo 3 sem destinatario/OD/carga", () => {
  const f = base();
  f.tipo_operacao = 3; delete f.destinatario_doc; delete f.origem_destino; delete f.carga;
  const p = P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z"));
  for (const k of ["CpfCnpjDestinatario", "OrigemDestino", "DadosCarga", "InfIndicadoresOperacionais"]) assert.ok(!(k in p), k);
  f.destinatario_doc = "52998224725";
  rejeita(() => P.montarDeclaracao(f, ID), /Destinatario/);
});

t("tipo 2 exige ContratantesCargFrac", () => {
  const f = base(); f.tipo_operacao = 2;
  rejeita(() => P.montarDeclaracao(f, ID), /ContratantesCargFrac/);
  f.carga.contratantes_frac = ["11222333000181"];
  const p = P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z"));
  assert.deepStrictEqual(p.DadosCarga.ContratantesCargFrac, ["11222333000181"]);
  assert.ok(!("InfIndicadoresOperacionais" in p));
});

t("validacoes de campo", () => {
  const com = (fn) => { const f = base(); fn(f); return () => P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z")); };
  rejeita(com((f) => (f.contratado_doc = "12345678900")), /CpfCnpjContratado/);
  rejeita(com((f) => (f.contratado_rntrc = "1234567")), /RNTRCContratado/);
  rejeita(com((f) => (f.valor_frete = 0)), /ValorFrete/);
  rejeita(com((f) => (f.veiculos[1].placa = "abc1d23")), /duplicada/);
  rejeita(com((f) => (f.veiculos[0].eixos = 5)), /NumeroEixos/);
  rejeita(com((f) => (f.data_fim_viagem = "2099-01-01")), /DataFimViagem/);
  rejeita(com((f) => (f.data_inicio_viagem = "2098-12-31")), /início/);
  rejeita(com((f) => (f.contingencia = true)), /Justificativa/);
  rejeita(com((f) => (f.justificativa_contingencia = "x")), /Justificativa/);
  rejeita(com((f) => (f.origem_destino[0].origem.municipio = "355030")), /IBGE/);
  rejeita(com((f) => (f.pagamento.chave_pix = "")), /ChavePix/);
  rejeita(com((f) => (f.carga.tipo = 13)), /CodigoTipoCarga/);
  rejeita(() => P.montarDeclaracao(base(), "123"), /12/);
});

t("pagamento por tipo (B92/B99/B105)", () => {
  const f = base(); f.pagamento = { forma_pagto: "TED", banco: "001", agencia: "1234", conta: "999-9" };
  const p = P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z")).InfPagamento[0];
  assert.strictEqual(p.TipoPagamento, 2);
  assert.strictEqual(p.CodigoInstituicaoFinanceira, 1);
  assert.strictEqual(p.NumeroAgencia, "1234");
  assert.ok(!("ChavePix" in p));
  f.pagamento.ind_pagamento = 1;
  rejeita(() => P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z")), /Parcela/);
  Object.assign(f.pagamento, { numero_parcela: 1, data_vencimento: "2099-02-01", valor_parcela: 100 });
  const q = P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z")).InfPagamento[0];
  assert.strictEqual(q.NumeroParcela, 1); assert.strictEqual(q.ValorParcela, 100);
});

t("cancelamento/encerramento/consultas", () => {
  const c = "0000000000011234";
  assert.deepStrictEqual(P.montarCancelamento(c, "erro"), { CodigoIdentificacaoOperacao: c, MotivoCancelamento: "erro" });
  rejeita(() => P.montarCancelamento("123", "x"), /16/);
  rejeita(() => P.montarCancelamento(c, "x".repeat(501)), /500/);
  assert.deepStrictEqual(P.montarEncerramento(c, 1, { peso_carga: 100 }), { CodigoIdentificacaoOperacao: c, DadosCarga: { PesoTotalCarga: 100 } });
  rejeita(() => P.montarEncerramento(c, 1, {}), /PesoCarga/);
  rejeita(() => P.montarEncerramento(c, 3, {}), /OrigemDestino/);
  const e = P.montarEncerramento(c, 3, { origem_destino: [{ origem: { municipio: 3550308 }, destino: { municipio: 3304557 }, distancia: 430, qtd_viagens: 4 }] });
  assert.strictEqual(e.OrigemDestino[0].QtdViagens, 4);
  assert.deepStrictEqual(P.montarConsultaCiot(ID, 2026), { CodigoIdentificacaoOperacao: ID, AnoDeclaracao: 2026 });
  const s = P.montarSituacao({ interessado: "11222333000181", transportador: "52998224725", rntrc: "12345678" });
  assert.deepStrictEqual(s, { CpfCnpjInteressado: "11222333000181", CpfCnpjTransportador: "52998224725", RNTRCTransportador: "012345678" });
  assert.deepStrictEqual(P.montarFrota({ ...{ interessado: "11222333000181", transportador: "52998224725", rntrc: "123456789" }, placas: ["abc1234"] }).Placas, ["ABC1234"]);
});

console.log(`${n} grupos ok`);

// Fluxo pendente/emitido/rejeitado do controller, com db e antt stubados (sem rede).
(async () => {
  const path = require("path");
  const rows = [];
  const stub = (rel, exp) => {
    const f = require.resolve(rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports: exp };
  };
  stub("../src/db", {
    all: (_t, p) => rows.filter(p),
    get: (_t, p) => rows.find(p),
    insert: (_t, r) => rows.push(r),
    update: (_t, p, patch) => rows.filter(p).forEach((r) => Object.assign(r, patch)),
  });
  stub("../src/services/audit", { audit() {} });
  const real = require("../src/services/antt");
  let declarar, consultar;
  stub("../src/services/antt", {
    verificarCertificado() {},
    AnttError: real.AnttError,
    modoAntt: () => true,
    ambiente: () => "homologacao",
    gerarIdOperacao: () => "000000000007",
    declarar: (p) => declarar(p),
    consultarCiotGerado: (p) => consultar(p),
  });
  const C = require("../src/controllers/ciotController");
  const mk = () => {
    const r = { code: 200 };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  const body = {
    contratante_nome: "X", contratante_doc: "11222333000181", motorista_nome: "M", motorista_cpf: "52998224725",
    placa: "ABC1D23", valor_contrato: 1000, destinatario_doc: "52998224725", contratado_rntrc: "12345678",
    data_inicio_viagem: "2099-01-10", data_fim_viagem: "2099-01-12",
    veiculos: [{ placa: "ABC1D23", eixos: 3 }],
    origem_destino: [{ origem: { municipio: "3550308" }, destino: { cep: "20040-020" }, distancia: 430 }],
    carga: { natureza: "0001", peso: 25000, tipo: 5 }, pagamento: {}, forma_pagto: "PIX", chave_pix: "a@b.com", identificador_pix: "ID1",
  };
  const req = (b, params) => ({ body: b, params: params || {}, user: { id: "u", empresa_id: "e" } });
  const emitir = async () => {
    const res = mk();
    await C.emitir(req(body), res);
    return res;
  };
  const last = () => rows[rows.length - 1];

  // timeout: fica pendente com id_operacao, 502
  declarar = async () => { throw new real.AnttError("Falha de comunicação com a ANTT: timeout"); };
  let res = await emitir();
  assert.strictEqual(res.code, 502);
  assert.strictEqual(last().status, "pendente");
  assert.strictEqual(last().id_operacao, "000000000007");

  // rejeicao definitiva
  declarar = async () => { throw new real.AnttError("ANTT 400: x", { codigo: "400", status: 400 }); };
  res = await emitir();
  assert.strictEqual(res.code, 400);
  assert.strictEqual(last().status, "rejeitado");

  // sem DV e consulta falha: pendente
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", Protocolo: "P1" });
  consultar = async () => { throw new real.AnttError("fora"); };
  res = await emitir();
  assert.strictEqual(res.code, 502);
  assert.strictEqual(last().status, "pendente");
  const pend = last();

  // consulta promove pendente a emitido
  consultar = async () => ({ CodigoIdentificacaoOperacao: "0000000000071234", Mensagem: "ok" });
  res = mk();
  await C.consultarGerado(req({}, { id: pend.id }), res);
  assert.strictEqual(pend.status, "emitido");
  assert.strictEqual(pend.numero, "0000000000071234");
  assert.strictEqual(pend.codigo_verificador, "1234");

  // sem DV na declaracao, mas consulta devolve: emitido com 16 chars
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", Protocolo: "P2" });
  res = await emitir();
  assert.strictEqual(res.code, 201);
  assert.strictEqual(last().numero, "0000000000071234");

  // DV na resposta
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", CodigoVerificador: 5 });
  res = await emitir();
  assert.strictEqual(res.code, 201);
  assert.strictEqual(last().numero, "0000000000070005");

  // listagem inclui pendente/rejeitado
  res = mk();
  C.listar({ query: {}, user: { empresa_id: "e" } }, res);
  assert.strictEqual(res.body.total, rows.length);
  console.log("pendente ok");
})().catch((e) => { console.error(e); process.exit(1); });
