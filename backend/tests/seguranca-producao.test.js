// Trava contra envio acidental de certificado/token reais a produção. Sem rede, sem PFX.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
// antt.js carrega ../db, que abre/trava o fiscal.json já no require: isola antes de qualquer require do projeto.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "seg-"));
const { validarConfiguracao } = require("../src/config");

let n = 0;
const pendentes = [];
// Aceita teste síncrono ou async; falha em qualquer um derruba o processo (exit 1).
const t = (nome, fn) => {
  pendentes.push(Promise.resolve(fn()).then(() => { n++; console.log("ok -", nome); }));
};

const antt = require("../src/services/antt");
const aplicarEnv = (vars) => {
  const antes = {};
  for (const k of Object.keys(vars)) antes[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return () => { for (const k of Object.keys(vars)) antes[k] === undefined ? delete process.env[k] : (process.env[k] = antes[k]); };
};
const comEnv = (vars, fn) => {
  const restaurar = aplicarEnv(vars);
  try { return fn(); } finally { restaurar(); }
};
const lanca = (vars, re) => comEnv(vars, () => assert.throws(() => antt.verificarCertificado(), (e) => e.tipo === "configuracao" && re.test(e.message)));

t("homologacao com host de producao e rejeitado", () => {
  lanca({ ANTT_AMBIENTE: "homologacao", ANTT_BASE_URL: "https://appservices.antt.gov.br/pefServices/api" }, /não permitido/);
});
t("homologacao com host qualquer e rejeitado", () => {
  lanca({ ANTT_AMBIENTE: "homologacao", ANTT_BASE_URL: "https://evil.example.com/api" }, /não permitido/);
});
t("producao com host de homologacao e rejeitado", () => {
  lanca({ NODE_ENV: "production", ALLOW_PRODUCAO: "sim", ANTT_AMBIENTE: "producao", ANTT_BASE_URL: "https://appservices-hml.antt.gov.br/pefServices/api" }, /não permitido/);
});
t("host com sufixo enganoso e rejeitado", () => {
  lanca({ NODE_ENV: "production", ALLOW_PRODUCAO: "sim", ANTT_AMBIENTE: "producao", ANTT_BASE_URL: "https://appservices.antt.gov.br.evil.com/api" }, /não permitido/);
});

t("producao sem ALLOW_PRODUCAO falha", () => {
  const { erros } = validarConfiguracao({ NODE_ENV: "production", FOCUS_AMBIENTE: "producao", JWT_SECRET: "x".repeat(40) });
  assert.ok(erros.some((e) => /ALLOW_PRODUCAO=sim/.test(e)));
  const r = validarConfiguracao({ NODE_ENV: "production", ANTT_AMBIENTE: "producao", JWT_SECRET: "x".repeat(40) });
  assert.ok(r.erros.some((e) => /ALLOW_PRODUCAO=sim/.test(e)));
});
t("producao com ALLOW_PRODUCAO=sim nao acusa o opt-in", () => {
  const { erros } = validarConfiguracao({ NODE_ENV: "production", ANTT_AMBIENTE: "producao", ALLOW_PRODUCAO: "sim", JWT_SECRET: "x".repeat(40) });
  assert.ok(!erros.some((e) => /ALLOW_PRODUCAO/.test(e)));
});
t("NODE_ENV=test com producao falha mesmo com ALLOW_PRODUCAO=sim", () => {
  const { erros } = validarConfiguracao({ NODE_ENV: "test", FOCUS_AMBIENTE: "producao", ALLOW_PRODUCAO: "sim" });
  assert.ok(erros.some((e) => /NODE_ENV=test/.test(e)));
});

// ---- guarda em tempo de chamada (independe da validação de partida)
const focus = require("../src/services/focus");
const lancaFocus = (vars, re) => comEnv({ FOCUS_TOKEN: "t", FOCUS_AMBIENTE: "homologacao", FOCUS_URL: undefined, ...vars }, () => assert.throws(() => focus.config(), re));
const okFocus = (vars) => comEnv({ FOCUS_TOKEN: "t", FOCUS_AMBIENTE: "homologacao", FOCUS_URL: undefined, ...vars }, () => focus.config());

t("antt producao sem NODE_ENV=production+ALLOW_PRODUCAO=sim falha na chamada", () => {
  lanca({ NODE_ENV: "test", ALLOW_PRODUCAO: "sim", ANTT_AMBIENTE: "producao", ANTT_BASE_URL: undefined }, /ALLOW_PRODUCAO/);
  lanca({ NODE_ENV: "production", ALLOW_PRODUCAO: undefined, ANTT_AMBIENTE: "producao", ANTT_BASE_URL: undefined }, /ALLOW_PRODUCAO/);
  lanca({ NODE_ENV: "production", ALLOW_PRODUCAO: "SIM", ANTT_AMBIENTE: "producao", ANTT_BASE_URL: undefined }, /ALLOW_PRODUCAO/);
});
t("focus producao sem NODE_ENV=production+ALLOW_PRODUCAO=sim falha na chamada", () => {
  lancaFocus({ NODE_ENV: "test", ALLOW_PRODUCAO: "sim", FOCUS_AMBIENTE: "producao" }, /ALLOW_PRODUCAO/);
  lancaFocus({ NODE_ENV: "production", ALLOW_PRODUCAO: undefined, FOCUS_AMBIENTE: "producao" }, /ALLOW_PRODUCAO/);
  assert.strictEqual(okFocus({ NODE_ENV: "production", ALLOW_PRODUCAO: "sim", FOCUS_AMBIENTE: "producao" }).base, "https://api.focusnfe.com.br");
});
t("focus: FOCUS_URL so loopback e fora de producao", () => {
  const msg = /FOCUS_URL/;
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "https://api.focusnfe.com.br" }, msg);
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "http://evil.example.com" }, msg);
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "http://localhost@evil.example.com" }, msg);
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "http://127.0.0.1@evil.example.com" }, msg);
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "http://user:pw@127.0.0.1:9" }, msg);
  lancaFocus({ NODE_ENV: "test", FOCUS_URL: "http://localhost.evil.com" }, msg);
  lancaFocus({ NODE_ENV: "production", ALLOW_PRODUCAO: "sim", FOCUS_AMBIENTE: "producao", FOCUS_URL: "http://127.0.0.1:9" }, msg);
  assert.strictEqual(okFocus({ NODE_ENV: "test", FOCUS_URL: "  HTTP://LocalHost:9/  " }).base, "http://localhost:9");
  assert.strictEqual(okFocus({ NODE_ENV: "test", FOCUS_URL: "http://127.0.0.1:9" }).base, "http://127.0.0.1:9");
  assert.strictEqual(okFocus({ NODE_ENV: "test", FOCUS_URL: "http://[::1]:9" }).base, "http://[::1]:9");
});
t("antt: user@host, ponto final, caixa e espacos no ANTT_BASE_URL", () => {
  const prod = { NODE_ENV: "production", ALLOW_PRODUCAO: "sim", ANTT_AMBIENTE: "producao" };
  lanca({ ...prod, ANTT_BASE_URL: "https://appservices.antt.gov.br@evil.example.com/api" }, /não permitido/);
  lanca({ ...prod, ANTT_BASE_URL: "https://evil.example.com@appservices.antt.gov.br/api" }, /credenciais/);
  lanca({ ...prod, ANTT_BASE_URL: "https://appservices.antt.gov.br./api" }, /não permitido/);
  lanca({ NODE_ENV: "test", ANTT_AMBIENTE: "homologacao", ANTT_BASE_URL: "https://appservices-hml.antt.gov.br./api" }, /não permitido/);
  lanca({ NODE_ENV: "test", ANTT_AMBIENTE: "homologacao", ANTT_BASE_URL: "https://localhost.evil.com/api" }, /não permitido/);
  // caixa e espaços são normalizados: host oficial continua aceito (só falha adiante, por falta do PFX)
  comEnv({ NODE_ENV: "test", ANTT_AMBIENTE: " HOMOLOGACAO ".trim(), ANTT_BASE_URL: "  HTTPS://APPSERVICES-HML.ANTT.GOV.BR/pefServices/api/  ", ANTT_PFX_PATH: undefined }, () =>
    assert.throws(() => antt.verificarCertificado(), (e) => e.tipo === "configuracao" && !/não permitido|credenciais/.test(e.message)));
});
t("antt: host proibido falha ANTES de ler o certificado (postJson)", async () => {
  const lidos = [];
  const orig = [fs.readFileSync, fs.statSync];
  const PFX = String.raw`C:\nao-existe\sentinela-antt.pfx`;
  fs.readFileSync = function (f, ...r) { lidos.push(String(f)); return orig[0].call(this, f, ...r); };
  fs.statSync = function (f, ...r) { lidos.push(String(f)); return orig[1].call(this, f, ...r); };
  const restaurar = aplicarEnv({ NODE_ENV: "test", ANTT_AMBIENTE: "homologacao", ANTT_BASE_URL: "https://evil.example.com/api", ANTT_PFX_PATH: PFX, ANTT_PFX_SENHA: "x" });
  try {
    await assert.rejects(antt.consultarCiotGerado({}), (e) => /não permitido/.test(e.message));
  } finally {
    restaurar();
    fs.readFileSync = orig[0];
    fs.statSync = orig[1];
  }
  assert.ok(!lidos.some((f) => f.includes("sentinela-antt")), "PFX foi acessado antes do host guard");
});

Promise.all(pendentes).then(() => {
  console.log(`
${n} testes ok`);
}).catch((e) => { console.error(e); process.exit(1); });
