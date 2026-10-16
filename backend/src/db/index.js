/**
 * Banco em arquivo JSON, carregado inteiro na memória.
 *
 * Garantias:
 * - Arquivo ilegível NUNCA é tratado como banco vazio: o processo para com
 *   diagnóstico e o arquivo original fica intacto.
 * - Gravação durável: escreve `.tmp`, fsync, guarda a versão anterior em
 *   `.bak` e só então troca o arquivo principal.
 * - Se a gravação falhar, a alteração em memória é desfeita (memória e disco
 *   não divergem).
 * - Um arquivo `.lock` impede dois processos de usarem o mesmo banco.
 *
 * Limite conhecido: um único processo escreve. As operações são síncronas, então
 * dentro do processo cada insert/update é atômico em relação ao event loop;
 * fluxos assíncronos precisam reler o registro antes de gravar (ver emissor.js).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const PRODUCAO = process.env.NODE_ENV === "production";

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "../../data"));
const dbPath = path.join(dataDir, "fiscal.json");
const tmpPath = dbPath + ".tmp";
const bakPath = dbPath + ".bak";
const lockPath = dbPath + ".lock";

const TABELAS = [
  "empresas", "usuarios", "clientes", "produtos",
  "nfe", "nfe_itens", "cte", "mdfe", "mdfe_condutores", "mdfe_percurso", "mdfe_docs",
  "ciot", "ciot_seq", "idempotencia", "audit_logs",
];

class DbError extends Error {
  constructor(message) {
    super(message);
    this.name = "DbError";
  }
}

const empty = () => Object.fromEntries(TABELAS.map((t) => [t, []]));

function lerJson(arquivo) {
  const texto = fs.readFileSync(arquivo, "utf8");
  const obj = JSON.parse(texto);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("raiz não é um objeto");
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) throw new Error(`tabela "${k}" não é uma lista`);
  }
  return obj;
}

function diagnostico(arquivo, err) {
  const tam = fs.existsSync(arquivo) ? fs.statSync(arquivo).size : 0;
  const extras = [tmpPath, bakPath].filter((p) => fs.existsSync(p)).map((p) => `  - ${p} (${fs.statSync(p).size} bytes)`);
  return [
    `Banco de dados ilegível: ${arquivo} (${tam} bytes): ${err.message}`,
    "O servidor NÃO vai iniciar para não sobrescrever dados. Nada foi alterado no disco.",
    extras.length ? `Arquivos para recuperação:\n${extras.join("\n")}` : "Não há .tmp nem .bak para recuperação.",
    "Para recuperar: pare o servidor, guarde uma cópia do arquivo danificado e substitua-o por uma versão válida (ex.: o .bak).",
  ].join("\n");
}

function load() {
  if (fs.existsSync(dbPath)) {
    try {
      return { ...empty(), ...lerJson(dbPath) };
    } catch (err) {
      throw new DbError(diagnostico(dbPath, err));
    }
  }
  // Principal ausente com .tmp presente: queda entre as duas trocas de nome do
  // persist(). O .tmp só existe completo e sincronizado nesse ponto, então é o
  // estado mais recente; ainda assim só é usado se for JSON válido.
  if (fs.existsSync(tmpPath)) {
    try {
      const obj = lerJson(tmpPath);
      fs.renameSync(tmpPath, dbPath);
      console.warn(`Banco recuperado de ${tmpPath} (interrupção durante gravação anterior).`);
      return { ...empty(), ...obj };
    } catch (err) {
      throw new DbError(diagnostico(tmpPath, err));
    }
  }
  if (fs.existsSync(bakPath)) {
    throw new DbError(
      `Banco principal ausente (${dbPath}), mas existe ${bakPath}. ` +
      "O servidor não vai criar um banco vazio por cima. Se o .bak for a versão desejada, renomeie-o para fiscal.json."
    );
  }
  // Em produção um banco novo só nasce pelo provisionamento (scripts/provisionar.js),
  // para que um DATA_DIR errado não suba um sistema vazio sem ninguém perceber.
  if (PRODUCAO && process.env.DB_PERMITIR_CRIACAO !== "1") {
    throw new DbError(
      `Banco não encontrado em ${dbPath}. Em produção ele é criado pelo provisionamento: ` +
      "npm run provisionar (ver README). Confira DATA_DIR."
    );
  }
  return empty();
}

function processoVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

let lockAdquirido = false;
function adquirirLock() {
  if (lockAdquirido) return;
  const conteudo = JSON.stringify({ pid: process.pid, host: os.hostname(), desde: new Date().toISOString() });
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      fs.writeFileSync(lockPath, conteudo, { flag: "wx" });
      lockAdquirido = true;
      process.on("exit", () => {
        try {
          const atual = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (atual.pid === process.pid) fs.unlinkSync(lockPath);
        } catch { /* lock já removido */ }
      });
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let dono = null;
      try { dono = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* lock ilegível = abandonado */ }
      if (dono && dono.pid === process.pid) { lockAdquirido = true; return; }
      const outroHost = dono && dono.host && dono.host !== os.hostname();
      if (dono && (outroHost || processoVivo(dono.pid))) {
        throw new DbError(
          `Banco em uso por outro processo (pid ${dono.pid} em ${dono.host}, desde ${dono.desde}). ` +
          `Dois processos gravando o mesmo arquivo perdem dados. Pare o outro processo ou, se ele não existe mais, apague ${lockPath}.`
        );
      }
      fs.unlinkSync(lockPath); // dono morto: lock abandonado
    }
  }
  throw new DbError(`Não foi possível obter o lock ${lockPath}`);
}

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
adquirirLock();
let data = load();
let inTx = false;

function escreverDuravel(arquivo, texto) {
  const fd = fs.openSync(arquivo, "w");
  try {
    fs.writeFileSync(fd, texto, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function persist() {
  if (inTx) return;
  escreverDuravel(tmpPath, JSON.stringify(data, null, 2));
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, bakPath);
  fs.renameSync(tmpPath, dbPath);
}

// Aplica uma mutação e grava; se a gravação falhar, desfaz na memória.
function mutar(table, aplicar) {
  if (!data[table]) data[table] = [];
  const anterior = data[table];
  data[table] = aplicar(anterior.slice());
  try {
    persist();
  } catch (err) {
    data[table] = anterior;
    throw err;
  }
}

function all(table, pred) {
  const rows = data[table] || [];
  return pred ? rows.filter(pred) : rows.slice();
}

function get(table, pred) {
  return (data[table] || []).find(pred) || null;
}

function insert(table, row) {
  mutar(table, (rows) => { rows.push(row); return rows; });
  return row;
}

function insertMany(table, novos) {
  mutar(table, (rows) => { rows.push(...novos); return rows; });
}

function update(table, pred, patch) {
  let n = 0;
  const alvo = (data[table] || []).some(pred);
  if (!alvo) return 0;
  mutar(table, (rows) => rows.map((row) => {
    if (!pred(row)) return row;
    n++;
    return { ...row, ...patch };
  }));
  return n;
}

// Tudo ou nada: grava uma vez no fim; erro (ou falha de gravação) restaura o
// estado anterior. Transação aninhada participa da externa.
function transaction(fn) {
  if (inTx) return fn();
  const snapshot = structuredClone(data);
  inTx = true;
  try {
    const result = fn();
    inTx = false;
    persist();
    return result;
  } catch (err) {
    inTx = false;
    data = snapshot;
    throw err;
  }
}

module.exports = {
  get data() { return data; },
  all, get, insert, insertMany, update, transaction, persist,
  dbPath, bakPath, tmpPath, lockPath, DbError,
};
