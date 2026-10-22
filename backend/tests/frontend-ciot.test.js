// Testes das funções puras do frontend (sem navegador, sem rede, sem servidor).
// Roda: npm run test:frontend
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRONT = path.join(__dirname, "..", "..", "frontend");
const { esc, fmt } = require(path.join(FRONT, "src", "esc.js"));
const C = require(path.join(FRONT, "src", "ciot.js"));
const P = require("../src/services/anttPayload");

const EMP = "11222333000181"; // CNPJ fictício dos testes
const XSS = "<img src=x onerror=alert(1)>";

// dadosAntt não é exportado pelo controller: extrai a função do código-fonte real para
// pegar divergência de nomes de campo entre o corpo do front e o que o backend lê.
const srcCtrl = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "ciotController.js"), "utf8");
const mDados = srcCtrl.match(/function dadosAntt\([\s\S]*?\n}\n/);
assert.ok(mDados, "função dadosAntt não encontrada no controller");
const dadosAntt = new Function(`return ${mDados[0]}`)();

let n = 0;
const t = (nome, fn) => { fn(); n++; console.log("ok -", nome); };

const hoje = C.hojeSP();
const campos = (extra = {}) => ({
  tipo_operacao: 1,
  id_operacao: "adm000000001",
  contratante_nome: "CLIENTE CONTRATANTE LTDA",
  contratante_doc: "11444777000161",
  contratado_doc: EMP,
  contratado_rntrc: "12345678",
  destinatario_doc: "52998224725",
  motorista_nome: "MOTORISTA",
  motorista_cpf: "52998224725",
  valor_contrato: "1000",
  valor_adiantamento: "0",
  veiculos: [{ placa: "abc1d23", eixos: "3", rntrc: "" }, { placa: "XYZ9A88", eixos: "3", rntrc: "" }],
  data_inicio_viagem: C.somarDias(hoje, 1),
  data_fim_viagem: C.somarDias(hoje, 3),
  tipo_localizacao: "municipio",
  trechos: [{ origem: { municipio: "2507507" }, destino: { municipio: "3550308" }, distancia: "2700" }],
  carga_natureza: "0001",
  carga_tipo: "5",
  carga_peso: "25000",
  tipo_pagamento: "6",
  chave_pix: "a@b.com",
  identificador_pix: "ID1",
  ind_pagamento: "0",
  ...extra,
});
const declara = (b) => P.montarDeclaracao(dadosAntt(b, b.valor_contrato, EMP), b.id_operacao, new Date(), { emissorDoc: EMP });

t("esc neutraliza HTML e aspas", () => {
  assert.strictEqual(esc(XSS), "&lt;img src=x onerror=alert(1)&gt;");
  assert.ok(!esc(XSS).includes("<"));
  assert.strictEqual(esc(`"a" 'b' &`), "&quot;a&quot; &#39;b&#39; &amp;");
  assert.strictEqual(esc(null), "");
  assert.strictEqual(esc(undefined), "");
});

t("fmt escapa e formata", () => {
  assert.strictEqual(fmt(null), "—");
  assert.strictEqual(fmt(XSS).includes("<"), false);
  assert.strictEqual(fmt("2026-10-17T10:00:00Z", "date"), "17/10/2026");
  assert.match(fmt(1234.5, "money"), /R\$ 1\.234,50/);
});

t("montarCorpoCiotAntt gera corpo aceito por montarDeclaracao (nomes de campo batem)", () => {
  const b = C.montarCorpoCiotAntt(campos());
  assert.strictEqual(b.id_operacao, "ADM000000001");
  assert.strictEqual(b.placa, "abc1d23"); // 1ª placa declarada (legado)
  const d = declara(b);
  assert.strictEqual(d.IdOperacaoTransporte, "ADM000000001");
  assert.strictEqual(d.CpfCnpjContratado, EMP);
  assert.strictEqual(d.RNTRCContratado, "012345678");
  assert.strictEqual(d.Veiculos.length, 2);
  assert.strictEqual(d.OrigemDestino[0].Origem.CodigoMunicipioOrigem, 2507507);
  assert.strictEqual(d.OrigemDestino[0].DistanciaPercorrida, 2700);
  assert.strictEqual(d.DadosCarga.CodigoTipoCarga, 5);
  assert.strictEqual(d.InfPagamento[0].TipoPagamento, 6);
  assert.strictEqual(d.ValorFrete, 1000);
  assert.ok(d.InfIndicadoresOperacionais);
});

