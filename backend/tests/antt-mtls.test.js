// CIOT via ANTT contra um mock HTTPS com mTLS de verdade (sem rede externa).
// Certificados gerados em tempo de execução com openssl num diretório temporário;
// banco JSON também temporário (DATA_DIR definido antes de carregar o db).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

function acharOpenssl() {
  const candidatos = [
    process.env.OPENSSL_BIN,
    "openssl",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  ].filter(Boolean);
  for (const c of candidatos) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

const OPENSSL = acharOpenssl();
if (!OPENSSL) {
  console.error("ERRO: openssl não encontrado (PATH, Git for Windows ou OPENSSL_BIN). Este teste precisa dele para gerar certificados.");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antt-mtls-"));
const arq = (n) => path.join(dir, n);
function ssl(...args) {
  const r = spawnSync(OPENSSL, args, { cwd: dir, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} falhou: ${r.stderr || r.error}`);
}

fs.writeFileSync(
  arq("openssl.cnf"),
  `[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
[ca_ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[srv_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
[cli_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
`
);
const SENHA = "Senha-Teste-123";
const CNF = ["-config", "openssl.cnf"];
ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3", "-subj", "/CN=PostoFiscal CA de teste", ...CNF, "-extensions", "ca_ext");
ssl("req", "-x509", "-CA", "ca.crt", "-CAkey", "ca.key", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.crt", "-days", "3", "-subj", "/CN=localhost", ...CNF, "-extensions", "srv_ext");
function cliente(nome, cn, { validade = ["-days", "3"], assinadoPelaCa = true, ext = "cli_ext" } = {}) {
  const ca = assinadoPelaCa ? ["-CA", "ca.crt", "-CAkey", "ca.key"] : [];
  ssl("req", "-x509", ...ca, "-newkey", "rsa:2048", "-nodes", "-keyout", `${nome}.key`, "-out", `${nome}.crt`, ...validade, "-subj", `/CN=${cn}`, ...CNF, "-extensions", ext);
  const cadeia = assinadoPelaCa ? ["-certfile", "ca.crt"] : [];
  ssl("pkcs12", "-export", "-inkey", `${nome}.key`, "-in", `${nome}.crt`, ...cadeia, "-passout", `pass:${SENHA}`, "-out", `${nome}.pfx`);
  return arq(`${nome}.pfx`);
}
const PFX_OK = cliente("valido", "EMPRESA TESTE LTDA:11222333000181");
const PFX_VENCIDO = cliente("vencido", "EMPRESA TESTE LTDA:11222333000181", {
  validade: ["-not_before", "20200101000000Z", "-not_after", "20210101000000Z"],
});
const PFX_OUTRO = cliente("outro", "OUTRA EMPRESA LTDA:11444777000161");
const PFX_INTRUSO = cliente("intruso", "INTRUSO LTDA:11222333000181", { assinadoPelaCa: false });
const PFX_SO_SERVIDOR = cliente("soservidor", "EMPRESA TESTE LTDA:11222333000181", { ext: "srv_ext" });
const PFX_CORROMPIDO = arq("corrompido.pfx");
fs.writeFileSync(PFX_CORROMPIDO, Buffer.from("isto nao e um pfx valido"));

// ---- mock PEF com mTLS ----
const roteiro = {}; // servico -> [{ status, json, raw, delay }]
const recebidas = [];
const server = https.createServer(
  {
    key: fs.readFileSync(arq("srv.key")),
    cert: fs.readFileSync(arq("srv.crt")),
    ca: fs.readFileSync(arq("ca.crt")),
    requestCert: true,
    rejectUnauthorized: true,
  },
  (req, res) => {
    res.on("error", () => {});
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const servico = req.url.split("/").pop();
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* corpo invalido */
      }
      recebidas.push({ servico, body, cn: req.socket.getPeerCertificate().subject?.CN });
      const passo = (roteiro[servico] || []).shift() || { status: 500, raw: "sem roteiro" };
      const enviar = () => {
        if (res.destroyed) return;
        res.writeHead(passo.status, { "Content-Type": passo.json ? "application/json" : "text/plain" });
        res.end(passo.json ? JSON.stringify(passo.json) : passo.raw || "");
      };
      if (passo.delay) setTimeout(enviar, passo.delay);
      else enviar();
    });
  }
);
server.on("tlsClientError", () => {});

const roteirizar = (servico, ...passos) => (roteiro[servico] = passos);

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  Object.assign(process.env, {
    DATA_DIR: arq("data"),
    NODE_ENV: "test",
    CIOT_PROVIDER: "antt",
    ANTT_AMBIENTE: "homologacao",
    ANTT_BASE_URL: `https://127.0.0.1:${port}/pefServices/api`,
    ANTT_CA_PATH: arq("ca.crt"),
    ANTT_TIMEOUT_MS: "1500",
    ANTT_ID_MODO: "manual",
    ANTT_PFX_PATH: PFX_OK,
    ANTT_PFX_SENHA: SENHA,
  });
  const db = require("../src/db");
  db.insert("empresas", { id: "emp1", razao_social: "EMPRESA TESTE LTDA", cnpj: "11.222.333/0001-81" });
  const C = require("../src/controllers/ciotController");

  const mk = () => {
    const r = { code: 200 };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  const user = { id: "u1", empresa_id: "emp1" };
  const chamar = async (fn, { body = {}, params = {}, query = {} } = {}) => {
    const res = mk();
    await C[fn]({ body, params, query, user, correlacao: "corr-mtls" }, res);
    return res;
  };
  const P = require("../src/services/anttPayload");
  const diaSP = (n) => P.dataHora(new Date(Date.now() + n * 86400000)).slice(0, 10);
  const corpo = (id) => ({
    id_operacao: id,
    contratante_nome: "CLIENTE CONTRATANTE LTDA",
    contratante_doc: "11444777000161",
    contratado_doc: "11222333000181",
    motorista_nome: "MOTORISTA",
    motorista_cpf: "52998224725",
    placa: "ABC1D23",
    valor_contrato: 1000,
    destinatario_doc: "52998224725",
    contratado_rntrc: "12345678",
    data_inicio_viagem: diaSP(1),
    data_fim_viagem: diaSP(3),
    veiculos: [{ placa: "ABC1D23", eixos: 3 }, { placa: "XYZ9A88", eixos: 3 }],
    origem_destino: [{ origem: { municipio: "2507507" }, destino: { municipio: "3550308" }, distancia: 2700 }],
    carga: { natureza: "0001", peso: 25000, tipo: 5 },
    forma_pagto: "PIX",
    chave_pix: "a@b.com",
    identificador_pix: "ID1",
  });
  const ciots = () => db.all("ciot");
  const linha = (id) => db.get("ciot", (c) => c.id === id);
  let n = 0;
  const t = async (nome, fn) => {
    await fn();
    n++;
    console.log("ok -", nome);
  };
  const semEfeito = async (nome, env, idOp, re, codigo) => {
    await t(nome, async () => {
      Object.assign(process.env, env);
      const antes = ciots().length;
      const req0 = recebidas.length;
      const res = await chamar("emitir", { body: corpo(idOp) });
      assert.strictEqual(res.code, codigo, JSON.stringify(res.body));
      assert.match(res.body.error, re);
      assert.ok(!String(res.body.error).includes(SENHA), "mensagem vazou a senha");
      assert.strictEqual(ciots().length, antes, "linha de CIOT não deveria ser gravada");
      assert.strictEqual(recebidas.length, req0, "nada deveria ir à rede");
      Object.assign(process.env, { ANTT_PFX_PATH: PFX_OK, ANTT_PFX_SENHA: SENHA });
    });
  };

  try {
    await semEfeito("senha errada -> configuracao, sem gravar", { ANTT_PFX_SENHA: "senha-ERRADA-999" }, "ADM000000001", /senha incorreta/, 503);
    await semEfeito("PFX corrompido -> configuracao", { ANTT_PFX_PATH: PFX_CORROMPIDO }, "ADM000000001", /inválido/, 503);
    await semEfeito("certificado vencido recusado com a data", { ANTT_PFX_PATH: PFX_VENCIDO }, "ADM000000001", /vencido em 01\/01\/2021/, 503);
    await semEfeito("CNPJ do certificado diferente do da empresa", { ANTT_PFX_PATH: PFX_OUTRO }, "ADM000000001", /11444777000161/, 400);
    await semEfeito("manual sem id_operacao", {}, "", /id_operacao/, 400);
    await semEfeito("certificado ausente (ANTT_PFX_PATH vazio)", { ANTT_PFX_PATH: "" }, "ADM000000001", /não configurado/, 503);
    await semEfeito("arquivo do certificado inexistente", { ANTT_PFX_PATH: arq("nao-existe.pfx") }, "ADM000000001", /Não foi possível ler/, 503);
    await semEfeito("certificado sem EKU Autenticação Cliente", { ANTT_PFX_PATH: PFX_SO_SERVIDOR }, "ADM000000001", /Autenticação Cliente/, 503);
    await t("contratado diferente da empresa (B115) -> 400, nada vai à rede", async () => {
      const antes = ciots().length;
      const req0 = recebidas.length;
      const res = await chamar("emitir", { body: { ...corpo("ADM000000001"), contratado_doc: "52998224725" } });
      assert.strictEqual(res.code, 400, JSON.stringify(res.body));
      assert.match(res.body.error, /B115/);
      assert.strictEqual(ciots().length, antes);
      assert.strictEqual(recebidas.length, req0);
    });
    await semEfeito("http em ANTT_BASE_URL recusado", { ANTT_BASE_URL: `http://127.0.0.1:${port}/x` }, "ADM000000001", /https/, 503);
    process.env.ANTT_BASE_URL = `https://127.0.0.1:${port}/pefServices/api`;

    await t("servidor recusa cliente sem certificado", async () => {
      const r = await new Promise((resolve) => {
        const req = https.request(
          `https://127.0.0.1:${port}/pefServices/api/DeclaracaoOperacaoTransporte`,
          { method: "POST", ca: fs.readFileSync(arq("ca.crt")), agent: false },
          (res) => resolve({ status: res.statusCode })
        );
        req.on("error", (e) => resolve({ erro: e.code || e.message }));
        req.end("{}");
      });
      assert.ok(r.erro, `deveria falhar, veio ${JSON.stringify(r)}`);
    });

    await t("cliente com certificado fora da cadeia -> erro, nunca emitido", async () => {
      process.env.ANTT_PFX_PATH = PFX_INTRUSO;
      const res = await chamar("emitir", { body: corpo("ADM000000002") });
      assert.notStrictEqual(res.code, 201);
      assert.ok(res.code >= 500, `status ${res.code}`);
      const row = ciots().find((c) => c.id_operacao === "ADM000000002");
      assert.ok(row && ["nao_enviado", "pendente"].includes(row.status), row && row.status);
      assert.strictEqual(C && (await chamar("detalhe", { params: { id: row.id } })).body.oficial, false);
      process.env.ANTT_PFX_PATH = PFX_OK;
    });

    let emitido;
    await t("110 -> emitido com 16 caracteres", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", {
        status: 200,
        json: { CodigoIdentificacaoOperacao: "ADM000000003", CodigoVerificador: "0042", Protocolo: "P3", Codigo: "110", Mensagem: "Dados inseridos" },
      });
      const res = await chamar("emitir", { body: corpo("ADM000000003") });
      assert.strictEqual(res.code, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.numero, "ADM0000000030042");
      assert.strictEqual(res.body.oficial, true);
      const req = recebidas[recebidas.length - 1];
      assert.strictEqual(req.body.IdOperacaoTransporte, "ADM000000003");
      assert.strictEqual(req.cn, "EMPRESA TESTE LTDA:11222333000181");
      emitido = linha(res.body.id);
      assert.strictEqual(emitido.status, "emitido");
      assert.strictEqual(emitido.numero.length, 16);
      assert.strictEqual((await chamar("detalhe", { params: { id: emitido.id } })).body.oficial, true);
    });

    await t("110 com DV numérico: CIOT completo vem da ConsultarCIOTGerado (sem completar zeros)", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", {
        status: 200,
        json: { IdOperacaoTransporte: "ADM000000004", CodigoVerificador: 7, Codigo: ["110"], Mensagem: ["Dados inseridos"] },
      });
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000040007", Codigo: ["111"] } });
      const res = await chamar("emitir", { body: corpo("ADM000000004") });
      assert.strictEqual(res.code, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.numero, "ADM0000000040007");
      assert.strictEqual(recebidas[recebidas.length - 1].servico, "ConsultarCIOTGerado");
      const decl = recebidas[recebidas.length - 2].body;
      assert.strictEqual(decl.CpfCnpjContratado, "11222333000181");
      assert.deepStrictEqual(decl.Veiculos.map((v) => v.Placa), ["ABC1D23", "XYZ9A88"]);
      assert.deepStrictEqual(linha(res.body.id).veiculos.map((v) => v.placa), ["ABC1D23", "XYZ9A88"]);
    });

    await t("id_operacao manual repetido -> 400", async () => {
      const antes = ciots().length;
      const res = await chamar("emitir", { body: corpo("ADM000000003") });
      assert.strictEqual(res.code, 400);
      assert.match(res.body.error, /já usado/);
      assert.strictEqual(ciots().length, antes);
    });

    await t("rejeição 205 -> rejeitado", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { Codigo: ["205"], Mensagem: ["Regra violada"], Protocolo: "P5" } });
      const res = await chamar("emitir", { body: corpo("ADM000000005") });
      assert.strictEqual(res.code, 400);
      assert.strictEqual(res.body.codigo, "205");
      assert.strictEqual(linha(res.body.id).status, "rejeitado");
    });

    const recuperar = async (id, idOp) => {
      assert.strictEqual(linha(id).status, "pendente");
      assert.strictEqual((await chamar("detalhe", { params: { id } })).body.oficial, false);
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: `${idOp}1234`, Codigo: ["111"], Mensagem: ["Consulta"] } });
      const res = await chamar("consultarGerado", { params: { id } });
      assert.strictEqual(res.code, 200, JSON.stringify(res.body));
      const consulta = recebidas[recebidas.length - 1];
      assert.deepStrictEqual(Object.keys(consulta.body).sort(), ["AnoDeclaracao", "CodigoIdentificacaoOperacao"]);
      assert.strictEqual(consulta.body.CodigoIdentificacaoOperacao, idOp);
      assert.strictEqual(linha(id).status, "emitido");
      assert.strictEqual(linha(id).numero, `${idOp}1234`);
    };

    await t("HTTP 503 -> pendente; ConsultarCIOTGerado recupera", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 503, raw: "Service Unavailable" });
      const res = await chamar("emitir", { body: corpo("ADM000000006") });
      assert.strictEqual(res.code, 502);
      assert.strictEqual(res.body.proxima_acao, "consultar");
      await recuperar(res.body.id, "ADM000000006");
    });

    await t("timeout -> pendente; ConsultarCIOTGerado recupera", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", {
        status: 200,
        delay: 3000,
        json: { CodigoIdentificacaoOperacao: "ADM000000007", CodigoVerificador: "1234", Codigo: "110" },
      });
      const res = await chamar("emitir", { body: corpo("ADM000000007") });
      assert.strictEqual(res.code, 502);
      assert.match(res.body.error, /timeout/);
      await recuperar(res.body.id, "ADM000000007");
    });

    await t("consulta com código de outro ID não promove", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { Protocolo: "sem codigo" } });
      roteirizar("ConsultarCIOTGerado", { status: 500, raw: "" });
      const res = await chamar("emitir", { body: corpo("ADM000000008") });
      assert.strictEqual(res.code, 502);
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000991234", Codigo: "111" } });
      const c = await chamar("consultarGerado", { params: { id: res.body.id } });
      assert.strictEqual(c.code, 502);
      assert.strictEqual(linha(res.body.id).status, "pendente");
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { Codigo: ["321"], Mensagem: ["Nao encontrado"] } });
      const d = await chamar("consultarGerado", { params: { id: res.body.id } });
      assert.strictEqual(d.code, 400);
      assert.strictEqual(d.body.codigo, "321");
      assert.ok(d.body.proxima_acao);
      assert.strictEqual(linha(res.body.id).status, "pendente");
    });

    await t("cancelamento indeterminado mantém status; sucesso cancela", async () => {
      roteirizar("CancelamentoOperacaoTransporte", { status: 500, raw: "erro interno" });
      let res = await chamar("cancelar", { params: { id: emitido.id }, body: { motivo: "teste" } });
      assert.strictEqual(res.code, 502);
      let row = linha(emitido.id);
      assert.strictEqual(row.status, "emitido");
      assert.strictEqual(row.operacao_pendente.tipo, "cancelamento");
      const canc = recebidas[recebidas.length - 1];
      assert.strictEqual(canc.body.CodigoIdentificacaoOperacao, "ADM0000000030042");
      roteirizar("CancelamentoOperacaoTransporte", { status: 200, json: { Codigo: "205", Mensagem: "x" } });
      res = await chamar("cancelar", { params: { id: emitido.id }, body: { motivo: "teste" } });
      assert.strictEqual(res.code, 400);
      assert.strictEqual(linha(emitido.id).status, "emitido");
      roteirizar("CancelamentoOperacaoTransporte", { status: 200, json: { Codigo: "110", Mensagem: "ok", Protocolo: "PC" } });
      res = await chamar("cancelar", { params: { id: emitido.id }, body: { motivo: "teste" } });
      assert.strictEqual(res.code, 200, JSON.stringify(res.body));
      row = linha(emitido.id);
      assert.strictEqual(row.status, "cancelado");
      assert.strictEqual(row.operacao_pendente, null);
    });

    await t("403 sem código (certificado não cadastrado) -> nao_enviado; ID reutilizável", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 403, raw: "Forbidden" });
      const res = await chamar("emitir", { body: corpo("ADM000000020") });
      assert.strictEqual(res.code, 503, JSON.stringify(res.body));
      assert.match(res.body.error, /Acesso recusado/);
      assert.strictEqual(linha(res.body.id).status, "nao_enviado");
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000020", CodigoVerificador: "0001", Codigo: "110" } });
      const de_novo = await chamar("emitir", { body: corpo("ADM000000020") });
      assert.strictEqual(de_novo.code, 201, JSON.stringify(de_novo.body));
    });

    await t("HTTP 400 não-JSON -> rejeitado (ANTT recusou)", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 400, raw: "<html>Bad Request</html>" });
      const res = await chamar("emitir", { body: corpo("ADM000000021") });
      assert.strictEqual(res.code, 400);
      assert.strictEqual(linha(res.body.id).status, "rejeitado");
      assert.strictEqual(res.body.oficial, false);
    });

    await t("HTTP 200 com HTML (não-JSON) -> pendente, nunca emitido", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, raw: "<html>gateway</html>" });
      const res = await chamar("emitir", { body: corpo("ADM000000022") });
      assert.strictEqual(res.code, 502);
      assert.match(res.body.error, /Resposta inválida/);
      assert.strictEqual(linha(res.body.id).status, "pendente");
    });

    await t("código desconhecido 999 -> rejeitado com código e mensagem da ANTT", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { Codigo: ["999"], Mensagem: ["Mensagem nova da ANTT"] } });
      const res = await chamar("emitir", { body: corpo("ADM000000023") });
      assert.strictEqual(res.code, 400);
      assert.strictEqual(res.body.codigo, "999");
      const row = linha(res.body.id);
      assert.strictEqual(row.status, "rejeitado");
      assert.strictEqual(row.codigo_antt, "999");
      assert.match(row.mensagem_antt, /Mensagem nova da ANTT/);
    });

    await t("resposta perdida: pendente bloqueia nova declaração do mesmo ID", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 502, raw: "Bad Gateway" });
      const res = await chamar("emitir", { body: corpo("ADM000000024") });
      assert.strictEqual(res.code, 502);
      const req0 = recebidas.length;
      const outra = await chamar("emitir", { body: corpo("ADM000000024") });
      assert.strictEqual(outra.code, 400);
      assert.match(outra.body.error, /já usado/);
      assert.strictEqual(recebidas.length, req0, "não pode declarar de novo às cegas");
      const det = await chamar("detalhe", { params: { id: res.body.id } });
      assert.strictEqual(det.body.status, "pendente");
      assert.strictEqual(det.body.oficial, false);
      assert.ok(!det.body.numero, "pendente não tem número de CIOT");
      assert.strictEqual(det.body.id_operacao, "ADM000000024");
    });

    await t("219 (ID já cadastrado) -> pendente; consulta com confirmação recupera o CIOT", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { Codigo: ["219"], Mensagem: ["Código de identificação da operação já cadastrado."] } });
      roteirizar("ConsultarCIOTGerado", { status: 500, raw: "" });
      const res = await chamar("emitir", { body: corpo("ADM000000025") });
      assert.strictEqual(res.code, 502, JSON.stringify(res.body));
      assert.strictEqual(linha(res.body.id).status, "pendente");
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000251234", Codigo: ["111"] } });
      const r2 = mk();
      await C.consultarGerado({ body: {}, params: { id: res.body.id }, query: { confirmar: "1" }, user, correlacao: "corr-mtls" }, r2);
      assert.strictEqual(r2.code, 200, JSON.stringify(r2.body));
      assert.strictEqual(linha(res.body.id).numero, "ADM0000000251234");
    });

    await t("HTTP 408/429 sem código -> pendente; 404 (rota) -> nao_enviado", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 408, raw: "" });
      let res = await chamar("emitir", { body: corpo("ADM000000050") });
      assert.strictEqual(res.code, 502);
      assert.strictEqual(linha(res.body.id).status, "pendente");
      roteirizar("DeclaracaoOperacaoTransporte", { status: 429, raw: "" });
      res = await chamar("emitir", { body: corpo("ADM000000051") });
      assert.strictEqual(linha(res.body.id).status, "pendente");
      roteirizar("DeclaracaoOperacaoTransporte", { status: 404, json: { Message: "No HTTP resource was found" } });
      res = await chamar("emitir", { body: corpo("ADM000000052") });
      assert.strictEqual(res.code, 503);
      assert.strictEqual(linha(res.body.id).status, "nao_enviado");
    });

    await t("219 + consulta encontra CIOT: exige confirmação antes de virar oficial", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { Codigo: ["219"], Mensagem: ["já cadastrado"] } });
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000530053", Codigo: ["111"] } });
      const res = await chamar("emitir", { body: corpo("ADM000000053") });
      assert.strictEqual(res.code, 502);
      assert.strictEqual(linha(res.body.id).id_ja_cadastrado, true);
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000530053", Codigo: ["111"] } });
      let c = await chamar("consultarGerado", { params: { id: res.body.id } });
      assert.strictEqual(c.code, 409, JSON.stringify(c.body));
      assert.strictEqual(linha(res.body.id).status, "pendente");
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000530053", Codigo: ["111"] } });
      const r2 = mk();
      await C.consultarGerado({ body: {}, params: { id: res.body.id }, query: { confirmar: "1" }, user, correlacao: "corr-mtls" }, r2);
      assert.strictEqual(r2.code, 200, JSON.stringify(r2.body));
      assert.strictEqual(linha(res.body.id).status, "emitido");
    });

    await t("consulta durante a declaração recebe 409 e não altera o status", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, delay: 300, json: { CodigoIdentificacaoOperacao: "ADM000000054", CodigoVerificador: "0054", Codigo: "110" } });
      const p = chamar("emitir", { body: corpo("ADM000000054") });
      await new Promise((r) => setTimeout(r, 50));
      const row = ciots().find((x) => x.id_operacao === "ADM000000054");
      const c = await chamar("consultarGerado", { params: { id: row.id } });
      assert.strictEqual(c.code, 409);
      const e = await p;
      assert.strictEqual(e.code, 201);
      assert.strictEqual(linha(row.id).status, "emitido");
      assert.strictEqual((await chamar("consultarGerado", { params: { id: row.id } })).code !== 409, true);
    });

    await t("297 recente mantém pendente; após a margem vira nao_registrado e o MESMO ID pode ser reenviado", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, delay: 3000, json: { Codigo: "110" } });
      const res = await chamar("emitir", { body: corpo("ADM000000026") });
      assert.strictEqual(res.code, 502);
      const nao = { status: 200, json: { CodigoIdentificacaoOperacao: "", Codigo: ["297"], Mensagem: ["Código 297 - Rejeição: O CIOT informado não existe na base de dados da ANTT."] } };
      roteirizar("ConsultarCIOTGerado", nao);
      let c = await chamar("consultarGerado", { params: { id: res.body.id } });
      assert.strictEqual(c.code, 409, JSON.stringify(c.body));
      assert.strictEqual(linha(res.body.id).status, "pendente");
      db.update("ciot", (x) => x.id === res.body.id, { declarado_em: new Date(Date.now() - 10 * 60000).toISOString() });
      roteirizar("ConsultarCIOTGerado", nao);
      c = await chamar("consultarGerado", { params: { id: res.body.id } });
      assert.strictEqual(c.code, 404, JSON.stringify(c.body));
      assert.strictEqual(c.body.proxima_acao, "reenviar_mesmo_id");
      assert.strictEqual(linha(res.body.id).status, "nao_registrado");
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000026", CodigoVerificador: "0026", Codigo: "110" } });
      const re = await chamar("emitir", { body: corpo("ADM000000026") });
      assert.strictEqual(re.code, 201, JSON.stringify(re.body));
      assert.strictEqual(re.body.numero, "ADM0000000260026");
    });

    await t("duas solicitações simultâneas com o mesmo ID: só uma chega à ANTT", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, delay: 200, json: { CodigoIdentificacaoOperacao: "ADM000000027", CodigoVerificador: "0027", Codigo: "110" } });
      const req0 = recebidas.length;
      const [a, b] = await Promise.all([chamar("emitir", { body: corpo("ADM000000027") }), chamar("emitir", { body: corpo("ADM000000027") })]);
      assert.deepStrictEqual([a.code, b.code].sort(), [201, 400]);
      assert.strictEqual(recebidas.slice(req0).filter((r) => r.servico === "DeclaracaoOperacaoTransporte").length, 1);
      assert.strictEqual(ciots().filter((c) => c.id_operacao === "ADM000000027").length, 1);
    });

    await t("sequencial experimental simultâneo: IDs distintos", async () => {
      process.env.ANTT_ID_MODO = "sequencial_experimental";
      roteirizar("DeclaracaoOperacaoTransporte", { status: 503, delay: 100, raw: "" }, { status: 503, delay: 100, raw: "" });
      const [a, b] = await Promise.all([chamar("emitir", { body: corpo("") }), chamar("emitir", { body: corpo("") })]);
      process.env.ANTT_ID_MODO = "manual";
      const ids = [linha(a.body.id).id_operacao, linha(b.body.id).id_operacao];
      assert.notStrictEqual(ids[0], ids[1]);
      assert.ok(ids.every((x) => /^[0-9]{12}$/.test(x)));
      assert.strictEqual(a.body.id_experimental, true);
    });

    await t("Idempotency-Key repetida devolve a mesma operação sem nova declaração", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000028", CodigoVerificador: "0028", Codigo: "110" } });
      const comChave = async () => {
        const r = mk();
        await C.emitir({ body: corpo("ADM000000028"), params: {}, query: {}, user, correlacao: "corr-mtls", get: (h) => (h === "Idempotency-Key" ? "chave-ciot-0001" : undefined) }, r);
        return r;
      };
      const a = await comChave();
      const req0 = recebidas.length;
      const b = await comChave();
      assert.strictEqual(a.code, 201);
      assert.strictEqual(b.code, 200);
      assert.strictEqual(b.body.reaproveitado, true);
      assert.strictEqual(b.body.id, a.body.id);
      assert.strictEqual(recebidas.length, req0);
    });

    let ciot29;
    await t("estados inválidos: cancelar/encerrar pendente e encerrar sem peso", async () => {
      const pend = ciots().find((c) => c.status === "pendente");
      assert.strictEqual((await chamar("cancelar", { params: { id: pend.id }, body: { motivo: "x" } })).code, 400);
      assert.strictEqual((await chamar("encerrar", { params: { id: pend.id }, body: { peso_carga: 1 } })).code, 400);
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000029", CodigoVerificador: "0029", Codigo: "110" } });
      ciot29 = (await chamar("emitir", { body: corpo("ADM000000029") })).body;
      const req0 = recebidas.length;
      const r = await chamar("encerrar", { params: { id: ciot29.id }, body: {} });
      assert.strictEqual(r.code, 400);
      assert.match(r.body.error, /PesoCarga/);
      assert.strictEqual(recebidas.length, req0);
    });

    await t("cancelamentos simultâneos: segundo recebe 409 e não chega à ANTT", async () => {
      roteirizar("CancelamentoOperacaoTransporte", { status: 200, delay: 200, json: { Codigo: "110", Protocolo: "PC29" } });
      const req0 = recebidas.length;
      const [a, b] = await Promise.all([
        chamar("cancelar", { params: { id: ciot29.id }, body: { motivo: "duplo" } }),
        chamar("cancelar", { params: { id: ciot29.id }, body: { motivo: "duplo" } }),
      ]);
      assert.deepStrictEqual([a.code, b.code].sort(), [200, 409]);
      assert.strictEqual(recebidas.length - req0, 1);
      assert.strictEqual(linha(ciot29.id).status, "cancelado");
      const de_novo = await chamar("cancelar", { params: { id: ciot29.id }, body: { motivo: "x" } });
      assert.strictEqual(de_novo.code, 400);
      assert.strictEqual((await chamar("encerrar", { params: { id: ciot29.id }, body: { peso_carga: 1 } })).code, 400);
    });

    await t("222 da ANTT (já cancelada) é refletido; encerramento 110 e 251", async () => {
      roteirizar("DeclaracaoOperacaoTransporte",
        { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000030", CodigoVerificador: "0030", Codigo: "110" } },
        { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000031", CodigoVerificador: "0031", Codigo: "110" } },
        { status: 200, json: { CodigoIdentificacaoOperacao: "ADM000000032", CodigoVerificador: "0032", Codigo: "110" } });
      const a = (await chamar("emitir", { body: corpo("ADM000000030") })).body;
      const b = (await chamar("emitir", { body: corpo("ADM000000031") })).body;
      const c = (await chamar("emitir", { body: corpo("ADM000000032") })).body;
      roteirizar("CancelamentoOperacaoTransporte", { status: 200, json: { Codigo: ["222"], Mensagem: ["Rejeição: Operação de Transporte já está cancelada."] } });
      let r = await chamar("cancelar", { params: { id: a.id }, body: { motivo: "x" } });
      assert.strictEqual(r.code, 409);
      assert.strictEqual(linha(a.id).status, "cancelado");
      roteirizar("EncerramentoOperacaoTransporte", { status: 200, json: { Codigo: "110", Protocolo: "PE31", DataEncerramento: "2026-10-15T10:00:00" } });
      r = await chamar("encerrar", { params: { id: b.id }, body: { peso_carga: 25000 } });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.strictEqual(linha(b.id).status, "encerrado");
      assert.strictEqual(linha(b.id).protocolo_encerramento, "PE31");
      assert.deepStrictEqual(recebidas[recebidas.length - 1].body, { CodigoIdentificacaoOperacao: "ADM0000000310031", DadosCarga: { PesoTotalCarga: 25000 } });
      assert.strictEqual((await chamar("encerrar", { params: { id: b.id }, body: { peso_carga: 1 } })).code, 400);
      roteirizar("EncerramentoOperacaoTransporte", { status: 200, json: { Codigo: ["251"], Mensagem: ["Rejeição: Operação de Transporte já está encerrada"] } });
      r = await chamar("encerrar", { params: { id: c.id }, body: { peso_carga: 1 } });
      assert.strictEqual(r.code, 409);
      assert.strictEqual(linha(c.id).status, "encerrado");
    });

    await t("isolamento por empresa: outra empresa não vê nem opera o CIOT", async () => {
      db.insert("empresas", { id: "emp2", razao_social: "OUTRA LTDA", cnpj: "11444777000161" });
      const outro = { id: "u2", empresa_id: "emp2" };
      const alvo = ciots().find((c) => c.empresa_id === "emp1" && c.status === "emitido");
      for (const fn of ["detalhe", "cancelar", "encerrar", "consultarGerado"]) {
        const r = mk();
        await C[fn]({ body: { motivo: "x", peso_carga: 1 }, params: { id: alvo.id }, query: {}, user: outro }, r);
        assert.strictEqual(r.code, 404, fn);
      }
      const l = mk();
      C.listar({ query: {}, user: outro }, l);
      assert.strictEqual(l.body.total, 0);
    });

    await t("MDF-e: não vincula CIOT de outra empresa, pendente ou oficial em manifesto simulado", async () => {
      const M = require("../src/controllers/mdfeController");
      const mdfe = async (u, ciotId, placa = "ABC1D23") => {
        const r = mk();
        await M.emitir({ body: { placa, uf_ini: "PB", uf_fim: "SP", condutores: [{ nome: "MOTORISTA", cpf: "52998224725" }], ciot_id: ciotId }, params: {}, query: {}, user: u, correlacao: "c", get: () => undefined }, r);
        return r;
      };
      const oficial = ciots().find((c) => c.empresa_id === "emp1" && c.status === "emitido" && !c.mdfe_id);
      const pend = ciots().find((c) => c.empresa_id === "emp1" && c.status === "pendente");
      const nMdfe = db.all("mdfe").length;
      let r = await mdfe({ id: "u2", empresa_id: "emp2" }, oficial.id);
      assert.strictEqual(r.code, 400, JSON.stringify(r.body));
      r = await mdfe(user, pend.id);
      assert.strictEqual(r.code, 400, JSON.stringify(r.body));
      r = await mdfe(user, oficial.id); // FISCAL_PROVIDER local = manifesto simulado
      assert.strictEqual(r.code, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /simulado/);
      assert.strictEqual(db.all("mdfe").length, nMdfe);
      assert.strictEqual(linha(oficial.id).mdfe_id, null);
    });

    await t("reinício do servidor com CIOT pendente: outro processo recupera pela consulta", async () => {
      const filho = arq("filho.js");
      fs.writeFileSync(filho, `
        const db = require(${JSON.stringify(path.join(__dirname, "../src/db"))});
        if (!db.get("empresas", (e) => e.id === "emp1")) db.insert("empresas", { id: "emp1", razao_social: "EMPRESA TESTE LTDA", cnpj: "11.222.333/0001-81" });
        const C = require(${JSON.stringify(path.join(__dirname, "../src/controllers/ciotController"))});
        const r = { code: 200 }; r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r);
        const [acao, arg] = process.argv.slice(2);
        const req = { body: acao === "emitir" ? JSON.parse(arg) : {}, params: { id: arg }, query: {}, user: { id: "u1", empresa_id: "emp1" }, correlacao: "reinicio" };
        Promise.resolve(C[acao](req, r)).then(() => { console.log(JSON.stringify({ code: r.code, body: r.body, row: db.get("ciot", (c) => c.id === (r.body && r.body.id) || c.id === arg) })); process.exit(0); });
      `);
      const env = { ...process.env, DATA_DIR: arq("data-reinicio") };
      roteirizar("DeclaracaoOperacaoTransporte", { status: 200, delay: 3000, json: { CodigoIdentificacaoOperacao: "ADM000000040", CodigoVerificador: "0040", Codigo: "110" } });
      // spawn assíncrono: spawnSync travaria o mock, que roda neste processo.
      const exec = (args) => new Promise((resolve, reject) => {
        const p = require("child_process").spawn(process.execPath, [filho, ...args], { env });
        let out = ""; let err = "";
        p.stdout.on("data", (c) => (out += c));
        p.stderr.on("data", (c) => (err += c));
        p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop())) : reject(new Error(err || out))));
      });
      const um = await exec(["emitir", JSON.stringify(corpo("ADM000000040"))]);
      assert.strictEqual(um.code, 502, JSON.stringify(um.body));
      assert.strictEqual(um.row.status, "pendente");
      // processo 1 terminou: "servidor reiniciado"; processo 2 lê o banco do disco
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000400040", Codigo: ["111"] } });
      const dois = await exec(["consultarGerado", um.body.id]);
      assert.strictEqual(dois.code, 200, JSON.stringify(dois.body));
      assert.strictEqual(dois.row.status, "emitido");
      assert.strictEqual(dois.row.numero, "ADM0000000400040");
    });

    await t("config: provider antt, certificado ok, sem senha nem caminho do pfx, sem rede", async () => {
      const req0 = recebidas.length;
      const res = await chamar("config");
      assert.strictEqual(res.code, 200);
      assert.strictEqual(res.body.provider, "antt");
      assert.strictEqual(res.body.ambiente, "homologacao");
      assert.strictEqual(res.body.id_modo, "manual");
      assert.strictEqual(res.body.empresa_cnpj, "11222333000181");
      assert.strictEqual(res.body.certificado.ok, true);
      assert.strictEqual(res.body.certificado.cnpj, "11222333000181");
      assert.ok(res.body.certificado.valido_ate);
      const txt = JSON.stringify(res.body);
      assert.ok(!txt.includes(SENHA), "config vazou a senha");
      assert.ok(!txt.includes(PFX_OK) && !txt.includes("valido.pfx"), "config vazou o caminho do pfx");
      assert.strictEqual(recebidas.length, req0);
    });

    await t("config: senha errada -> certificado.ok false, sem senha; ANTT_ID_MODO inválido não dá 500", async () => {
      const req0 = recebidas.length;
      Object.assign(process.env, { ANTT_PFX_SENHA: "senha-ERRADA-999", ANTT_ID_MODO: "xyz" });
      const res = await chamar("config");
      Object.assign(process.env, { ANTT_PFX_SENHA: SENHA, ANTT_ID_MODO: "manual" });
      assert.strictEqual(res.code, 200);
      assert.strictEqual(res.body.certificado.ok, false);
      assert.match(res.body.certificado.erro, /senha incorreta/);
      assert.strictEqual(res.body.id_modo, null);
      assert.ok(res.body.erro_config);
      const txt = JSON.stringify(res.body);
      assert.ok(!txt.includes("senha-ERRADA-999") && !txt.includes(SENHA));
      assert.strictEqual(recebidas.length, req0);
    });

    await t("evidência: 110 guarda payload_declaracao e resposta_antt; 205 guarda resposta_antt", async () => {
      const ok = linha(emitido.id);
      assert.strictEqual(ok.payload_declaracao.IdOperacaoTransporte, "ADM000000003");
      assert.strictEqual(ok.resposta_antt.Codigo, "110");
      assert.strictEqual(ok.entrada_antt.id_operacao, "ADM000000003");
      assert.strictEqual(ok.entrada_antt.contratante_nome, "CLIENTE CONTRATANTE LTDA");
      assert.strictEqual(ok.entrada_antt.motorista_cpf, "52998224725");
      assert.strictEqual(ok.entrada_antt.valor_contrato, 1000);
      const rej = ciots().find((c) => c.id_operacao === "ADM000000005");
      assert.strictEqual(rej.status, "rejeitado");
      assert.ok(rej.resposta_antt && rej.resposta_antt.Protocolo === "P5");
    });

    await t("listar resume (sem payload/respostas); detalhe traz tudo", async () => {
      const lista = await chamar("listar");
      const item = lista.body.data.find((c) => c.id === emitido.id);
      assert.ok(item);
      for (const k of ["payload_declaracao", "entrada_antt", "resposta_antt", "resposta_consulta"]) assert.ok(!(k in item), k);
      const det = await chamar("detalhe", { params: { id: emitido.id } });
      assert.ok(det.body.payload_declaracao && det.body.entrada_antt && det.body.resposta_antt);
    });

    await t("consulta bem-sucedida guarda resposta_consulta", async () => {
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000030042", Codigo: ["111"] } });
      const res = await chamar("consultarGerado", { params: { id: emitido.id } });
      assert.strictEqual(res.code, 200, JSON.stringify(res.body));
      assert.strictEqual(linha(emitido.id).resposta_consulta.CodigoIdentificacaoOperacao, "ADM0000000030042");
    });

    await t("consulta com CIOT diferente do guardado: avisa divergência e mantém número", async () => {
      roteirizar("ConsultarCIOTGerado", { status: 200, json: { CodigoIdentificacaoOperacao: "ADM0000000039999", Codigo: ["111"] } });
      const res = await chamar("consultarGerado", { params: { id: emitido.id } });
      assert.strictEqual(res.code, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.divergencia, { local: "ADM0000000030042", antt: "ADM0000000039999" });
      assert.strictEqual(res.body.numero, "ADM0000000030042");
      assert.strictEqual(linha(emitido.id).numero, "ADM0000000030042");
      assert.strictEqual(linha(emitido.id).resposta_consulta.divergencia.antt, "ADM0000000039999");
    });

    await t("ANTT sem placa legada: usa 1ª placa de veiculos; filtro por 2ª placa acha", async () => {
      roteirizar("DeclaracaoOperacaoTransporte", {
        status: 200,
        json: { CodigoIdentificacaoOperacao: "ADM0000000A1", CodigoVerificador: "0001", Protocolo: "PA1", Codigo: "110", Mensagem: "Dados inseridos" },
      });
      const { placa, ...semPlaca } = corpo("ADM0000000A1");
      const res = await chamar("emitir", { body: semPlaca });
      assert.strictEqual(res.code, 201, JSON.stringify(res.body));
      assert.strictEqual(linha(res.body.id).placa, "ABC1D23");
      const lista = await chamar("listar", { query: { placa: "xyz9a88" } });
      assert.ok(lista.body.data.some((c) => c.id === res.body.id));
      const nenhum = await chamar("listar", { query: { placa: "ZZZ0Z00" } });
      assert.strictEqual(nenhum.body.data.length, 0);
    });

    await t("banco em disco não contém a senha do certificado", async () => {
      const arqDb = fs.readFileSync(path.join(arq("data"), "fiscal.json"), "utf8");
      assert.ok(!arqDb.includes(SENHA));
    });

    await t("trilha fiscal com correlação e provedor", async () => {
      const logs = db.all("audit_logs", (a) => a.tipo === "fiscal" && a.entidade === "ciot");
      assert.ok(logs.length > 0);
      assert.ok(logs.every((a) => a.correlacao === "corr-mtls" && a.provedor === "antt" && a.ambiente === "homologacao"));
      assert.ok(logs.some((a) => a.status_anterior === "pendente" && a.status_novo === "emitido"));
      assert.ok(logs.some((a) => a.status_novo === "rejeitado" && a.codigo === "205"));
      assert.ok(!JSON.stringify(logs).includes(SENHA));
    });

    await t("T6: corpo de montarCorpoCiotAntt (frontend) -> 110 -> emitido (nomes de campo batem)", async () => {
      const { montarCorpoCiotAntt } = require("../../frontend/src/ciot.js");
      const corpoFront = montarCorpoCiotAntt({
        id_operacao: "adm000000060", // o front põe em maiúsculas
        tipo_operacao: 1,
        contratante_nome: "CLIENTE CONTRATANTE LTDA",
        contratante_doc: "11444777000161",
        contratado_doc: "11222333000181",
        contratado_rntrc: "12345678",
        destinatario_doc: "52998224725",
        motorista_nome: "MOTORISTA",
        motorista_cpf: "52998224725",
        valor_contrato: "1000",
        valor_adiantamento: "0",
        veiculos: [{ placa: "ABC1D23", eixos: "3" }, { placa: "XYZ9A88", eixos: "3" }],
        data_inicio_viagem: diaSP(1),
        data_fim_viagem: diaSP(3),
        tipo_localizacao: "municipio",
        trechos: [{ origem: { municipio: "2507507" }, destino: { municipio: "3550308" }, distancia: "2700" }],
        carga_natureza: "0001",
        carga_tipo: "5",
        carga_peso: "25000",
        tipo_pagamento: 6,
        chave_pix: "a@b.com",
        identificador_pix: "ID1",
      });
      roteirizar("DeclaracaoOperacaoTransporte", {
        status: 200,
        json: { CodigoIdentificacaoOperacao: "ADM000000060", CodigoVerificador: "0060", Codigo: "110" },
      });
      const res = await chamar("emitir", { body: corpoFront });
      assert.strictEqual(res.code, 201, JSON.stringify(res.body));
      assert.strictEqual(linha(res.body.id).status, "emitido");
      assert.strictEqual(res.body.numero, "ADM0000000600060");
    });

    await t("T9: situacaoTransportador e frota — 200 repassa JSON; 207 -> 400 com código; local -> 400", async () => {
      const resp = { Codigo: ["110"], Situacao: "ATIVO", Extra: { a: 1 } };
      roteirizar("ConsultarSituacaoTransportador", { status: 200, json: resp });
      let r = await chamar("situacaoTransportador", { query: { doc: "11222333000181", rntrc: "12345678" } });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, resp);
      let enviado = recebidas[recebidas.length - 1];
      assert.strictEqual(enviado.servico, "ConsultarSituacaoTransportador");
      assert.strictEqual(enviado.body.CpfCnpjInteressado, "11222333000181");
      assert.strictEqual(enviado.body.RNTRCTransportador, "012345678"); // montarSituacao completa para 9 dígitos

      roteirizar("ConsultarSituacaoTransportador", { status: 200, json: { Codigo: ["207"], Mensagem: ["Transportador não encontrado"] } });
      r = await chamar("situacaoTransportador", { query: { doc: "11222333000181", rntrc: "12345678" } });
      assert.strictEqual(r.code, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.codigo, "207");

      const bf = { doc: "11222333000181", rntrc: "12345678", placas: ["ABC1D23", "XYZ9A88"] };
      roteirizar("ConsultarFrotaTransportador", { status: 200, json: { Codigo: ["110"], Placas: ["ABC1D23"] } });
      r = await chamar("frota", { body: bf });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, { Codigo: ["110"], Placas: ["ABC1D23"] });
      enviado = recebidas[recebidas.length - 1];
      assert.strictEqual(enviado.servico, "ConsultarFrotaTransportador");
      assert.deepStrictEqual(enviado.body.Placas, ["ABC1D23", "XYZ9A88"]);

      roteirizar("ConsultarFrotaTransportador", { status: 200, json: { Codigo: ["207"], Mensagem: ["Placa não vinculada"] } });
      r = await chamar("frota", { body: bf });
      assert.strictEqual(r.code, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.codigo, "207");

      process.env.CIOT_PROVIDER = "local";
      const req0 = recebidas.length;
      try {
        r = await chamar("situacaoTransportador", { query: { doc: "11222333000181", rntrc: "12345678" } });
        assert.strictEqual(r.code, 400);
        r = await chamar("frota", { body: bf });
        assert.strictEqual(r.code, 400);
      } finally {
        process.env.CIOT_PROVIDER = "antt";
      }
      assert.strictEqual(recebidas.length, req0);
    });

    console.log(`${n} cenários mTLS ok`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows pode segurar o arquivo; diretório temporário */
    }
    process.exit(process.exitCode || 0);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
