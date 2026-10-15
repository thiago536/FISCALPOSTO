const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "emissor-test-"));
process.env.FISCAL_PROVIDER = "focus";
process.env.LOG_LEVEL = "error";

const db = require("../src/db");
const focus = require("../src/services/focus");
const orig = { ...focus };

function carregar(prazo) {
  process.env.FOCUS_PRAZO_404_MS = String(prazo);
  delete require.cache[require.resolve("../src/services/emissor")];
  return require("../src/services/emissor");
}
const err = (s) => new focus.FocusError(s, { mensagem: "x" + s });
const defer = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
let n = 0;
function novo(tipo, extra = {}) {
  const row = { id: `${tipo}-${++n}`, status: "processando", created_at: new Date().toISOString(), ...extra };
  db.insert(tipo, row);
  return row;
}
const st = (tipo, id) => db.get(tipo, (x) => x.id === id).status;
const tick = () => new Promise((r) => setTimeout(r, 20));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("in-flight POST: sincronizar/pendentes nao consultam", async () => {
  const em = carregar(0);
  const row = novo("nfe");
  let calls = 0;
  const d = defer();
  focus.emitir = () => d.p;
  focus.consultar = async () => { calls++; throw err(404); };
  const pe = em.emitir("nfe", row.id, {});
  await em.sincronizar("nfe", row.id);
  await em.sincronizarPendentes();
  assert.strictEqual(calls, 0);
  assert.strictEqual(st("nfe", row.id), "processando");
  d.res({ status: "processando_autorizacao" });
  await pe;
  assert.strictEqual(st("nfe", row.id), "processando");
});

test("404 em linha jovem mantem processando", async () => {
  const em = carregar(1e9);
  const row = novo("nfe");
  focus.consultar = async () => { throw err(404); };
  await em.sincronizar("nfe", row.id);
  assert.strictEqual(st("nfe", row.id), "processando");
});

test("404 com prazo 0 e sem envio vira rejeitada", async () => {
  const em = carregar(0);
  const row = novo("nfe", { created_at: new Date(Date.now() - 50).toISOString() });
  focus.consultar = async () => { throw err(404); };
  await em.sincronizar("nfe", row.id);
  assert.strictEqual(st("nfe", row.id), "rejeitada");
});

test("aplicar stale nao sobrescreve cancelada", async () => {
  const em = carregar(1e9);
  const row = novo("nfe", { status: "cancelada" });
  focus.consultar = async () => ({ status: "autorizado" });
  await em.sincronizar("nfe", row.id);
  assert.strictEqual(st("nfe", row.id), "cancelada");
});

test("cancelamento durante baixar lento permanece cancelada", async () => {
  const em = carregar(1e9);
  const row = novo("nfe");
  const d = defer();
  focus.consultar = async () => ({ status: "autorizado", caminho_xml_nota_fiscal: "/x.xml" });
  focus.baixar = () => d.p;
  const p = em.sincronizar("nfe", row.id);
  await tick();
  db.update("nfe", (x) => x.id === row.id, { status: "cancelada" });
  d.res(Buffer.from("<xml/>"));
  await p;
  assert.strictEqual(st("nfe", row.id), "cancelada");
});

test("MDF-e rejeitada libera ciot; outro ciot intacto", async () => {
  const em = carregar(1e9);
  const m = novo("mdfe", { ciot_id: "c-a" });
  const m2 = novo("mdfe");
  db.insert("ciot", { id: "c-a", mdfe_id: m.id });
  db.insert("ciot", { id: "c-b", mdfe_id: m2.id });
  db.insert("ciot", { id: "c-c", mdfe_id: "outro" });
  focus.consultar = async () => ({ status: "erro_autorizacao", mensagem_sefaz: "erro" });
  await em.sincronizar("mdfe", m.id);
  assert.strictEqual(st("mdfe", m.id), "rejeitada");
  assert.strictEqual(db.get("ciot", (c) => c.id === "c-a").mdfe_id, null);
  assert.strictEqual(db.get("ciot", (c) => c.id === "c-b").mdfe_id, m2.id);
  assert.strictEqual(db.get("ciot", (c) => c.id === "c-c").mdfe_id, "outro");
});

test("MDF-e rejeitada nao toca ciot vinculado a outro MDF-e", async () => {
  const em = carregar(1e9);
  const m = novo("mdfe", { ciot_id: "c-d" });
  db.insert("ciot", { id: "c-d", mdfe_id: "outro-mdfe" });
  focus.consultar = async () => ({ status: "erro_autorizacao" });
  await em.sincronizar("mdfe", m.id);
  assert.strictEqual(db.get("ciot", (c) => c.id === "c-d").mdfe_id, "outro-mdfe");
});

test("emitir 429 mantem processando", async () => {
  const em = carregar(1e9);
  const row = novo("nfe");
  focus.emitir = async () => { throw err(429); };
  await em.emitir("nfe", row.id, {});
  assert.strictEqual(st("nfe", row.id), "processando");
});

test("emitir 422 vira rejeitada", async () => {
  const em = carregar(1e9);
  const row = novo("nfe");
  focus.emitir = async () => { throw err(422); };
  await em.emitir("nfe", row.id, {});
  assert.strictEqual(st("nfe", row.id), "rejeitada");
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    Object.assign(focus, orig);
    try { await fn(); console.log("ok   -", name); }
    catch (e) { fail++; console.log("FAIL -", name, "\n", e.message); }
  }
  console.log(`${tests.length - fail}/${tests.length}`);
  process.exit(fail ? 1 : 0);
})();
