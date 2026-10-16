/**
 * E2E do caminho de emissão real (FISCAL_PROVIDER=focus) contra um servidor
 * Focus falso. Sobe o mock e a aplicação sozinho; usa DATA_DIR temporário,
 * então data/fiscal.json não é tocado.   Uso: node tests/e2e-focus.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startMock } = require("./focus-mock");

const TOKEN = "test";
let BASE;
let jwt = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function req(method, p, { body, raw } = {}) {
  const headers = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let parsed = text;
  if (!raw) {
    try { parsed = JSON.parse(text); } catch { /* texto */ }
  }
  return { status: res.status, body: parsed, text, buf, headers: res.headers };
}

async function waitFor(fn, ms = 8000) {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error("timeout esperando condição");
    await sleep(200);
  }
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`FAIL  ${name}\n      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

const need = (v, what) => {
  if (v === null || v === undefined) throw new Error(`pré-requisito ausente: ${what}`);
  return v;
};

const ENDERECO = { uf: "SP", municipio: "Campinas", cmun: "3509502", cep: "13015100", logradouro: "Avenida Francisco Glicerio", numero: "1250", bairro: "Centro" };
const ITEM = { codigo: "GASOLINA", descricao: "Gasolina C Comum", ncm: "27101259", cfop: "5656", unidade: "LT", quantidade: 100, valor_unitario: 5.5, anp: "320101001", desc_anp: "GASOLINA C COMUM", icms_cst: "60", icms_aliq: 0 };
const CHAVE_NFE = "35261011222333000181550010000000011000000010";
const CONDUTOR = { nome: "JOAO BATISTA DA SILVA", cpf: "11144477735" };
const JUST = "Cancelamento de teste automatizado";

async function iniciarApp(mock, dataDir) {
  const port = await freePort();
  // Env do filho montado explicitamente: nada de produção nem certificado real vaza de .env/shell.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "test",
    PORT: String(port),
    HOST: "127.0.0.1",
    CIOT_PROVIDER: "local",
    // .env inexistente: dotenv não carrega nada da máquina (PFX, tokens).
    ENV_FILE: path.join(dataDir, "sem-env-de-proposito"),
    FOCUS_AMBIENTE: "homologacao",
    ANTT_AMBIENTE: "homologacao",
    FISCAL_PROVIDER: "focus",
    FOCUS_TOKEN: TOKEN,
    FOCUS_URL: mock.url,
    FOCUS_POLL_MS: "500",
    FOCUS_PRAZO_404_MS: "0",
    DATA_DIR: dataDir,
    JWT_SECRET: "e2e-focus-secret",
  };
  const child = spawn(process.execPath, [path.join(__dirname, "../src/app.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let saida = "";
  child.stdout.on("data", (d) => (saida += d));
  child.stderr.on("data", (d) => (saida += d));
  BASE = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`app encerrou (${child.exitCode}):\n${saida}`);
      try { return (await fetch(BASE + "/api/health")).ok; } catch { return false; }
    }, 15000);
  } catch (e) {
    child.kill();
    throw e;
  }
  return child;
}

async function main() {
  const mock = await startMock({ token: TOKEN });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiscal-focus-"));
  const app = await iniciarApp(mock, dataDir);
  console.log(`PostoFiscal E2E Focus — app ${BASE}, mock ${mock.url}\n`);

  const st = {};
  const emitirNfe = (extra = {}) => req("POST", "/api/nfe", { body: { cliente_id: st.cliente, itens: [{ ...ITEM, produto_id: st.produto }], ...extra } });
  const getNfe = async (id) => (await req("GET", "/api/nfe?limit=200")).body.data.find((n) => n.id === id);

  try {
    await test("login e cadastro de clientes (completo e sem endereço)", async () => {
      const l = await req("POST", "/api/auth/login", { body: { usuario: "admin", senha: "Admin@2026" } });
      assert.strictEqual(l.status, 200, l.text);
      jwt = l.body.token;
      const mk = async (nome, doc, extra) => {
        const r = await req("POST", "/api/cadastros/clientes", { body: { tipo: "J", nome, cpf_cnpj: doc, ie: "123456789012", ...extra } });
        assert.strictEqual(r.status, 201, r.text);
        return r.body.id;
      };
      // Empresa de teste (CNPJ fictício, válido por dígito verificador) tira a flag demo do seed.
      const emp = await req("PUT", "/api/cadastros/empresa", { body: { cnpj: "12345678000195" } });
      assert.strictEqual(emp.status, 200, emp.text);
      const prod = await req("POST", "/api/cadastros/produtos", { body: { codigo: "GASOLINA-T", descricao: "Gasolina C Comum", ncm: "27101259", cfop: "5656", unidade: "LT", preco: 5.5, anp: "320101001", desc_anp: "GASOLINA C COMUM", cst_icms: "60", aliq_icms: 0 } });
      assert.strictEqual(prod.status, 201, prod.text);
      st.produto = prod.body.id;
      st.cliente = await mk("TRANSPORTES SAO JUDAS LTDA", "11444777000161", ENDERECO);
      st.rejeitar = await mk("REJEITAR", "11222333000181", ENDERECO);
      st.semEnd = await mk("SEM ENDERECO LTDA", "45997418000153", { uf: "SP" });
    });

    await test("NF-e: destinatário sem endereço devolve 400 e nada é enviado à Focus", async () => {
      const antes = mock.received.length;
      const r = await emitirNfe({ cliente_id: st.semEnd });
      assert.strictEqual(r.status, 400, r.text);
      assert.strictEqual(mock.received.length, antes);
    });

    await test("NF-e: emite -> processando, payload chega à Focus", async () => {
      const r = await emitirNfe();
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.status, "processando", `${r.body.status}: ${r.body.motivo}`);
      assert.strictEqual(r.body.chave, null);
      st.nfe = r.body.id;
      const rec = mock.received.find((x) => x.ref === st.nfe);
      assert.ok(rec, "payload não chegou ao mock");
      assert.strictEqual(rec.tipo, "nfe");
      assert.strictEqual(rec.payload.nome_destinatario, "TRANSPORTES SAO JUDAS LTDA");
      assert.strictEqual(rec.payload.items.length, 1);
      assert.strictEqual(rec.payload.items[0].combustivel_codigo_anp, "320101001");
      assert.strictEqual(rec.payload.valor_total, 550);
    });

    await test("NF-e: sincronizar -> autorizada com chave, número, protocolo e XML oficial", async () => {
      const r = await req("POST", `/api/nfe/${need(st.nfe, "nfe")}/sincronizar`);
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.body.status, "autorizada", r.text);
      assert.ok(/^\d{44}$/.test(r.body.chave), `chave sem prefixo/44 dígitos: ${r.body.chave}`);
      assert.strictEqual(r.body.numero, 1);
      assert.ok(r.body.protocolo, "protocolo ausente");
      const d = await req("GET", `/api/nfe/${st.nfe}`);
      assert.strictEqual(d.body.nota.xml_oficial, true);
      assert.ok(d.body.nota.autorizado_em);
      const x = await req("GET", `/api/nfe/${st.nfe}/xml`, { raw: true });
      assert.strictEqual(x.status, 200);
      assert.ok(x.text.includes(`<chave>${r.body.chave}</chave>`), "XML não é o baixado do mock");
    });

    await test("NF-e: PDF (DANFE) baixado da Focus", async () => {
      const r = await req("GET", `/api/nfe/${st.nfe}/pdf`, { raw: true });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok((r.headers.get("content-type") || "").includes("application/pdf"));
      assert.ok(r.buf.subarray(0, 5).toString() === "%PDF-", "não é PDF");
    });

    await test("NF-e: rejeição da SEFAZ vira rejeitada com cstat e motivo", async () => {
      const r = await emitirNfe({ cliente_id: st.rejeitar });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.status, "processando");
      const s = await req("POST", `/api/nfe/${r.body.id}/sincronizar`);
      assert.strictEqual(s.body.status, "rejeitada", s.text);
      assert.ok(String(s.body.motivo).includes("Rejeicao"), s.body.motivo);
      const n = await getNfe(r.body.id);
      assert.strictEqual(n.cstat, "999");
      assert.strictEqual(n.chave, null);
      const pdf = await req("GET", `/api/nfe/${r.body.id}/pdf`);
      assert.strictEqual(pdf.status, 404);
    });

    await test("NF-e: cancelar com justificativa curta devolve 400 (sem chamar a Focus)", async () => {
      const r = await req("POST", `/api/nfe/${st.nfe}/cancelar`, { body: { justificativa: "curta" } });
      assert.strictEqual(r.status, 400, r.text);
      assert.ok(String(r.body.error).includes("15 a 255"), r.text);
      assert.strictEqual(mock.docs.get(`nfe/${st.nfe}`).status, "autorizado");
    });

    await test("NF-e: cancelar com justificativa válida -> cancelada", async () => {
      const r = await req("POST", `/api/nfe/${st.nfe}/cancelar`, { body: { justificativa: JUST } });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(mock.docs.get(`nfe/${st.nfe}`).justificativa, JUST);
      const d = await req("GET", `/api/nfe/${st.nfe}`);
      assert.strictEqual(d.body.nota.status, "cancelada");
      assert.ok(d.body.nota.cancelado_em);
      const again = await req("POST", `/api/nfe/${st.nfe}/cancelar`, { body: { justificativa: JUST } });
      assert.strictEqual(again.status, 400);
    });

    await test("CT-e: validações de emissão real (RNTRC e chave de NF-e) devolvem 400", async () => {
      const base = { rem_cliente_id: st.cliente, dest_cliente_id: st.cliente, valor_servico: 1000 };
      const a = await req("POST", "/api/cte", { body: { ...base, chaves_nfe: [CHAVE_NFE] } });
      assert.strictEqual(a.status, 400, a.text);
      const b = await req("POST", "/api/cte", { body: { ...base, rntrc: "12345678" } });
      assert.strictEqual(b.status, 400, b.text);
    });

    await test("CT-e: emite -> processando -> sincronizar -> autorizada + PDF", async () => {
      const r = await req("POST", "/api/cte", {
        body: { rem_cliente_id: st.cliente, dest_cliente_id: st.cliente, valor_servico: 2450.75, icms_aliq: 12, rntrc: "12345678", chaves_nfe: [CHAVE_NFE], carga: "OLEO DIESEL", valor_carga: 5000, peso_kg: 1000 },
      });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.status, "processando");
      st.cte = r.body.id;
      const rec = mock.received.find((x) => x.ref === st.cte);
      assert.strictEqual(rec.tipo, "cte");
      assert.strictEqual(rec.payload.valor_total, 2450.75);
      assert.deepStrictEqual(rec.payload.nfes, [{ chave_nfe: CHAVE_NFE }]);
      const s = await req("POST", `/api/cte/${st.cte}/sincronizar`);
      assert.strictEqual(s.body.status, "autorizada", s.text);
      assert.ok(/^\d{44}$/.test(s.body.chave), s.body.chave);
      const d = await req("GET", `/api/cte/${st.cte}`);
      assert.strictEqual(d.body.cte.xml_oficial, true);
      const p = await req("GET", `/api/cte/${st.cte}/pdf`, { raw: true });
      assert.strictEqual(p.status, 200);
      assert.ok(p.buf.subarray(0, 5).toString() === "%PDF-");
      st.cteChave = s.body.chave;
    });

    await test("MDF-e: validações de emissão real devolvem 400", async () => {
      const r = await req("POST", "/api/mdfe", {
        body: { placa: "ABC1D23", uf_ini: "SP", uf_fim: "MG", condutores: [CONDUTOR], documentos: [{ tipo: "nfe", chave: CHAVE_NFE }] },
      });
      assert.strictEqual(r.status, 400, r.text);
    });

    await test("MDF-e: emite -> processando -> sincronizar -> autorizada", async () => {
      const r = await req("POST", "/api/mdfe", {
        body: {
          placa: "ABC1D23", uf_veiculo: "SP", uf_ini: "SP", uf_fim: "MG", rntrc: "12345678",
          valor_carga: 3337.45, peso_kg: 1000, tara_kg: 8000,
          descarregamento_municipio: "Belo Horizonte", descarregamento_cmun: "3106200",
          condutores: [CONDUTOR], percurso: ["MG"],
          documentos: [{ tipo: "nfe", chave: CHAVE_NFE }, { tipo: "cte", chave: st.cteChave }],
        },
      });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.status, "processando", r.text);
      st.mdfe = r.body.id;
      const rec = mock.received.find((x) => x.ref === st.mdfe);
      assert.strictEqual(rec.tipo, "mdfe");
      assert.strictEqual(rec.payload.modal_rodoviario.placa_veiculo, "ABC1D23");
      assert.strictEqual(rec.payload.modal_rodoviario.condutores[0].cpf, CONDUTOR.cpf);
      const s = await req("POST", `/api/mdfe/${st.mdfe}/sincronizar`);
      assert.strictEqual(s.body.status, "autorizada", s.text);
      assert.ok(/^\d{44}$/.test(s.body.chave), s.body.chave);
      const p = await req("GET", `/api/mdfe/${st.mdfe}/pdf`, { raw: true });
      assert.strictEqual(p.status, 200);
    });

    await test("MDF-e: encerrar -> encerrada, mock recebe data/UF/município", async () => {
      const r = await req("POST", `/api/mdfe/${need(st.mdfe, "mdfe")}/encerrar`, { body: {} });
      assert.strictEqual(r.status, 200, r.text);
      const enc = mock.docs.get(`mdfe/${st.mdfe}`).encerramento;
      assert.strictEqual(enc.sigla_uf, "MG");
      assert.strictEqual(enc.nome_municipio, "Belo Horizonte");
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(enc.data), enc.data);
      const d = await req("GET", `/api/mdfe/${st.mdfe}`);
      assert.strictEqual(d.body.mdfe.status, "encerrada");
      assert.ok(d.body.mdfe.encerrado_em);
      const again = await req("POST", `/api/mdfe/${st.mdfe}/encerrar`, { body: {} });
      assert.strictEqual(again.status, 400);
    });

    await test("poller: NF-e é autorizada sem sincronização manual", async () => {
      const r = await emitirNfe();
      assert.strictEqual(r.body.status, "processando");
      const n = await waitFor(async () => {
        const x = await getNfe(r.body.id); // listagem não sincroniza
        return x && x.status === "autorizada" ? x : null;
      });
      assert.ok(n.chave && n.protocolo);
      assert.strictEqual(n.xml_oficial, true);
    });

    await test("Focus 5xx na emissão: NF-e fica processando e não vira rejeitada", async () => {
      mock.state.fail = "5xx";
      const r = await emitirNfe();
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.status, "processando", r.text);
      assert.ok(String(r.body.motivo).includes("Aguardando"), r.body.motivo);
      st.nfe5xx = r.body.id;
      await sleep(1300); // poller (500 ms) tenta e falha
      const s = await req("POST", `/api/nfe/${st.nfe5xx}/sincronizar`);
      assert.strictEqual(s.body.status, "processando", s.text);
    });

    await test("falha de rede (conexão derrubada): continua processando", async () => {
      mock.state.fail = "drop";
      const r = await emitirNfe();
      assert.strictEqual(r.body.status, "processando", r.text);
      st.nfeDrop = r.body.id;
      await sleep(1000);
      assert.strictEqual((await getNfe(st.nfeDrop)).status, "processando");
    });

    await test("Focus volta: documentos nunca recebidos viram rejeitada (404), sem travar", async () => {
      mock.state.fail = null;
      for (const id of [st.nfe5xx, st.nfeDrop]) {
        const n = await waitFor(async () => {
          const x = await getNfe(id);
          return x && x.status !== "processando" ? x : null;
        });
        assert.strictEqual(n.status, "rejeitada");
        assert.ok(String(n.motivo).includes("não recebido"), n.motivo);
      }
    });
  } finally {
    app.kill();
    await mock.close();
    await sleep(200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignora */ }
  }

  const falhas = results.filter((t) => !t.ok);
  console.log(`\n${"-".repeat(60)}\nTotal: ${results.length}   Passou: ${results.length - falhas.length}   Falhou: ${falhas.length}`);
  for (const f of falhas) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(falhas.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Erro fatal na suíte:", err);
  process.exit(1);
});
