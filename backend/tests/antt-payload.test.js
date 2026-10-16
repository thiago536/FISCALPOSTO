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
  origem_destino: [{ origem: { municipio: "3550308" }, destino: { municipio: "3304557" }, distancia: 430.4 }],
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
  assert.deepStrictEqual(p.OrigemDestino[0].Destino, { CodigoMunicipioDestino: 3304557 });
  assert.strictEqual(p.OrigemDestino[0].DistanciaPercorrida, 430);
  assert.deepStrictEqual(p.DadosCarga, { CodigoNaturezaCarga: 1, PesoCarga: 25000, CodigoTipoCarga: 5 });
  assert.deepStrictEqual(p.InfPagamento[0], {
    TipoPagamento: 6, ChavePix: "a@b.com", IdentificadorPix: "ID123", CpfCnpjCreditado: "52998224725", IndPagamento: 0,
  });
  assert.deepStrictEqual(p.InfIndicadoresOperacionais, { IndAltoDesempenho: false, IndRetornoVazio: true, ComposicaoVeicular: false });
});

t("tipo 3 (TAC-Agregado): só via IP, sem destinatario/OD/carga/DataInicioViagem (B27/B115/B56)", () => {
  const f = base();
  f.tipo_operacao = 3; delete f.destinatario_doc; delete f.origem_destino; delete f.carga;
  const agora = new Date("2099-01-01T15:00:00Z");
  rejeita(() => P.montarDeclaracao(f, ID, agora), /Instituição de Pagamento/);
  rejeita(() => P.montarDeclaracao(f, ID, agora, { ip: true }), /B56/);
  delete f.data_inicio_viagem;
  const p = P.montarDeclaracao(f, ID, agora, { ip: true });
  for (const k of ["CpfCnpjDestinatario", "OrigemDestino", "DadosCarga", "InfIndicadoresOperacionais", "DataInicioViagem"]) assert.ok(!(k in p), k);
  f.data_fim_viagem = "2099-02-15";
  rejeita(() => P.montarDeclaracao(f, ID, agora, { ip: true }), /30 dias.*B30/);
  f.data_fim_viagem = "2099-01-12";
  f.destinatario_doc = "52998224725";
  rejeita(() => P.montarDeclaracao(f, ID, agora, { ip: true }), /Destinatario/);
});

t("B115: sem IP, contratado deve ser o CNPJ do certificado", () => {
  const agora = new Date("2099-01-01T15:00:00Z");
  rejeita(() => P.montarDeclaracao(base(), ID, agora, { emissorDoc: "11444777000161" }), /B115/);
  const f = base(); f.contratado_doc = "11.444.777/0001-61";
  assert.strictEqual(P.montarDeclaracao(f, ID, agora, { emissorDoc: "11444777000161" }).CpfCnpjContratado, "11444777000161");
  // Instituição de Pagamento declara para terceiros: B115 não se aplica.
  assert.strictEqual(P.montarDeclaracao(base(), ID, agora, { ip: true, emissorDoc: "11444777000161" }).CpfCnpjContratado, "52998224725");
});

t("localização: mais específica vai sozinha; tipos iguais (B109/B110/B111)", () => {
  const agora = new Date("2099-01-01T15:00:00Z");
  const f = base();
  f.origem_destino = [{ origem: { municipio: "3550308", cep: "01001-000" }, destino: { cep: "20040-020" }, distancia: 430 }];
  const p = P.montarDeclaracao(f, ID, agora);
  assert.deepStrictEqual(p.OrigemDestino[0].Origem, { CepOrigem: "01001000" });
  assert.deepStrictEqual(p.OrigemDestino[0].Destino, { CepDestino: "20040020" });
  f.origem_destino = [{ origem: { latitude: -7.115, longitude: -34.8631, cep: "58000000" }, destino: { latitude: "-23.55", longitude: "-46.63" }, distancia: 2700 }];
  assert.deepStrictEqual(P.montarDeclaracao(f, ID, agora).OrigemDestino[0].Origem, { LatitudeOrigem: -7.115, LongitudeOrigem: -34.8631 });
  f.origem_destino = [{ origem: { municipio: "3550308" }, destino: { cep: "20040-020" }, distancia: 430 }];
  rejeita(() => P.montarDeclaracao(f, ID, agora), /B111/);
  f.origem_destino = [{ origem: { latitude: -7.1 }, destino: { latitude: -7.2, longitude: -35 }, distancia: 1 }];
  rejeita(() => P.montarDeclaracao(f, ID, agora), /juntas/);
  f.origem_destino = [{ origem: {}, destino: { cep: "20040020" }, distancia: 1 }];
  rejeita(() => P.montarDeclaracao(f, ID, agora), /informe município/);
});

