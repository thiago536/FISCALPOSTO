#!/usr/bin/env node
/**
 * Provisionamento seguro de empresa e usuários (substitui o seed em produção).
 *
 *   npm run provisionar -- --arquivo empresa.json            cria empresa + 1º admin
 *   npm run provisionar -- --arquivo usuario.json --usuario  adiciona usuário a uma empresa
 *
 * empresa.json: { "empresa": { razao_social, nome_fantasia?, cnpj, ie, crt, uf, cmun,
 *                 municipio, cep, logradouro, numero, bairro, fone?, email? },
 *                 "admin": { login, nome, senha } }
 * usuario.json: { "empresa_cnpj": "...", "usuario": { login, nome, senha, perfil: "admin"|"operador" } }
 *
 * O servidor precisa estar PARADO (o banco tem lock de processo único).
 * A senha nunca é impressa; apague o arquivo JSON depois de usar.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: process.env.ENV_FILE || path.join(__dirname, "../.env") });

const args = process.argv.slice(2);
const arg = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};

function falhar(msg) {
  console.error(`ERRO: ${msg}`);
  process.exit(1);
}

const arquivo = arg("--arquivo");
if (!arquivo) falhar("informe --arquivo <dados.json> (veja o cabeçalho de scripts/provisionar.js)");
let dados;
try {
  dados = JSON.parse(fs.readFileSync(path.resolve(arquivo), "utf8"));
} catch (e) {
  falhar(`não foi possível ler ${arquivo}: ${e.message}`);
}

// O provisionamento é o único caminho que pode criar o banco em produção.
process.env.DB_PERMITIR_CRIACAO = "1";
let db;
try {
  db = require("../src/db");
} catch (e) {
  falhar(e.message);
}
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const D = require("../src/utils/documentos");

function validarSenha(senha, login) {
  const s = String(senha || "");
  if (s.length < 12) throw new D.ValidacaoError("senha deve ter ao menos 12 caracteres", "senha");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (classes < 3) throw new D.ValidacaoError("senha deve combinar ao menos 3 entre: minúsculas, maiúsculas, números, símbolos", "senha");
  if (login && s.toLowerCase().includes(String(login).toLowerCase())) throw new D.ValidacaoError("senha não pode conter o login", "senha");
  return s;
}

function validarUsuario(u, perfilPadrao) {
  if (!u || typeof u !== "object") throw new D.ValidacaoError("dados do usuário ausentes", "usuario");
  const login = D.exigirTexto(u.login, "login", { min: 3, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(login)) throw new D.ValidacaoError("login aceita apenas letras, números, ponto, hífen e sublinhado", "login");
  if (db.get("usuarios", (x) => String(x.login).toLowerCase() === login)) throw new D.ValidacaoError(`login "${login}" já existe`, "login");
  const perfil = u.perfil || perfilPadrao;
  if (!["admin", "operador"].includes(perfil)) throw new D.ValidacaoError("perfil deve ser admin ou operador", "perfil");
  return {
    id: uuid(),
    nome: D.exigirTexto(u.nome, "nome", { min: 2, max: 60 }),
    login,
    senha_hash: bcrypt.hashSync(validarSenha(u.senha, login), 12),
    perfil,
    ativo: 1,
    created_at: new Date().toISOString(),
  };
}

function validarEmpresa(e) {
  if (!e || typeof e !== "object") throw new D.ValidacaoError("dados da empresa ausentes", "empresa");
  const cnpj = D.exigirDoc(e.cnpj, "CNPJ da empresa", { aceitar: ["CNPJ"] });
  if (db.get("empresas", (x) => D.normalizarDoc(x.cnpj) === cnpj)) throw new D.ValidacaoError(`empresa com CNPJ ${cnpj} já existe`, "cnpj");
  const uf = D.exigirUf(e.uf);
  const ie = D.normalizarIe(e.ie);
  if (!ie) throw new D.ValidacaoError("inscrição estadual obrigatória (ou ISENTO)", "ie");
  return {
    id: uuid(),
    razao_social: D.exigirTexto(e.razao_social, "razão social", { min: 2, max: 60 }),
    nome_fantasia: e.nome_fantasia ? D.exigirTexto(e.nome_fantasia, "nome fantasia", { min: 1, max: 60 }) : undefined,
    cnpj,
    ie,
    crt: D.exigirCrt(e.crt),
    uf,
    cuf: D.CUF[uf],
    cmun: D.exigirMunicipio(e.cmun, uf),
    municipio: D.exigirTexto(e.municipio, "município", { min: 2, max: 60 }),
    cep: D.exigirCep(e.cep),
    logradouro: D.exigirTexto(e.logradouro, "logradouro", { min: 2, max: 60 }),
    numero: D.exigirTexto(e.numero, "número", { min: 1, max: 60 }),
    bairro: D.exigirTexto(e.bairro, "bairro", { min: 2, max: 60 }),
    fone: e.fone ? D.somenteDigitos(e.fone) : undefined,
    email: e.email,
    ambiente: 2,
    serie_nfe: 1,
    serie_cte: 1,
    serie_mdfe: 1,
    prox_nfe: 1,
    prox_cte: 1,
    prox_mdfe: 1,
    created_at: new Date().toISOString(),
  };
}

try {
  if (args.includes("--usuario")) {
    const cnpj = D.normalizarDoc(dados.empresa_cnpj);
    const empresa = db.get("empresas", (x) => D.normalizarDoc(x.cnpj) === cnpj);
    if (!empresa) throw new D.ValidacaoError(`empresa ${cnpj} não encontrada`, "empresa_cnpj");
    const usuario = { ...validarUsuario(dados.usuario, "operador"), empresa_id: empresa.id };
    db.insert("usuarios", usuario);
    console.log(JSON.stringify({ ok: true, empresa: empresa.razao_social, login: usuario.login, perfil: usuario.perfil }));
  } else {
    const empresa = validarEmpresa(dados.empresa);
    const admin = { ...validarUsuario(dados.admin, "admin"), perfil: "admin", empresa_id: empresa.id };
    db.transaction(() => {
      db.insert("empresas", empresa);
      db.insert("usuarios", admin);
    });
    console.log(JSON.stringify({ ok: true, empresa_id: empresa.id, cnpj: empresa.cnpj, login: admin.login, banco: db.dbPath }));
  }
  console.log("Pronto. Apague o arquivo JSON com a senha.");
} catch (e) {
  falhar(e.message);
}
