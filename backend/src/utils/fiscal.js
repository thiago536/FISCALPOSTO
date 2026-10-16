const { dvChave, normalizarDoc } = require("./documentos");

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function escapeXml(v = "") {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Ausente vira zero, mas lixo não: zerar um NaN silenciosamente foi o que
// deixou passar documento fiscal com valor inválido.
function money(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) throw new Error(`Valor monetário inválido: ${n}`);
  return v.toFixed(2);
}

// Conversão numérica que recusa lixo. `Number(v || 0)` não serve: para v="abc"
// o `||` não dispara (string é truthy) e o resultado é NaN.
function num(v, padrao = 0, campo = "valor") {
  const n = Number(v ?? padrao);
  if (!Number.isFinite(n)) throw new Error(`${campo} inválido: ${v}`);
  return n;
}

function pad(n, size) {
  return String(n).padStart(size, "0");
}

// DV da chave de acesso; aceita CNPJ alfanumérico (caractere vale ASCII − 48).
function dvMod11(base) {
  return String(dvChave(base));
}

function gerarCnf() {
  return pad(Math.floor(Math.random() * 99999999), 8);
}

function montarChave({ cuf, cnpj, modelo, serie, numero, tpEmis = "1", aamm }) {
  const agora = new Date();
  const aa = aamm || `${String(agora.getFullYear()).slice(2)}${pad(agora.getMonth() + 1, 2)}`;
  const cnf = gerarCnf();
  const base = `${pad(cuf, 2)}${aa}${pad(normalizarDoc(cnpj), 14)}${pad(modelo, 2)}${pad(serie, 3)}${pad(numero, 9)}${tpEmis}${cnf}`;
  return base + dvMod11(base);
}

function nowIso() {
  return new Date().toISOString();
}

function sqlNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// O layout do MDF-e exige CIOT no padrão [0-9]{12}. Número definitivo vem do
// integrador ANTT; este é o provisório do modo local.
function gerarNumeroCiot() {
  return Date.now().toString().slice(-10) + pad(Math.floor(Math.random() * 100), 2);
}

// dhEmi precisa do deslocamento real do fuso. Rotular um instante UTC como
// -03:00 joga a emissão 3h no futuro e causa rejeição 703.
function dhEmi(iso) {
  let d = iso ? new Date(iso) : new Date();
  if (!Number.isFinite(d.getTime())) d = new Date();
  const offMin = -d.getTimezoneOffset();
  const sinal = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`
    + `T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`
    + `${sinal}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

const FORMAS_PAGTO = {
  PIX: "PIX",
  TED: "TED/DOC",
  CARTAO: "Cartão",
  DINHEIRO: "Dinheiro",
  OUTROS: "Outros",
};

module.exports = {
  onlyDigits,
  escapeXml,
  money,
  num,
  pad,
  montarChave,
  nowIso,
  sqlNow,
  dhEmi,
  gerarNumeroCiot,
  FORMAS_PAGTO,
};