t("B111: um tipo de localização vale para origem e destino (CEP e coordenadas)", () => {
  const cheio = { municipio: "2507507", cep: "58000000", latitude: "-7.1", longitude: "-34.8" };
  const cheio2 = { municipio: "3550308", cep: "01000000", latitude: "-23.5", longitude: "-46.6" };
  const cep = C.montarCorpoCiotAntt(campos({ tipo_localizacao: "cep", trechos: [{ origem: cheio, destino: cheio2, distancia: 10 }] }));
  assert.deepStrictEqual(cep.origem_destino[0].origem, { cep: "58000000" });
  assert.deepStrictEqual(cep.origem_destino[0].destino, { cep: "01000000" });
  const d = declara(cep);
  assert.strictEqual(d.OrigemDestino[0].Origem.CepOrigem, "58000000");
  const co = C.montarCorpoCiotAntt(campos({ tipo_localizacao: "coordenadas", trechos: [{ origem: cheio, destino: cheio2, distancia: 10 }] }));
  assert.deepStrictEqual(Object.keys(co.origem_destino[0].origem).sort(), ["latitude", "longitude"]);
  assert.deepStrictEqual(Object.keys(co.origem_destino[0].destino).sort(), ["latitude", "longitude"]);
  assert.ok(declara(co).OrigemDestino[0].Origem.LatitudeOrigem !== undefined);
});

t("tipo 2 não manda indicadores; tipo 1 manda", () => {
  const b2 = C.montarCorpoCiotAntt(campos({ tipo_operacao: 2, alto_desempenho: true, contratantes_frac: "52998224725\n11222333000181" }));
  assert.strictEqual(b2.indicadores, undefined);
  assert.deepStrictEqual(b2.carga.contratantes_frac, ["52998224725", "11222333000181"]);
  const d2 = declara(b2);
  assert.strictEqual(d2.InfIndicadoresOperacionais, undefined);
  assert.strictEqual(d2.DadosCarga.ContratantesCargFrac.length, 2);
  const b1 = C.montarCorpoCiotAntt(campos({ alto_desempenho: true, contratantes_frac: "52998224725" }));
  assert.deepStrictEqual(b1.indicadores, { alto_desempenho: true, retorno_vazio: false, composicao_veicular: false });
  assert.strictEqual(b1.carga.contratantes_frac, undefined);
  assert.strictEqual(declara(b1).InfIndicadoresOperacionais.IndAltoDesempenho, true);
});

t("pagamento condicional: banco só em 2-4, parcela só se a prazo", () => {
  const cc = C.montarCorpoCiotAntt(campos({ tipo_pagamento: "2", banco: "001", agencia: "1234", conta: "5678-9", chave_pix: "x", identificador_pix: "y" }));
  assert.strictEqual(cc.chave_pix, undefined);
  assert.strictEqual(cc.banco, "001");
  assert.strictEqual(declara(cc).InfPagamento[0].NumeroConta, "5678-9");
  const pz = C.montarCorpoCiotAntt(campos({ ind_pagamento: "1", numero_parcela: "1", data_vencimento: C.somarDias(hoje, 5), valor_parcela: "500" }));
  assert.strictEqual(declara(pz).InfPagamento[0].IndPagamento, 1);
  const avista = C.montarCorpoCiotAntt(campos({ numero_parcela: "1", valor_parcela: "5" }));
  assert.strictEqual(avista.numero_parcela, undefined);
  assert.strictEqual(declara(avista).InfPagamento[0].NumeroParcela, undefined);
});

t("contingência manda justificativa; fora dela não", () => {
  const sem = C.montarCorpoCiotAntt(campos({ justificativa_contingencia: "x" }));
  assert.strictEqual(sem.contingencia, undefined);
  assert.strictEqual(sem.justificativa_contingencia, undefined);
  const com = C.montarCorpoCiotAntt(campos({ contingencia: true, justificativa_contingencia: "Sistema da ANTT fora do ar" }));
  assert.strictEqual(declara(com).IndContingencia, true);
});