t("datas e limites (B6/B13/B21/B22/B49/B119)", () => {
  const agora = new Date("2099-01-01T15:00:00Z");
  const com = (fn) => { const f = base(); fn(f); return () => P.montarDeclaracao(f, ID, agora); };
  rejeita(com((f) => { f.data_inicio_viagem = "2099-02-01"; f.data_fim_viagem = "2099-02-02"; }), /B22/);
  rejeita(com((f) => (f.data_fim_viagem = "2099-04-15")), /90 dias.*B21/);
  P.montarDeclaracao(Object.assign(base(), { data_inicio_viagem: "2099-01-31", data_fim_viagem: "2099-04-30" }), ID, agora); // 30 e 89 dias: aceito
  rejeita(com((f) => (f.veiculos = ["AAA1111", "AAA1112", "AAA1113", "AAA1114", "AAA1115", "AAA1116"].map((placa) => ({ placa, eixos: 2 })))), /B49/);
  const fr = base(); fr.tipo_operacao = 2; fr.carga.contratantes_frac = ["11222333000181"]; fr.contratante_doc = "11222333000181";
  rejeita(() => P.montarDeclaracao(fr, ID, agora), /B119/);
});

t("pagamento: cartão IP só com IP (B118); CodigoPagamento longo sem perda", () => {
  const agora = new Date("2099-01-01T15:00:00Z");
  const f = base(); f.pagamento = { forma_pagto: "CARTAO", banco: "001", conta: "123" };
  rejeita(() => P.montarDeclaracao(f, ID, agora), /B118/);
  assert.strictEqual(P.montarDeclaracao(f, ID, agora, { ip: true }).InfPagamento[0].TipoPagamento, 1);
  const boleto = "23793381286000000000300000000401847340000010000"; // 47 dígitos
  const g = base(); g.pagamento.codigo_pagamento = boleto;
  assert.strictEqual(P.montarDeclaracao(g, ID, agora).InfPagamento[0].CodigoPagamento, boleto);
  g.pagamento.codigo_pagamento = "12345";
  assert.strictEqual(P.montarDeclaracao(g, ID, agora).InfPagamento[0].CodigoPagamento, 12345);
});

