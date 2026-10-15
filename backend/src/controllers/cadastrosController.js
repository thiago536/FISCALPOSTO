const { v4: uuid } = require("uuid");
const { all, get, insert, update } = require("../db");
const { onlyDigits, num } = require("../utils/fiscal");
const { audit } = require("../services/audit");

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

exports.dashboard = (req, res) => {
  const emp = req.user.empresa_id;
  const start = monthStart();
  const nfes = all("nfe", (n) => n.empresa_id === emp && n.created_at >= start);
  const ctes = all("cte", (n) => n.empresa_id === emp && n.created_at >= start);
  const mdfes = all("mdfe", (n) => n.empresa_id === emp && n.created_at >= start);
  const nfe = {
    autorizadas: nfes.filter((n) => n.status === "autorizada").length,
    canceladas: nfes.filter((n) => n.status === "cancelada").length,
    pendentes: nfes.filter((n) => n.status === "rascunho").length,
    valor_total: nfes.filter((n) => n.status === "autorizada").reduce((s, n) => s + Number(n.total_nota || 0), 0),
  };
  const cte = {
    autorizados: ctes.filter((n) => n.status === "autorizada").length,
    valor_total: ctes.filter((n) => n.status === "autorizada").reduce((s, n) => s + Number(n.valor_servico || 0), 0),
  };
  const mdfe = {
    ativos: mdfes.filter((n) => n.status === "autorizada").length,
    encerrados: mdfes.filter((n) => n.status === "encerrada").length,
    com_ciot: mdfes.filter((n) => n.ciot_id).length,
  };
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const map = {};
  all("nfe", (n) => n.empresa_id === emp && (n.created_at || "").slice(0, 10) >= since).forEach((n) => {
    const d = n.created_at.slice(0, 10);
    map[d] = map[d] || { data: d, quantidade: 0, valor: 0 };
    map[d].quantidade++;
    map[d].valor += Number(n.total_nota || 0);
  });
  return res.json({ nfe, cte, mdfe, porDia: Object.values(map).sort((a, b) => a.data.localeCompare(b.data)) });
};

exports.empresaGet = (req, res) => {
  return res.json(get("empresas", (e) => e.id === req.user.empresa_id));
};

exports.empresaPut = (req, res) => {
  const f = req.body || {};
  // `update` faz spread do patch sobre a linha, e spread copia `undefined` por
  // cima do valor guardado. Sem a limpeza, um PUT parcial zera o cadastro.
  // `null` também é descartado: cliente JSON manda null por campo em branco, e
  // onlyDigits(null) daria "" e Number(null) daria 0 (crt/ambiente inválidos).
  const semVazios = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
  let patch;
  try {
    patch = semVazios({
      razao_social: f.razao_social,
      nome_fantasia: f.nome_fantasia,
      cnpj: f.cnpj == null ? undefined : onlyDigits(f.cnpj),
      ie: f.ie,
      uf: f.uf,
      cuf: f.cuf,
      municipio: f.municipio,
      cmun: f.cmun,
      cep: f.cep == null ? undefined : onlyDigits(f.cep),
      logradouro: f.logradouro,
      numero: f.numero,
      bairro: f.bairro,
      crt: f.crt == null ? undefined : num(f.crt, 3, "CRT"),
      fone: f.fone,
      email: f.email,
      ambiente: f.ambiente == null ? undefined : num(f.ambiente, 2, "Ambiente"),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  update("empresas", (e) => e.id === req.user.empresa_id, patch);
  audit(req, "atualizar", "empresa", req.user.empresa_id);
  return res.json({ ok: true });
};

exports.clientesList = (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const rows = all("clientes", (c) => c.empresa_id === req.user.empresa_id && (
    !q || (c.nome || "").toLowerCase().includes(q) || (c.cpf_cnpj || "").includes(q)
  )).slice(0, 200);
  return res.json({ data: rows });
};

exports.clientesCreate = (req, res) => {
  const f = req.body || {};
  if (!f.nome || !f.cpf_cnpj) return res.status(400).json({ error: "Nome e CPF/CNPJ são obrigatórios" });
  const id = uuid();
  insert("clientes", {
    id,
    empresa_id: req.user.empresa_id,
    tipo: f.tipo || "J",
    nome: f.nome,
    cpf_cnpj: onlyDigits(f.cpf_cnpj),
    ie: f.ie,
    uf: f.uf,
    municipio: f.municipio,
    cmun: f.cmun,
    cep: onlyDigits(f.cep || ""),
    logradouro: f.logradouro,
    numero: f.numero,
    bairro: f.bairro,
    email: f.email,
    created_at: new Date().toISOString(),
  });
  audit(req, "criar", "cliente", id);
  return res.status(201).json({ id });
};

exports.produtosList = (req, res) => {
  return res.json({ data: all("produtos", (p) => p.empresa_id === req.user.empresa_id) });
};

exports.produtosCreate = (req, res) => {
  const f = req.body || {};
  if (!f.codigo || !f.descricao) return res.status(400).json({ error: "Código e descrição são obrigatórios" });
  let preco;
  let aliqIcms;
  try {
    preco = num(f.preco, 0, "Preço");
    aliqIcms = num(f.aliq_icms, 0, "Alíquota de ICMS");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (preco < 0) return res.status(400).json({ error: "Preço não pode ser negativo" });
  if (aliqIcms < 0 || aliqIcms > 100) return res.status(400).json({ error: "Alíquota de ICMS fora de 0..100" });
  const id = uuid();
  insert("produtos", {
    id,
    empresa_id: req.user.empresa_id,
    codigo: f.codigo,
    descricao: f.descricao,
    ncm: f.ncm,
    cfop: f.cfop,
    unidade: f.unidade || "LT",
    preco,
    anp: f.anp,
    desc_anp: f.desc_anp,
    cst_icms: f.cst_icms || "00",
    aliq_icms: aliqIcms,
    created_at: new Date().toISOString(),
  });
  audit(req, "criar", "produto", id);
  return res.status(201).json({ id });
};
