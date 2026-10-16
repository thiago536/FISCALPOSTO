/**
 * Validação e normalização de documentos e códigos cadastrais.
 *
 * Só regras de FORMATO publicadas oficialmente (dígitos verificadores, tabelas
 * IBGE). Nada aqui decide tributação.
 *
 * CNPJ alfanumérico (IN RFB 2.229/2024): 12 posições [0-9A-Z] + 2 DV numéricos.
 * O DV usa o mesmo módulo 11 do CNPJ numérico, convertendo cada caractere para
 * (código ASCII − 48): '0'..'9' → 0..9, 'A' → 17 ... 'Z' → 42. CNPJ só com
 * dígitos é caso particular do mesmo cálculo.
 */

class ValidacaoError extends Error {
  constructor(mensagem, campo) {
    super(mensagem);
    this.name = "ValidacaoError";
    this.status = 400;
    this.campo = campo;
  }
}

const CUF = {
  RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17",
  MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29",
  MG: "31", ES: "32", RJ: "33", SP: "35",
  PR: "41", SC: "42", RS: "43",
  MS: "50", MT: "51", GO: "52", DF: "53",
};

const somenteDigitos = (v) => String(v ?? "").replace(/\D/g, "");

// Remove máscara e espaços; mantém letras (CNPJ alfanumérico) em maiúsculas.
function normalizarDoc(v) {
  return String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const valorCaractere = (c) => c.charCodeAt(0) - 48;

function dvMod11(base, pesos) {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += valorCaractere(base[i]) * pesos[i];
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function cnpjValido(v) {
  const c = normalizarDoc(v);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;
  if (/^(\d)\1{13}$/.test(c)) return false; // 00000000000000, 11111111111111...
  const dv1 = dvMod11(c.slice(0, 12), PESOS_CNPJ_1);
  const dv2 = dvMod11(c.slice(0, 12) + dv1, PESOS_CNPJ_2);
  return c.slice(12) === `${dv1}${dv2}`;
}

function cpfValido(v) {
  const c = somenteDigitos(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

// CPF tem 11 dígitos e nunca letras; o resto é tratado como CNPJ.
function tipoDoc(v) {
  const n = normalizarDoc(v);
  return n.length === 11 && /^\d+$/.test(n) ? "CPF" : "CNPJ";
}

function docValido(v) {
  return tipoDoc(v) === "CPF" ? cpfValido(v) : cnpjValido(v);
}

function exigirDoc(v, campo, { aceitar = ["CPF", "CNPJ"] } = {}) {
  const n = normalizarDoc(v);
  if (!n) throw new ValidacaoError(`${campo}: informe CPF ou CNPJ`, campo);
  const tipo = tipoDoc(n);
  if (!aceitar.includes(tipo)) throw new ValidacaoError(`${campo}: ${aceitar.join(" ou ")} esperado`, campo);
  if (!docValido(n)) throw new ValidacaoError(`${campo}: ${tipo} inválido (dígito verificador não confere)`, campo);
  return n;
}

function exigirUf(v, campo = "UF") {
  const uf = String(v ?? "").trim().toUpperCase();
  if (!CUF[uf]) throw new ValidacaoError(`${campo} inválida: ${v ?? "(vazia)"}`, campo);
  return uf;
}

// Código IBGE do município: 7 dígitos, os dois primeiros são o código da UF.
function exigirMunicipio(cmun, uf, campo = "Código IBGE do município") {
  const c = somenteDigitos(cmun);
  if (c.length !== 7) throw new ValidacaoError(`${campo} deve ter 7 dígitos`, campo);
  if (uf && c.slice(0, 2) !== CUF[uf]) {
    throw new ValidacaoError(`${campo} ${c} não pertence à UF ${uf} (esperado prefixo ${CUF[uf]})`, campo);
  }
  return c;
}

function exigirCep(v, campo = "CEP") {
  const c = somenteDigitos(v);
  if (c.length !== 8 || c === "00000000") throw new ValidacaoError(`${campo} deve ter 8 dígitos`, campo);
  return c;
}

// IE: "ISENTO" ou 2 a 14 dígitos. O DV da IE é diferente em cada UF e NÃO é
// conferido aqui (pendência documentada); a SEFAZ confere na emissão.
function normalizarIe(v, campo = "Inscrição estadual") {
  if (v == null || String(v).trim() === "") return "";
  const s = String(v).trim().toUpperCase();
  if (s === "ISENTO") return s;
  const d = somenteDigitos(s);
  if (d.length < 2 || d.length > 14 || d.length !== s.replace(/[.\-/\s]/g, "").length) {
    throw new ValidacaoError(`${campo} inválida: use ISENTO ou de 2 a 14 dígitos`, campo);
  }
  return d;
}

// Placa antiga (AAA9999) ou Mercosul (AAA9A99).
function exigirPlaca(v, campo = "Placa") {
  const p = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p)) throw new ValidacaoError(`${campo} inválida: ${v ?? "(vazia)"}`, campo);
  return p;
}

// RNTRC: 8 ou 9 dígitos (o manual PEF completa 8 dígitos com zero à esquerda).
function normalizarRntrc(v, campo = "RNTRC") {
  if (v == null || String(v).trim() === "") return "";
  const d = somenteDigitos(v);
  if (d.length < 8 || d.length > 9) throw new ValidacaoError(`${campo} deve ter 8 ou 9 dígitos`, campo);
  return d;
}

const CRTS = new Set([1, 2, 3, 4]);
function exigirCrt(v) {
  const n = Number(v);
  if (!CRTS.has(n)) throw new ValidacaoError("CRT deve ser 1, 2, 3 ou 4", "crt");
  return n;
}

// Códigos de CST do ICMS (tabela B) e CSOSN existentes no layout da NF-e 4.00,
// incluindo os de monofasia de combustíveis (02, 15, 53, 61). Só confere que o
// código existe; QUAL usar é decisão do contador.
const CST_ICMS = new Set(["00", "02", "10", "15", "20", "30", "40", "41", "50", "51", "53", "60", "61", "70", "90"]);
const CSOSN = new Set(["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"]);
function exigirCstIcms(v, campo = "CST/CSOSN do ICMS") {
  const s = String(v ?? "").trim();
  if (!CST_ICMS.has(s) && !CSOSN.has(s)) throw new ValidacaoError(`${campo} inexistente: ${v ?? "(vazio)"}`, campo);
  return s;
}

function exigirDigitos(v, tamanho, campo) {
  const d = somenteDigitos(v);
  if (d.length !== tamanho) throw new ValidacaoError(`${campo} deve ter ${tamanho} dígitos`, campo);
  return d;
}

// Chave de acesso de NF-e/CT-e/MDF-e: 44 posições; CNPJ do emitente (posições
// 7–20) pode ser alfanumérico. DV módulo 11 com pesos 2..9 da direita para a
// esquerda, cada caractere valendo (ASCII − 48), como no CNPJ alfanumérico.
function dvChave(base43) {
  let soma = 0;
  let peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += valorCaractere(base43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function chaveAcessoValida(v) {
  const c = String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9]{6}[0-9A-Z]{14}[0-9]{24}$/.test(c)) return false;
  return Number(c[43]) === dvChave(c.slice(0, 43));
}

function exigirChave(v, campo = "Chave de acesso") {
  const c = String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!chaveAcessoValida(c)) throw new ValidacaoError(`${campo} inválida (44 posições com dígito verificador)`, campo);
  return c;
}

function exigirNumero(v, campo, { min = -Infinity, max = Infinity, padrao } = {}) {
  const bruto = v == null || v === "" ? padrao : v;
  const n = Number(bruto);
  if (bruto == null || !Number.isFinite(n)) throw new ValidacaoError(`${campo} inválido: ${v ?? "(vazio)"}`, campo);
  if (n < min || n > max) throw new ValidacaoError(`${campo} fora do intervalo ${min}..${max}`, campo);
  return n;
}

function exigirTexto(v, campo, { min = 1, max = 60 } = {}) {
  const s = String(v ?? "").trim();
  if (s.length < min || s.length > max) throw new ValidacaoError(`${campo} deve ter de ${min} a ${max} caracteres`, campo);
  return s;
}

module.exports = {
  ValidacaoError,
  CUF,
  somenteDigitos,
  normalizarDoc,
  cnpjValido,
  cpfValido,
  docValido,
  tipoDoc,
  exigirDoc,
  exigirUf,
  exigirMunicipio,
  exigirCep,
  normalizarIe,
  exigirPlaca,
  normalizarRntrc,
  exigirCrt,
  exigirCstIcms,
  exigirDigitos,
  exigirNumero,
  dvChave,
  chaveAcessoValida,
  exigirChave,
  exigirTexto,
};