t("tipo 2 exige ContratantesCargFrac", () => {
  const f = base(); f.tipo_operacao = 2;
  rejeita(() => P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z")), /ContratantesCargFrac/);
  f.carga.contratantes_frac = ["11444777000161"]; // diferente do contratante (B119)
  const p = P.montarDeclaracao(f, ID, new Date("2099-01-01T15:00:00Z"));
  assert.deepStrictEqual(p.DadosCarga.ContratantesCargFrac, ["11444777000161"]);
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
  rejeita(() => P.montarEncerramento(c, 2, { peso_carga: 10 }), /B57/);
  assert.deepStrictEqual(P.montarEncerramento(c, 2, {}), { CodigoIdentificacaoOperacao: c });
  rejeita(() => P.montarEncerramento(c, 1, { peso_carga: 10, origem_destino: [{ origem: { municipio: 3550308 }, destino: { municipio: 3304557 } }] }), /B44/);
  const e = P.montarEncerramento(c, 3, { origem_destino: [{ origem: { municipio: 3550308 }, destino: { municipio: 3304557 }, distancia: 430, qtd_viagens: 4 }] });
  assert.strictEqual(e.OrigemDestino[0].QtdViagens, 4);
  rejeita(() => P.montarEncerramento(c, 3, { peso_carga: 1, origem_destino: [{ origem: { municipio: 3550308 }, destino: { municipio: 3304557 }, distancia: 430, qtd_viagens: 4 }] }), /B62/);
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
  const trilhas = [];
  stub("../src/services/audit", { audit() {}, auditFiscal: (r) => trilhas.push(r) });
  process.env.ANTT_ID_MODO = "sequencial_experimental";
  let emAntt = true;
  const real = require("../src/services/antt");
  t("classificacao da resposta (so 110/111 sao sucesso)", () => {
    assert.strictEqual(real.classificar(200, { Codigo: "110", Mensagem: "Dados inseridos" }).ok, true);
    assert.strictEqual(real.classificar(200, { Codigo: ["111"] }).ok, true);
    assert.strictEqual(real.classificar(200, { Codigo: "200" }).tipo, "rejeicao"); // 200 nao existe no manual
    assert.deepStrictEqual(
      [real.classificar(200, { Codigo: ["205"], Mensagem: ["x"] }).tipo, real.classificar(200, { Codigo: ["205"] }).codigo],
      ["rejeicao", "205"]
    );
    assert.strictEqual(real.classificar(400, { Codigo: "321" }).tipo, "rejeicao");
    assert.strictEqual(real.classificar(403, null).tipo, "configuracao"); // acesso barrado antes da aplicação
    assert.strictEqual(real.classificar(401, { Message: "x" }).tipo, "configuracao");
    assert.strictEqual(real.classificar(403, { Codigo: ["311"] }).tipo, "rejeicao"); // regra da ANTT
    assert.strictEqual(real.classificar(200, { Codigo: ["999"], Mensagem: ["desconhecido"] }).tipo, "rejeicao"); // código desconhecido nunca é sucesso
    assert.strictEqual(real.classificar(200, { Codigo: ["110", "205"] }).ok, false); // sucesso misturado com rejeição
    assert.strictEqual(real.classificar(500, null).tipo, "indeterminado");
    assert.strictEqual(real.classificar(408, null).tipo, "indeterminado");
    assert.strictEqual(real.classificar(429, null).tipo, "indeterminado");
    assert.strictEqual(real.classificar(404, { Message: "No HTTP resource" }).tipo, "configuracao");
    assert.strictEqual(real.classificar(400, null).tipo, "rejeicao");
    assert.strictEqual(real.classificar(503, { Codigo: "205" }).tipo, "indeterminado");
    assert.strictEqual(real.classificar(200, { Protocolo: "1" }).tipo, "indeterminado"); // 2xx sem Codigo
    assert.strictEqual(real.classificar(200, null).tipo, "indeterminado"); // JSON invalido
    assert.strictEqual(real.cnpjDoSubject("C=BR\nCN=EMPRESA LTDA:11222333000181"), "11222333000181");
    assert.strictEqual(real.cnpjDoSubject("CN=Fulano"), null);
    // Formato real da homologação (15/10/2026): Codigo string e Mensagem = string com array JSON.
    const hml = { Codigo: "220", Mensagem: "[\"Rejeição: Não foi encontrada nenhuma Operação de Transporte com os dados informados.\",\"O CPF/CNPJ do certificado digital não corresponde ao transportador responsável pelo CIOT informado e, por isso, não possui permissão para realizar a operação.\"]" };
    const ch = real.classificar(200, hml);
    assert.deepStrictEqual([ch.tipo, ch.codigo], ["rejeicao", "220"]);
    assert.match(ch.mensagem, /^Rejeição: Não foi encontrada .* \| O CPF\/CNPJ do certificado/);
    assert.strictEqual(real.textoMensagem("[texto comum"), "[texto comum");
    assert.strictEqual(real.textoMensagem(["a ", "b"]), "a | b");
  });
  let declarar, consultar;
  stub("../src/services/antt", {
    verificarCertificado: () => ({ cnpj: null }),
    AnttError: real.AnttError,
    textoMensagem: real.textoMensagem,
    modoAntt: () => emAntt,
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
  const diaSP = (n) => P.dataHora(new Date(Date.now() + n * 86400000)).slice(0, 10);
  const body = {
    contratante_nome: "X", contratante_doc: "11222333000181", motorista_nome: "M", motorista_cpf: "52998224725",
    contratado_doc: "11444777000161",
    placa: "ABC1D23", valor_contrato: 1000, destinatario_doc: "52998224725", contratado_rntrc: "12345678",
    // Datas relativas a hoje: B22 limita o início a 30 dias da declaração.
    data_inicio_viagem: diaSP(1), data_fim_viagem: diaSP(3),
    veiculos: [{ placa: "ABC1D23", eixos: 3 }],
    origem_destino: [{ origem: { municipio: "3550308" }, destino: { municipio: "3304557" }, distancia: 430 }],
    carga: { natureza: "0001", peso: 25000, tipo: 5 }, pagamento: {}, forma_pagto: "PIX", chave_pix: "a@b.com", identificador_pix: "ID1",
  };
  const req = (b, params) => ({ body: b, params: params || {}, user: { id: "u", empresa_id: "e" }, correlacao: "corr-1" });
  const emitir = async () => {
    const res = mk();
    await C.emitir(req(body), res);
    return res;
  };
  const last = () => rows[rows.length - 1];

  // timeout: fica pendente com id_operacao, 502
  // modo local: simulacao explicita
  emAntt = false;
  let res = await emitir();
  assert.strictEqual(res.code, 201);
  assert.strictEqual(res.body.simulado, true);
  assert.match(res.body.aviso, /sem validade legal/);
  assert.strictEqual(last().provider, "local");
  assert.strictEqual(last().simulado, true);
  emAntt = true;

  declarar = async () => { throw new real.AnttError("Falha de comunicação com a ANTT: timeout"); };
  res = await emitir();
  assert.strictEqual(res.code, 502);
  assert.strictEqual(res.body.proxima_acao, "consultar");
  assert.strictEqual(res.body.id_experimental, true);
  assert.strictEqual(last().id_experimental, true);
  assert.strictEqual(last().status, "pendente");
  assert.strictEqual(last().id_operacao, "000000000007");

  // rejeicao definitiva
  declarar = async () => { throw new real.AnttError("ANTT 205: x", { tipo: "rejeicao", codigo: "205", status: 200 }); };
  res = await emitir();
  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.body.codigo, "205");
  assert.strictEqual(last().status, "rejeitado");

  // sem DV e consulta falha: pendente
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", Protocolo: "P1" });
  consultar = async () => { throw new real.AnttError("fora", { tipo: "indeterminado" }); };
  res = await emitir();
  assert.strictEqual(res.code, 502);
  assert.strictEqual(last().status, "pendente");
  const pend = last();

  // consulta com codigo de outro ID nao promove
  consultar = async () => ({ CodigoIdentificacaoOperacao: "0000000000991234" });
  res = mk();
  await C.consultarGerado(req({}, { id: pend.id }), res);
  assert.strictEqual(res.code, 502);
  assert.strictEqual(pend.status, "pendente");

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

  // DV na resposta como string de 4 caracteres: aceito como veio
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", CodigoVerificador: "0005", Codigo: "110" });
  res = await emitir();
  assert.strictEqual(res.code, 201);
  assert.strictEqual(last().numero, "0000000000070005");

  // DV numérico (5): não completamos zeros por conta própria; o CIOT vem da consulta
  let consultas = 0;
  declarar = async () => ({ IdOperacaoTransporte: "000000000007", CodigoVerificador: 5, Codigo: "110" });
  consultar = async () => { consultas++; return { CodigoIdentificacaoOperacao: "0000000000070005", Codigo: ["111"] }; };
  res = await emitir();
  assert.strictEqual(res.code, 201);
  assert.strictEqual(consultas, 1);
  assert.strictEqual(last().numero, "0000000000070005");

  // listagem inclui pendente/rejeitado
  res = mk();
  C.listar({ query: {}, user: { empresa_id: "e" } }, res);
  assert.strictEqual(res.body.total, rows.length);
  for (const r of res.body.data) assert.strictEqual(r.oficial, r.provider === "antt" && r.status === "emitido");
  assert.ok(res.body.data.some((r) => r.status === "pendente" && r.oficial === false));
  assert.ok(trilhas.every((a) => a.correlacao === "corr-1" && a.entidade === "ciot"));
  assert.ok(trilhas.some((a) => a.status_anterior === "pendente" && a.status_novo === "emitido" && a.provedor === "antt"));
  console.log("pendente ok");
})().catch((e) => { console.error(e); process.exit(1); });