t("entrada_antt volta ao formulário e gera o mesmo corpo (reenvio com o mesmo ID)", () => {
  const b = C.montarCorpoCiotAntt(campos({ alto_desempenho: true }));
  const entrada = { ...dadosAntt(b, b.valor_contrato, EMP), contratante_nome: b.contratante_nome, motorista_nome: b.motorista_nome, motorista_cpf: b.motorista_cpf, valor_contrato: b.valor_contrato, valor_adiantamento: 0, id_operacao: b.id_operacao };
  const { campos: c2, avisos } = C.camposDeEntrada(entrada);
  assert.deepStrictEqual(avisos, []);
  assert.strictEqual(c2.id_operacao, "ADM000000001");
  assert.strictEqual(c2.tipo_localizacao, "municipio");
  assert.strictEqual(c2.carga_natureza, "0001");
  const b2 = C.montarCorpoCiotAntt(c2);
  assert.deepStrictEqual(b2.origem_destino, b.origem_destino);
  assert.deepStrictEqual(b2.veiculos.map((v) => v.placa), b.veiculos.map((v) => v.placa));
  assert.strictEqual(b2.tipo_pagamento, 6);
  assert.strictEqual(b2.chave_pix, "a@b.com");
  assert.strictEqual(b2.indicadores.alto_desempenho, true);
});

t("reenvio revalida datas: início passado é limpo com aviso", () => {
  const r = C.camposDeEntrada({ data_inicio_viagem: C.somarDias(hoje, -2), data_fim_viagem: C.somarDias(hoje, 3), tipo_operacao: 1 });
  assert.strictEqual(r.campos.data_inicio_viagem, "");
  assert.strictEqual(r.campos.data_fim_viagem, C.somarDias(hoje, 3));
  assert.strictEqual(r.avisos.length, 1);
});

t("validarCiotAntt: válido não tem erros; casos B5/B6/B13/B21/B49/B119/ID", () => {
  assert.deepStrictEqual(C.validarCiotAntt(campos()), []);
  const erros = (extra, o) => C.validarCiotAntt(campos(extra), o).join(" | ");
  assert.match(erros({ id_operacao: "ABC" }), /id_operacao/);
  assert.deepStrictEqual(C.validarCiotAntt(campos({ id_operacao: "" }), { idModo: "sequencial_experimental" }), []);
  assert.match(erros({ veiculos: [{ placa: "ABC1D23", eixos: 2 }, { placa: "abc-1d23", eixos: 2 }] }), /repetida/);
  assert.match(erros({ veiculos: Array.from({ length: 6 }, (_, i) => ({ placa: "AAA000" + i, eixos: 2 })) }), /5 veículos/);
  assert.match(erros({ data_inicio_viagem: C.somarDias(hoje, -1) }), /B6/);
  assert.match(erros({ data_inicio_viagem: C.somarDias(hoje, 31), data_fim_viagem: C.somarDias(hoje, 32) }), /B22/);
  assert.match(erros({ data_fim_viagem: hoje, data_inicio_viagem: C.somarDias(hoje, 1) }), /B13/);
  assert.match(erros({ data_fim_viagem: C.somarDias(hoje, 100), data_inicio_viagem: hoje }), /B21/);
  assert.match(erros({ tipo_operacao: 2, contratantes_frac: "11.444.777/0001-61" }), /B119/);
  assert.match(erros({ tipo_operacao: 3 }), /TAC-Agregado/);
  assert.match(erros({ contingencia: true }), /Justificativa/);
  assert.match(erros({ contratado_rntrc: "123" }), /RNTRC/);
});

t("acoesCiot: matriz por provider/status", () => {
  const ids = (c) => C.acoesCiot(c).map((a) => a.id).join(",");
  const A = (status, extra = {}) => ({ provider: "antt", status, ...extra });
  assert.strictEqual(ids(A("pendente")), "consultar");
  assert.strictEqual(ids(A("emitido")), "consultar,encerrar,cancelar");
  assert.strictEqual(ids(A("emitido", { mdfe_id: "m1", mdfe_status: "autorizada" })), "consultar,encerrar");
  for (const s of ["rejeitado", "nao_enviado", "nao_registrado"]) assert.strictEqual(ids(A(s)), "reenviar", s);
  assert.strictEqual(ids(A("cancelado")), "");
  assert.strictEqual(ids(A("encerrado")), "");
  const rc = C.acoesCiot(A("emitido", { operacao_pendente: { tipo: "cancelamento" } }));
  assert.deepStrictEqual(rc.map((a) => a.rotulo), ["Consultar na ANTT", "Repetir cancelamento"]);
  const re = C.acoesCiot(A("emitido", { operacao_pendente: { tipo: "encerramento" } }));
  assert.deepStrictEqual(re.map((a) => a.rotulo), ["Consultar na ANTT", "Repetir encerramento"]);
  // local: só cancelar quando emitido, sem consulta/encerrar
  assert.strictEqual(ids({ provider: "local", status: "emitido" }), "cancelar");
  assert.strictEqual(ids({ status: "emitido" }), "cancelar");
  assert.strictEqual(ids({ provider: "local", status: "cancelado" }), "");
  assert.strictEqual(ids({ provider: "local", status: "emitido", mdfe_id: "m", mdfe_status: "autorizada" }), "");
  assert.strictEqual(ids(null), "");
});

