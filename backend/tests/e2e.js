/**
 * Teste end-to-end real do PostoFiscal.
 * Requer o servidor rodando. Uso:
 *   node tests/e2e.js
 *   BASE_URL=http://192.168.0.105:3001 node tests/e2e.js
 */
const assert = require("node:assert");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");

const state = {
  token: null,
  empresa: null,
  produtos: [],
  clienteId: null,
  baseDash: null,
  nfe1: null,
  nfe1Itens: [],
  nfeA: null,
  nfeB: null,
  cte: null,
  ciot: null,
  mdfe: null,
};

// ---------------------------------------------------------------- infra

async function req(method, path, { body, token, raw } = {}) {
  const headers = {};
  const t = token === undefined ? state.token : token;
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  if (!raw) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* mantém texto */
    }
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

function need(value, what) {
  if (value === null || value === undefined) {
    throw new Error(`pré-requisito ausente: ${what}`);
  }
  return value;
}

// ---------------------------------------------------------------- helpers fiscais

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function pad(n, size) {
  return String(n).padStart(size, "0");
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

/** DV mod-11 da chave de acesso, recalculado de forma independente. */
function dvMod11(base43) {
  let peso = 2;
  let soma = 0;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += Number(base43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return String(resto === 0 || resto === 1 ? 0 : 11 - resto);
}

function yymm(date) {
  return `${String(date.getFullYear()).slice(2)}${pad(date.getMonth() + 1, 2)}`;
}

/**
 * Confere a chave de 44 dígitos campo a campo.
 * Layout: cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) num(9) tpEmis(1) cNF(8) cDV(1)
 */
function conferirChave(chave, { modelo, serie, numero, empresa }) {
  assert.strictEqual(typeof chave, "string", "chave não é string");
  assert.strictEqual(chave.length, 44, `chave deveria ter 44 dígitos, tem ${chave.length}`);
  assert.ok(/^\d{44}$/.test(chave), "chave contém caractere não numérico");

  const dvEsperado = dvMod11(chave.slice(0, 43));
  assert.strictEqual(chave.slice(43), dvEsperado, `DV inválido (esperado ${dvEsperado}, recebido ${chave.slice(43)})`);

  assert.strictEqual(chave.slice(0, 2), pad(empresa.cuf, 2), "cUF da chave difere da empresa");

  const agora = new Date();
  const anterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const aamm = chave.slice(2, 6);
  assert.ok(
    aamm === yymm(agora) || aamm === yymm(anterior),
    `AAMM da chave (${aamm}) não corresponde ao mês corrente`
  );

  assert.strictEqual(chave.slice(6, 20), pad(onlyDigits(empresa.cnpj), 14), "CNPJ da chave difere da empresa");
  assert.strictEqual(chave.slice(20, 22), modelo, `modelo deveria ser ${modelo}`);
  assert.strictEqual(chave.slice(22, 25), pad(serie, 3), "série da chave difere da retornada");
  assert.strictEqual(chave.slice(25, 34), pad(numero, 9), "número da chave difere do retornado");
  assert.strictEqual(chave[34], "1", "tpEmis deveria ser 1 (normal)");
}

/** Verificação leve de boa-formação: balanceamento de tags e & escapado. */
function conferirXmlBemFormado(xml) {
  const amp = xml.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  assert.strictEqual(amp, null, "XML contém '&' não escapado");

  const stack = [];
  const tagRe = /<[^>]*>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    if (tag.startsWith("<?") || tag.startsWith("<!")) continue;
    if (tag.endsWith("/>")) continue;

    const fechamento = tag[1] === "/";
    const nome = tag.slice(fechamento ? 2 : 1).split(/[\s>/]/)[0];
    if (!nome) throw new Error(`tag malformada: ${tag}`);

    if (fechamento) {
      const aberta = stack.pop();
      if (aberta !== nome) {
        throw new Error(`tag desbalanceada: fechou </${nome}> mas estava aberta <${aberta ?? "nada"}>`);
      }
    } else {
      stack.push(nome);
    }
  }
  assert.deepStrictEqual(stack, [], `tags abertas sem fechamento: ${stack.join(", ")}`);
}

function tagValor(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function contarOcorrencias(xml, re) {
  return (xml.match(re) || []).length;
}

/** Replica o arredondamento do servidor: total do item = round(qtd * unit, 2). */
function totalItem(it) {
  return Number((Number(it.quantidade) * Number(it.valor_unitario)).toFixed(2));
}

function somaItens(itens) {
  return itens.reduce((s, it) => s + totalItem(it), 0);
}

// ---------------------------------------------------------------- dados do teste

const CLIENTE_PJ = {
  tipo: "J",
  nome: "TRANSPORTES SAO JUDAS LTDA",
  cpf_cnpj: "11444777000161",
  ie: "123456789012",
  uf: "SP",
  municipio: "Campinas",
  cmun: "3509502",
  cep: "13015100",
  logradouro: "Avenida Francisco Glicerio",
  numero: "1250",
  bairro: "Centro",
  email: "fiscal@saojudas.local",
};

const ITENS_NFE = [
  {
    codigo: "GASOLINA",
    descricao: "Gasolina C Comum",
    ncm: "27101259",
    cfop: "5656",
    unidade: "LT",
    quantidade: 150.5,
    valor_unitario: 5.89,
    anp: "320101001",
    desc_anp: "GASOLINA C COMUM",
    icms_cst: "60",
    icms_aliq: 0,
  },
  {
    codigo: "DIESEL",
    descricao: "Oleo Diesel S10",
    ncm: "27101921",
    cfop: "5656",
    unidade: "LT",
    quantidade: 200,
    valor_unitario: 6.15,
    anp: "320103001",
    desc_anp: "OLEO DIESEL B S10",
    icms_cst: "60",
    icms_aliq: 0,
  },
];

const CONDUTOR = { nome: "JOAO BATISTA DA SILVA", cpf: "11144477735" };
const PLACA = "ABC1D23";
const RNTRC = "12345678";

// ---------------------------------------------------------------- suíte

async function main() {
  console.log(`PostoFiscal E2E — alvo ${BASE}\n`);

  await test("health responde ok", async () => {
    const r = await req("GET", "/api/health", { token: null });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    assert.strictEqual(r.body.status, "ok", "campo status != ok");
  });

  await test("login com credencial válida devolve token", async () => {
    const r = await req("POST", "/api/auth/login", {
      token: null,
      body: { usuario: "admin", senha: "Admin@2026" },
    });
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.token, "token ausente na resposta");
    assert.strictEqual(r.body.usuario.login, "admin");
    state.token = r.body.token;
  });

  await test("login com senha errada devolve 401", async () => {
    const r = await req("POST", "/api/auth/login", {
      token: null,
      body: { usuario: "admin", senha: "senha-errada-de-proposito" },
    });
    assert.strictEqual(r.status, 401, `status ${r.status}: ${r.text}`);
  });

  await test("auth/me devolve usuário e empresa", async () => {
    need(state.token, "token de login");
    const r = await req("GET", "/api/auth/me");
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.empresa, "empresa ausente");
    assert.ok(r.body.empresa.cnpj, "CNPJ da empresa ausente");
    assert.ok(r.body.empresa.cuf, "cUF da empresa ausente");
    state.empresa = r.body.empresa;
  });

  await test("dashboard inicial (linha de base)", async () => {
    need(state.token, "token de login");
    const r = await req("GET", "/api/cadastros/dashboard");
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.nfe, "bloco nfe ausente");
    state.baseDash = r.body;
  });

  await test("lista de produtos traz combustíveis com ANP", async () => {
    need(state.token, "token de login");
    const r = await req("GET", "/api/cadastros/produtos");
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    state.produtos = r.body.data || [];
    const gasolina = state.produtos.find((p) => p.codigo === "GASOLINA");
    assert.ok(gasolina, "produto GASOLINA não encontrado");
    assert.strictEqual(gasolina.anp, "320101001", "código ANP da gasolina diferente do esperado");
    assert.strictEqual(gasolina.cst_icms, "60", "CST da gasolina deveria ser 60");
  });

  await test("cadastro de cliente PJ", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/cadastros/clientes", { body: CLIENTE_PJ });
    assert.strictEqual(r.status, 201, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.id, "id do cliente ausente");
    state.clienteId = r.body.id;
  });

  await test("emissão de NF-e de combustível (2 itens, CST 60)", async () => {
    need(state.token, "token de login");
    const body = {
      cliente_id: state.clienteId,
      dest_nome: CLIENTE_PJ.nome,
      dest_doc: CLIENTE_PJ.cpf_cnpj,
      dest_ie: CLIENTE_PJ.ie,
      dest_uf: CLIENTE_PJ.uf,
      dest_municipio: CLIENTE_PJ.municipio,
      dest_endereco: `${CLIENTE_PJ.logradouro}, ${CLIENTE_PJ.numero}`,
      natureza: "VENDA DE COMBUSTIVEL",
      itens: ITENS_NFE,
    };
    const r = await req("POST", "/api/nfe", { body });
    assert.strictEqual(r.status, 201, `status ${r.status}: ${r.text}`);
    assert.strictEqual(r.body.status, "autorizada", `status fiscal ${r.body.status}: ${r.body.motivo}`);
    assert.ok(r.body.protocolo, "protocolo de autorização ausente");
    state.nfe1 = r.body;
    state.nfe1Itens = ITENS_NFE;
  });

  await test("chave da NF-e: DV mod-11 e layout conferem", async () => {
    const nfe = need(state.nfe1, "NF-e emitida");
    conferirChave(nfe.chave, {
      modelo: "55",
      serie: nfe.serie,
      numero: nfe.numero,
      empresa: need(state.empresa, "empresa"),
    });
  });

  await test("XML da NF-e: bem formado, totais e grupo comb", async () => {
    const nfe = need(state.nfe1, "NF-e emitida");
    const r = await req("GET", `/api/nfe/${nfe.id}/xml`, { raw: true });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    assert.ok(ct.includes("application/xml"), `content-type inesperado: ${ct}`);

    const xml = r.text;
    conferirXmlBemFormado(xml);

    const esperado = money(somaItens(state.nfe1Itens));
    assert.strictEqual(tagValor(xml, "vNF"), esperado, "vNF difere da soma dos itens enviados");

    // <vProd> aparece uma vez por item e uma vez no <ICMSTot>; o total é o último.
    const vProds = [...xml.matchAll(/<vProd>([^<]*)<\/vProd>/g)].map((m) => m[1]);
    assert.strictEqual(vProds.length, state.nfe1Itens.length + 1, "quantidade de <vProd> inesperada");
    assert.deepStrictEqual(
      vProds.slice(0, -1),
      state.nfe1Itens.map((it) => money(totalItem(it))),
      "vProd dos itens difere do enviado"
    );
    assert.strictEqual(vProds.at(-1), esperado, "vProd do ICMSTot difere da soma dos itens enviados");

    assert.strictEqual(contarOcorrencias(xml, /<det nItem="/g), 2, "deveria haver 2 blocos <det>");
    assert.strictEqual(contarOcorrencias(xml, /<cProdANP>/g), 2, "cada item de combustível deveria ter <comb><cProdANP>");
    assert.ok(xml.includes(`<infNFe Id="NFe${nfe.chave}"`), "Id do infNFe não contém a chave");
    assert.ok(xml.includes("<cProdANP>320101001</cProdANP>"), "ANP da gasolina ausente no XML");
  });

  await test("emissão de CT-e e conferência da chave", async () => {
    need(state.token, "token de login");
    const body = {
      rem_nome: "DISTRIBUIDORA DE COMBUSTIVEIS ALFA LTDA",
      rem_doc: "11222333000181",
      rem_uf: "SP",
      rem_municipio: "São Paulo",
      dest_nome: CLIENTE_PJ.nome,
      dest_doc: CLIENTE_PJ.cpf_cnpj,
      dest_uf: CLIENTE_PJ.uf,
      dest_municipio: CLIENTE_PJ.municipio,
      carga: "OLEO DIESEL B S10",
      valor_servico: 2450.75,
      icms_aliq: 12,
      cfop: "5353",
    };
    const r = await req("POST", "/api/cte", { body });
    assert.strictEqual(r.status, 201, `status ${r.status}: ${r.text}`);
    assert.strictEqual(r.body.status, "autorizada", `status fiscal ${r.body.status}: ${r.body.motivo}`);
    state.cte = { ...r.body, valor_servico: body.valor_servico, icms_aliq: body.icms_aliq };

    conferirChave(r.body.chave, {
      modelo: "57",
      serie: r.body.serie,
      numero: r.body.numero,
      empresa: need(state.empresa, "empresa"),
    });
  });

  await test("XML do CT-e: bem formado, valor e ICMS", async () => {
    const cte = need(state.cte, "CT-e emitido");
    const r = await req("GET", `/api/cte/${cte.id}/xml`, { raw: true });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const xml = r.text;
    conferirXmlBemFormado(xml);

    assert.strictEqual(tagValor(xml, "vTPrest"), money(cte.valor_servico), "vTPrest difere do valor enviado");
    assert.strictEqual(tagValor(xml, "nCT"), String(cte.numero), "nCT difere do número retornado");
    const icmsEsperado = money((cte.valor_servico * cte.icms_aliq) / 100);
    assert.strictEqual(tagValor(xml, "vICMS"), icmsEsperado, "vICMS não corresponde a base x alíquota");
    assert.ok(xml.includes(`<infCte Id="CTe${cte.chave}"`), "Id do infCte não contém a chave");
  });

  await test("emissão de CIOT com pagamento PIX", async () => {
    need(state.token, "token de login");
    const body = {
      administradora: "INTERNA",
      contratante_nome: "DISTRIBUIDORA DE COMBUSTIVEIS ALFA LTDA",
      contratante_doc: "11222333000181",
      motorista_nome: CONDUTOR.nome,
      motorista_cpf: CONDUTOR.cpf,
      placa: PLACA,
      valor_contrato: 2450.75,
      valor_adiantamento: 500,
      forma_pagto: "PIX",
      chave_pix: "11222333000181",
    };
    const r = await req("POST", "/api/ciot", { body });
    assert.strictEqual(r.status, 201, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.numero, "número do CIOT ausente");
    assert.strictEqual(r.body.status, "emitido", `status ${r.body.status}`);
    state.ciot = r.body;
  });

  await test("emissão de MDF-e vinculando NF-e, CT-e e CIOT", async () => {
    need(state.token, "token de login");
    const nfe = need(state.nfe1, "NF-e emitida");
    const cte = need(state.cte, "CT-e emitido");
    const ciot = need(state.ciot, "CIOT emitido");

    const body = {
      placa: PLACA,
      uf_veiculo: "SP",
      uf_ini: "SP",
      uf_fim: "MG",
      rntrc: RNTRC,
      valor_carga: 3337.45,
      ciot_id: ciot.id,
      condutores: [CONDUTOR],
      percurso: ["MG"],
      documentos: [
        { tipo: "nfe", chave: nfe.chave },
        { tipo: "cte", chave: cte.chave },
      ],
    };
    const r = await req("POST", "/api/mdfe", { body });
    assert.strictEqual(r.status, 201, `status ${r.status}: ${r.text}`);
    assert.strictEqual(r.body.status, "autorizada", `status fiscal ${r.body.status}: ${r.body.motivo}`);
    state.mdfe = r.body;

    conferirChave(r.body.chave, {
      modelo: "58",
      serie: r.body.serie,
      numero: r.body.numero,
      empresa: need(state.empresa, "empresa"),
    });
  });

  await test("XML do MDF-e: documentos, CIOT e condutor presentes", async () => {
    const mdfe = need(state.mdfe, "MDF-e emitido");
    const nfe = need(state.nfe1, "NF-e emitida");
    const cte = need(state.cte, "CT-e emitido");
    const ciot = need(state.ciot, "CIOT emitido");

    const r = await req("GET", `/api/mdfe/${mdfe.id}/xml`, { raw: true });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const xml = r.text;
    conferirXmlBemFormado(xml);

    assert.ok(xml.includes(`<chNFe>${nfe.chave}</chNFe>`), "chave da NF-e ausente no MDF-e");
    assert.ok(xml.includes(`<chCTe>${cte.chave}</chCTe>`), "chave do CT-e ausente no MDF-e");
    assert.ok(xml.includes("<infCIOT>"), "grupo infCIOT ausente");
    assert.ok(xml.includes(`<CIOT>${ciot.numero}</CIOT>`), "número do CIOT ausente no infANTT");
    assert.ok(xml.includes(`<RNTRC>${RNTRC}</RNTRC>`), "RNTRC ausente");
    assert.ok(xml.includes(`<CPF>${onlyDigits(CONDUTOR.cpf)}</CPF>`), "CPF do condutor ausente");
    assert.ok(xml.includes(`<placa>${PLACA}</placa>`), "placa ausente no veicTracao");
    assert.strictEqual(tagValor(xml, "qNFe"), "1", "qNFe deveria ser 1");
    assert.strictEqual(tagValor(xml, "qCTe"), "1", "qCTe deveria ser 1");
    assert.ok(xml.includes("<UFPer>MG</UFPer>"), "percurso MG ausente");
  });

  await test("detalhe do MDF-e traz CIOT e documentos vinculados", async () => {
    const mdfe = need(state.mdfe, "MDF-e emitido");
    const ciot = need(state.ciot, "CIOT emitido");
    const r = await req("GET", `/api/mdfe/${mdfe.id}`);
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.ok(r.body.ciot, "CIOT não veio agregado no detalhe");
    assert.strictEqual(r.body.ciot.numero, ciot.numero, "número do CIOT divergente");
    assert.strictEqual(r.body.documentos.length, 2, "deveriam vir 2 documentos vinculados");
    assert.strictEqual(r.body.condutores.length, 1, "deveria vir 1 condutor");
    assert.strictEqual(r.body.percurso.length, 1, "deveria vir 1 UF de percurso");
  });

  await test("encerramento do MDF-e muda status para encerrada", async () => {
    const mdfe = need(state.mdfe, "MDF-e emitido");
    const r = await req("POST", `/api/mdfe/${mdfe.id}/encerrar`, { body: {} });
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.strictEqual(r.body.ok, true, "resposta sem ok=true");

    const d = await req("GET", `/api/mdfe/${mdfe.id}`);
    assert.strictEqual(d.body.mdfe.status, "encerrada", `status ficou ${d.body.mdfe.status}`);
    assert.ok(d.body.mdfe.encerrado_em, "encerrado_em não gravado");
  });

  // ------------------------------------------------- bateria negativa

  await test("rota protegida sem token devolve 401", async () => {
    const r = await req("GET", "/api/nfe", { token: null });
    assert.strictEqual(r.status, 401, `status ${r.status}: ${r.text}`);
  });

  await test("rota protegida com token inválido devolve 401", async () => {
    const r = await req("GET", "/api/nfe", { token: "token.completamente.invalido" });
    assert.strictEqual(r.status, 401, `status ${r.status}: ${r.text}`);
  });

  await test("NF-e sem itens devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/nfe", {
      body: { dest_nome: CLIENTE_PJ.nome, dest_doc: CLIENTE_PJ.cpf_cnpj, itens: [] },
    });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  await test("NF-e sem destinatário devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/nfe", { body: { itens: ITENS_NFE } });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  await test("CT-e com valor de serviço zero devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/cte", {
      body: {
        rem_nome: "ALFA LTDA",
        rem_doc: "11222333000181",
        dest_nome: CLIENTE_PJ.nome,
        dest_doc: CLIENTE_PJ.cpf_cnpj,
        valor_servico: 0,
      },
    });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  await test("CIOT com valor de contrato zero devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/ciot", {
      body: {
        contratante_nome: "ALFA LTDA",
        contratante_doc: "11222333000181",
        motorista_nome: CONDUTOR.nome,
        motorista_cpf: CONDUTOR.cpf,
        placa: PLACA,
        valor_contrato: 0,
      },
    });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  await test("MDF-e sem condutor devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/mdfe", {
      body: { placa: PLACA, uf_ini: "SP", uf_fim: "MG", condutores: [] },
    });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  // ------------------------------------------------- regressão de bugs achados

  await test("NF-e com item sem quantidade devolve 400", async () => {
    need(state.token, "token de login");
    const semQtd = { ...ITENS_NFE[0] };
    delete semQtd.quantidade;
    const r = await req("POST", "/api/nfe", {
      body: { dest_nome: CLIENTE_PJ.nome, dest_doc: CLIENTE_PJ.cpf_cnpj, dest_uf: "SP", itens: [semQtd] },
    });
    assert.strictEqual(r.status, 400, `aceitou item sem quantidade: status ${r.status} ${r.text}`);
  });

  await test("NF-e com quantidade não numérica devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/nfe", {
      body: {
        dest_nome: CLIENTE_PJ.nome,
        dest_doc: CLIENTE_PJ.cpf_cnpj,
        dest_uf: "SP",
        itens: [{ ...ITENS_NFE[0], quantidade: "muita" }],
      },
    });
    assert.strictEqual(r.status, 400, `aceitou quantidade não numérica: status ${r.status} ${r.text}`);
  });

  await test("NF-e rejeitada não consome número de documento", async () => {
    need(state.token, "token de login");
    const antes = (await req("GET", "/api/cadastros/empresa")).body.prox_nfe;
    await req("POST", "/api/nfe", {
      body: { dest_nome: CLIENTE_PJ.nome, dest_doc: CLIENTE_PJ.cpf_cnpj, itens: [] },
    });
    const depois = (await req("GET", "/api/cadastros/empresa")).body.prox_nfe;
    assert.strictEqual(depois, antes, `prox_nfe saltou de ${antes} para ${depois} sem emitir`);
  });

  await test("dhEmi do XML não está no futuro", async () => {
    const nfe = need(state.nfe1, "NF-e emitida");
    const r = await req("GET", `/api/nfe/${nfe.id}/xml`, { raw: true });
    const dh = tagValor(r.text, "dhEmi");
    const emitido = new Date(dh).getTime();
    assert.ok(Number.isFinite(emitido), `dhEmi não parseável: ${dh}`);
    const adiantoMin = (emitido - Date.now()) / 60000;
    assert.ok(adiantoMin < 5, `dhEmi está ${adiantoMin.toFixed(1)} min no futuro (${dh}) — rejeição 703`);
  });

  await test("número do CIOT segue o padrão ANTT de 12 dígitos", async () => {
    const ciot = need(state.ciot, "CIOT emitido");
    assert.ok(/^[0-9]{12}$/.test(ciot.numero), `número fora do padrão [0-9]{12}: ${ciot.numero}`);
  });

  await test("cancelar o mesmo CIOT duas vezes devolve 400", async () => {
    need(state.token, "token de login");
    const novo = await req("POST", "/api/ciot", {
      body: {
        contratante_nome: "BETA TRANSPORTES LTDA",
        contratante_doc: "11222333000181",
        motorista_nome: CONDUTOR.nome,
        motorista_cpf: CONDUTOR.cpf,
        placa: PLACA,
        valor_contrato: 1000,
        forma_pagto: "TED",
      },
    });
    assert.strictEqual(novo.status, 201, `falhou ao criar CIOT: ${novo.text}`);
    const um = await req("POST", `/api/ciot/${novo.body.id}/cancelar`, { body: {} });
    assert.strictEqual(um.status, 200, `primeiro cancelamento falhou: ${um.text}`);
    const dois = await req("POST", `/api/ciot/${novo.body.id}/cancelar`, { body: {} });
    assert.strictEqual(dois.status, 400, `segundo cancelamento devolveu ${dois.status}: ${dois.text}`);
  });

  await test("NF-e com alíquota de ICMS não numérica devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/nfe", {
      body: {
        dest_nome: CLIENTE_PJ.nome,
        dest_doc: CLIENTE_PJ.cpf_cnpj,
        dest_uf: "SP",
        itens: [{ ...ITENS_NFE[0], icms_cst: "00", icms_aliq: "abc" }],
      },
    });
    assert.strictEqual(r.status, 400, `aceitou alíquota não numérica: status ${r.status} ${r.text}`);
  });

  await test("CT-e com alíquota de ICMS não numérica devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/cte", {
      body: {
        rem_nome: "ALFA LTDA",
        rem_doc: "11222333000181",
        dest_nome: CLIENTE_PJ.nome,
        dest_doc: CLIENTE_PJ.cpf_cnpj,
        valor_servico: 500,
        icms_aliq: "doze",
      },
    });
    assert.strictEqual(r.status, 400, `aceitou alíquota não numérica: status ${r.status} ${r.text}`);
  });

  await test("MDF-e com valor de carga não numérico devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/mdfe", {
      body: {
        placa: PLACA,
        uf_ini: "SP",
        uf_fim: "MG",
        rntrc: RNTRC,
        condutores: [CONDUTOR],
        valor_carga: "muito",
      },
    });
    assert.strictEqual(r.status, 400, `aceitou valor de carga inválido: status ${r.status} ${r.text}`);
  });

  await test("CIOT com adiantamento acima do contrato devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/ciot", {
      body: {
        contratante_nome: "GAMA LTDA",
        contratante_doc: "11222333000181",
        motorista_nome: CONDUTOR.nome,
        motorista_cpf: CONDUTOR.cpf,
        placa: PLACA,
        valor_contrato: 1000,
        valor_adiantamento: 5000,
      },
    });
    assert.strictEqual(r.status, 400, `aceitou adiantamento maior que o contrato: status ${r.status} ${r.text}`);
  });

  await test("produto com preço não numérico devolve 400", async () => {
    need(state.token, "token de login");
    const r = await req("POST", "/api/cadastros/produtos", {
      body: { codigo: `TESTE${Date.now()}`, descricao: "Produto teste", preco: "caro" },
    });
    assert.strictEqual(r.status, 400, `aceitou preço não numérico: status ${r.status} ${r.text}`);
  });

  await test("PUT na empresa com null não apaga campos", async () => {
    need(state.token, "token de login");
    const antes = (await req("GET", "/api/cadastros/empresa")).body;
    try {
      const r = await req("PUT", "/api/cadastros/empresa", {
        body: { razao_social: antes.razao_social, cnpj: null, cuf: null, crt: null, ambiente: null },
      });
      assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
      const depois = (await req("GET", "/api/cadastros/empresa")).body;
      for (const campo of ["cnpj", "cuf", "crt", "ambiente"]) {
        assert.strictEqual(String(depois[campo]), String(antes[campo]), `null apagou "${campo}"`);
      }
    } finally {
      await req("PUT", "/api/cadastros/empresa", { body: antes });
    }
  });

  await test("PUT parcial na empresa não apaga campos ausentes", async () => {
    need(state.token, "token de login");
    const antes = (await req("GET", "/api/cadastros/empresa")).body;
    try {
      const r = await req("PUT", "/api/cadastros/empresa", { body: { razao_social: antes.razao_social } });
      assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
      const depois = (await req("GET", "/api/cadastros/empresa")).body;
      for (const campo of ["cnpj", "cuf", "uf", "ie", "cmun", "serie_nfe", "prox_nfe"]) {
        assert.strictEqual(String(depois[campo]), String(antes[campo]), `PUT parcial apagou "${campo}"`);
      }
    } finally {
      await req("PUT", "/api/cadastros/empresa", { body: antes });
    }
  });

  await test("cancelar MDF-e já encerrado devolve 400", async () => {
    const mdfe = need(state.mdfe, "MDF-e emitido");
    const r = await req("POST", `/api/mdfe/${mdfe.id}/cancelar`, { body: {} });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  await test("cancelamento da NF-e autorizada funciona", async () => {
    const nfe = need(state.nfe1, "NF-e emitida");
    const r = await req("POST", `/api/nfe/${nfe.id}/cancelar`, { body: {} });
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);
    assert.strictEqual(r.body.ok, true, "resposta sem ok=true");

    const d = await req("GET", `/api/nfe/${nfe.id}`);
    assert.strictEqual(d.body.nota.status, "cancelada", `status ficou ${d.body.nota.status}`);
  });

  await test("cancelar a mesma NF-e duas vezes devolve 400", async () => {
    const nfe = need(state.nfe1, "NF-e emitida");
    const r = await req("POST", `/api/nfe/${nfe.id}/cancelar`, { body: {} });
    assert.strictEqual(r.status, 400, `status ${r.status}: ${r.text}`);
  });

  // ------------------------------------------------- numeração e dashboard

  await test("numeração de NF-e é sequencial", async () => {
    need(state.token, "token de login");
    const body = {
      dest_nome: CLIENTE_PJ.nome,
      dest_doc: CLIENTE_PJ.cpf_cnpj,
      dest_uf: CLIENTE_PJ.uf,
      itens: [ITENS_NFE[0]],
    };
    const a = await req("POST", "/api/nfe", { body });
    assert.strictEqual(a.status, 201, `1ª emissão: status ${a.status}: ${a.text}`);
    const b = await req("POST", "/api/nfe", { body });
    assert.strictEqual(b.status, 201, `2ª emissão: status ${b.status}: ${b.text}`);

    state.nfeA = a.body;
    state.nfeB = b.body;
    assert.strictEqual(
      Number(b.body.numero),
      Number(a.body.numero) + 1,
      `numeração não sequencial: ${a.body.numero} depois ${b.body.numero}`
    );
    assert.notStrictEqual(a.body.chave, b.body.chave, "chaves repetidas entre duas notas");
  });

  await test("dashboard reflete as emissões desta execução", async () => {
    const base = need(state.baseDash, "dashboard de base");
    need(state.nfeA, "NF-e sequenciais");
    const r = await req("GET", "/api/cadastros/dashboard");
    assert.strictEqual(r.status, 200, `status ${r.status}: ${r.text}`);

    // Nesta execução: 3 NF-e emitidas, 1 delas cancelada.
    const deltaAut = r.body.nfe.autorizadas - base.nfe.autorizadas;
    const deltaCanc = r.body.nfe.canceladas - base.nfe.canceladas;
    assert.strictEqual(deltaAut, 2, `delta de autorizadas deveria ser 2, foi ${deltaAut}`);
    assert.strictEqual(deltaCanc, 1, `delta de canceladas deveria ser 1, foi ${deltaCanc}`);

    const esperado = somaItens([ITENS_NFE[0]]) * 2;
    const deltaValor = r.body.nfe.valor_total - base.nfe.valor_total;
    assert.strictEqual(
      money(deltaValor),
      money(esperado),
      `delta de valor autorizado deveria ser ${money(esperado)}, foi ${money(deltaValor)}`
    );

    const deltaCte = r.body.cte.autorizados - base.cte.autorizados;
    assert.strictEqual(deltaCte, 1, `delta de CT-e autorizados deveria ser 1, foi ${deltaCte}`);
    const deltaEncerrados = r.body.mdfe.encerrados - base.mdfe.encerrados;
    assert.strictEqual(deltaEncerrados, 1, `delta de MDF-e encerrados deveria ser 1, foi ${deltaEncerrados}`);
  });

  // ------------------------------------------------- resumo

  const falhas = results.filter((t) => !t.ok);
  console.log(`\n${"-".repeat(60)}`);
  console.log(`Total: ${results.length}   Passou: ${results.length - falhas.length}   Falhou: ${falhas.length}`);
  if (falhas.length) {
    console.log("\nFalhas:");
    for (const f of falhas) console.log(`  - ${f.name}: ${f.err}`);
  }
  if (state.nfe1) console.log(`\nNF-e: ${state.nfe1.chave} (${state.nfe1.protocolo})`);
  if (state.cte) console.log(`CT-e: ${state.cte.chave} (${state.cte.protocolo})`);
  if (state.mdfe) console.log(`MDF-e: ${state.mdfe.chave} (${state.mdfe.protocolo})`);
  if (state.ciot) console.log(`CIOT: ${state.ciot.numero}`);

  process.exit(falhas.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Erro fatal na suíte:", err);
  process.exit(1);
});
