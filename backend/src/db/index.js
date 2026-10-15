const fs = require("fs");
const path = require("path");

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "../../data"));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "fiscal.json");

const empty = () => ({
  empresas: [],
  usuarios: [],
  clientes: [],
  produtos: [],
  nfe: [],
  nfe_itens: [],
  cte: [],
  mdfe: [],
  mdfe_condutores: [],
  mdfe_percurso: [],
  mdfe_docs: [],
  ciot: [],
  audit_logs: [],
});

function load() {
  if (!fs.existsSync(dbPath)) return empty();
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
  } catch {
    return empty();
  }
}

let data = load();
let inTx = false;

function persist() {
  if (inTx) return;
  const tmp = dbPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, dbPath);
}

function all(table, pred) {
  const rows = data[table] || [];
  return pred ? rows.filter(pred) : rows.slice();
}

function get(table, pred) {
  return all(table, pred)[0] || null;
}

function insert(table, row) {
  if (!data[table]) data[table] = [];
  data[table].push(row);
  persist();
  return row;
}

function insertMany(table, rows) {
  if (!data[table]) data[table] = [];
  data[table].push(...rows);
  persist();
}

function update(table, pred, patch) {
  let n = 0;
  data[table] = (data[table] || []).map((row) => {
    if (pred(row)) {
      n++;
      return { ...row, ...patch };
    }
    return row;
  });
  if (n) persist();
  return n;
}

function transaction(fn) {
  const snapshot = JSON.parse(JSON.stringify(data));
  inTx = true;
  try {
    const result = fn();
    inTx = false;
    persist();
    return result;
  } catch (err) {
    data = snapshot;
    inTx = false;
    persist();
    throw err;
  }
}

module.exports = { data, all, get, insert, insertMany, update, transaction, dbPath, persist };