t("rotuloStatusCiot cobre os 7 status", () => {
  const esperado = {
    pendente: "Pendente (sem CIOT)", emitido: "Emitido", rejeitado: "Rejeitado", nao_enviado: "Não enviado",
    nao_registrado: "Não registrado", cancelado: "Cancelado", encerrado: "Encerrado",
  };
  for (const [s, r] of Object.entries(esperado)) {
    assert.strictEqual(C.rotuloStatusCiot(s), r);
    assert.ok(C.explicacaoStatusCiot(s).length > 10, s);
  }
  assert.strictEqual(C.classeStatusCiot("pendente"), "amber");
  assert.ok(C.textoProximaAcao("reenviar_mesmo_id").includes("MESMO"));
});

t("detalheCiotHtml escapa todo dado do servidor", () => {
  const c = {
    id: "1", provider: "antt", status: "rejeitado", ambiente: "homologacao",
    mensagem_antt: XSS, codigo_antt: XSS, contratante_nome: XSS, motorista_nome: XSS, id_operacao: XSS,
    placa: XSS, veiculos: [{ placa: XSS, eixos: 3 }], protocolo: XSS, contratado_doc: XSS, mdfe_id: XSS,
    payload_declaracao: { x: XSS }, resposta_antt: { Mensagem: XSS }, resposta_consulta: XSS,
    operacao_pendente: { tipo: XSS, mensagem: XSS }, proxima_acao: XSS,
  };
  const html = C.detalheCiotHtml(c);
  assert.ok(!html.includes("<img"), "html não escapado");
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("não é CIOT"));
  assert.ok(html.includes('data-ciot-acao="reenviar"'));
});

t("detalheCiotHtml: número só quando oficial ou simulado", () => {
  const pend = C.detalheCiotHtml({ provider: "antt", status: "pendente", id_operacao: "ADM000000001", numero: "NAO_DEVERIA_APARECER" });
  assert.ok(!pend.includes("NAO_DEVERIA_APARECER"));
  assert.ok(pend.includes("ADM000000001"));
  const ok = C.detalheCiotHtml({ provider: "antt", status: "emitido", oficial: true, numero: "ADM0000000019999" });
  assert.ok(ok.includes("ADM0000000019999"));
  const sim = C.detalheCiotHtml({ provider: "local", status: "emitido", simulado: true, numero: "123" });
  assert.ok(sim.includes("SIMULADO"));
});

t("formulário e faixa escapam valores (pré-preenchimento, erro de certificado)", () => {
  const html = C.formCiotAnttHtml({ id_modo: "manual", empresa_cnpj: XSS }, { contratante_nome: XSS, veiculos: [{ placa: XSS, eixos: 2 }], trechos: [{ origem: { municipio: XSS }, destino: {} }] }, { avisos: [XSS] });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("TAC-Agregado"));
  assert.match(html, /<option value="3"[^>]*disabled/);
  const f = C.faixaCiot({ ambiente: "homologacao", id_modo: "manual", certificado: { ok: false, erro: XSS } });
  assert.ok(!f.html.includes("<img"));
  assert.strictEqual(f.bloqueio, XSS);
  const ok = C.faixaCiot({ ambiente: "homologacao", certificado: { ok: true, cnpj: EMP, valido_ate: "2027-07-13T00:00:00Z", icp_brasil: true } });
  assert.strictEqual(ok.bloqueio, null);
  assert.ok(ok.html.includes("HOMOLOGAÇÃO") && ok.html.includes("sem validade jurídica"));
  assert.ok(C.faixaCiot({ ambiente: "homologacao", id_modo: null, erro_config: "ANTT_ID_MODO inválido", certificado: { ok: true } }).bloqueio);
  // modo sequencial: sem campo id_operacao, com aviso
  const seq = C.formCiotAnttHtml({ id_modo: "sequencial_experimental" }, {});
  assert.ok(!seq.includes('name="id_operacao"') && seq.includes("EXPERIMENTAL"));
});

t("Idempotency-Key: formato aceito pelo servidor e regeneração", () => {
  const re = /^[A-Za-z0-9-]{8,100}$/;
  assert.match(C.novaChaveIdempotencia(), re);
  assert.match(C.novaChaveIdempotencia({}), re); // sem crypto
  assert.match(C.novaChaveIdempotencia({ getRandomValues: (a) => { a.fill(7); return a; } }), re);
  assert.notStrictEqual(C.novaChaveIdempotencia(), C.novaChaveIdempotencia());
  const err = (status, data) => Object.assign(new Error("x"), { status, data });
  assert.strictEqual(C.deveRegenerarChave(new Error("rede")), false); // sem resposta
  assert.strictEqual(C.deveRegenerarChave(err(502, { status: "pendente" })), false);
  assert.strictEqual(C.deveRegenerarChave(err(500, {})), false);
  assert.strictEqual(C.deveRegenerarChave(err(400, {})), true); // validação
  assert.strictEqual(C.deveRegenerarChave(err(400, { status: "rejeitado" })), true);
  assert.strictEqual(C.deveRegenerarChave(err(503, { status: "nao_enviado" })), true);
});

t("detalhe: ANTT cancelado/encerrado mostra o número do CIOT", () => {
  for (const status of ["cancelado", "encerrado"]) {
    const h = C.detalheCiotHtml({ provider: "antt", status, numero: "1234567890123456", id_operacao: "ADM000000001", oficial: false });
    assert.ok(h.includes("1234567890123456") && !h.includes("não é CIOT"), status);
  }
  const p = C.detalheCiotHtml({ provider: "antt", status: "pendente", numero: "1234567890123456", id_operacao: "ADM000000001" });
  assert.ok(p.includes("não é CIOT"));
});

t("data_inicio_viagem guarda janela em data-min/data-max para a contingência", () => {
  const h = C.formCiotAnttHtml({ id_modo: "manual" }, {});
  const m = h.match(/<input[^>]*name="data_inicio_viagem"[^>]*>/);
  assert.ok(m && m[0].includes(`min="${hoje}"`) && m[0].includes(`data-min="${hoje}"`) && m[0].includes("data-max="), "input");
  const app = fs.readFileSync(path.join(FRONT, "src", "app.js"), "utf8");
  assert.ok(app.includes("aplicarJanelaData") && app.includes("removeAttribute(k)"), "app.js remove min/max na contingência");
});

t("acoesCiot: Cancelar só some com MDF-e autorizada", () => {
  const ids = (c) => C.acoesCiot(c).map((a) => a.id);
  assert.ok(ids({ provider: "antt", status: "emitido", mdfe_id: "m1", mdfe_status: "rejeitada" }).includes("cancelar"));
  assert.ok(ids({ provider: "antt", status: "emitido", mdfe_id: "m1", mdfe_status: "autorizada" }).every((i) => i !== "cancelar"));
  assert.ok(ids({ provider: "local", status: "emitido", mdfe_id: "m1", mdfe_status: "encerrada" }).includes("cancelar"));
  assert.deepStrictEqual(ids({ provider: "local", status: "emitido", mdfe_id: "m1", mdfe_status: "autorizada" }), []);
});

t("app.js, ciot.js e esc.js têm sintaxe válida e index.html carrega na ordem certa", () => {
  for (const f of ["app.js", "ciot.js", "esc.js"]) new vm.Script(fs.readFileSync(path.join(FRONT, "src", f), "utf8"), { filename: f });
  const html = fs.readFileSync(path.join(FRONT, "index.html"), "utf8");
  const ordem = ["src/esc.js", "src/ciot.js", "src/app.js"].map((s) => html.indexOf(`<script src="${s}">`));
  assert.ok(ordem.every((i) => i > 0) && ordem[0] < ordem[1] && ordem[1] < ordem[2], "ordem dos scripts");
  assert.ok(!/function esc\(/.test(fs.readFileSync(path.join(FRONT, "src", "app.js"), "utf8")), "app.js não deve redefinir esc");
});

console.log(`\n${n} testes de frontend OK`);
