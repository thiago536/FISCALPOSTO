const { v4: uuid } = require("uuid");
const { all, get, insert, update } = require("../db");
const D = require("../utils/documentos");
const { audit } = require("../services/audit");

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// Campo ausente (undefined) ou nulo não altera nada; string vazia limpa campo
// opcional. Assim um PUT parcial não apaga o cadastro.
const informado = (v) => v !== undefined && v !== null;
const semAusentes = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

exports.dashboard = (req, res) => {
  const emp = req.user.empresa_id;
  const start = monthStart();
  const nfes = all("nfe", (n) => n.empresa_id === emp && n.created_at >= start);
  const ctes = all("cte", (n) => n.empresa_id === emp && n.created_at >= start);
  const mdfes = all("mdfe", (n) => n.empresa_id === emp && n.created_at >= start);
  const nfe = {
    autorizadas: nfes.filter((n) => n.status === "autorizada").length,
    canceladas: nfes.filter((n) => n.status === "cancelada").length,
    pendentes: nfes.filter((n) => n.status === "processando").length,
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

const temDocumentos = (empresaId) =>
  ["nfe", "cte", "mdfe", "ciot"].some((t) => get(t, (d) => d.empresa_id === empresaId));

exports.empresaPut = (req, res) => {
  const f = req.body || {};
  const atual = get("empresas", (e) => e.id === req.user.empresa_id);
  if (!atual) return res.status(404).json({ error: "Empresa não encontrada" });

  const uf = informado(f.uf) ? D.exigirUf(f.uf) : atual.uf;
  const patch = semAusentes({
    razao_social: informado(f.razao_social) ? D.exigirTexto(f.razao_social, "Razão social", { min: 2, max: 60 }) : undefined,
    nome_fantasia: informado(f.nome_fantasia) ? String(f.nome_fantasia).trim().slice(0, 60) : undefined,
    ie: informado(f.ie) ? D.normalizarIe(f.ie) : undefined,
    uf: informado(f.uf) ? uf : undefined,
    // cUF sempre derivado da UF: os dois divergindo geram chave de acesso errada.
    cuf: D.CUF[uf],
    municipio: informado(f.municipio) ? D.exigirTexto(f.municipio, "Município", { min: 2, max: 60 }) : undefined,
    cep: informado(f.cep) ? D.exigirCep(f.cep) : undefined,
    logradouro: informado(f.logradouro) ? D.exigirTexto(f.logradouro, "Logradouro", { min: 2, max: 60 }) : undefined,
    numero: informado(f.numero) ? D.exigirTexto(f.numero, "Número", { min: 1, max: 60 }) : undefined,
    bairro: informado(f.bairro) ? D.exigirTexto(f.bairro, "Bairro", { min: 2, max: 60 }) : undefined,
    crt: informado(f.crt) ? D.exigirCrt(f.crt) : undefined,
    fone: informado(f.fone) ? D.somenteDigitos(f.fone) : undefined,
    email: informado(f.email) ? String(f.email).trim().slice(0, 60) : undefined,
    ambiente: informado(f.ambiente) ? D.exigirNumero(f.ambiente, "Ambiente", { min: 1, max: 2 }) : undefined,
  });
  // Município tem de pertencer à UF final (a que já estava ou a nova).
  const cmun = informado(f.cmun) ? f.cmun : atual.cmun;
  if (informado(f.cmun) || informado(f.uf)) patch.cmun = D.exigirMunicipio(cmun, uf);

  if (informado(f.cnpj)) {
    const cnpj = D.exigirDoc(f.cnpj, "CNPJ", { aceitar: ["CNPJ"] });
    if (cnpj !== D.normalizarDoc(atual.cnpj)) {
      // Documento emitido carrega o CNPJ na chave de acesso; trocar depois
      // quebra o vínculo entre o cadastro e o que foi transmitido.
      if (temDocumentos(atual.id)) {
        return res.status(409).json({ error: "CNPJ não pode ser alterado: a empresa já tem documentos emitidos", correlacao: req.correlacao });
      }
      if (get("empresas", (e) => e.id !== atual.id && D.normalizarDoc(e.cnpj) === cnpj)) {
        return res.status(409).json({ error: "CNPJ já cadastrado para outra empresa", correlacao: req.correlacao });
      }
      patch.cnpj = cnpj;
      patch.demo = false; // deixou de ser a empresa fictícia do seed
    }
  }
  update("empresas", (e) => e.id === atual.id, patch);
  audit(req, "atualizar", "empresa", atual.id, Object.keys(patch).join(","));
  return res.json({ ok: true });
};

exports.clientesList = (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const rows = all("clientes", (c) => c.empresa_id === req.user.empresa_id && (
    !q || (c.nome || "").toLowerCase().includes(q) || (c.cpf_cnpj || "").toLowerCase().includes(q)
  )).slice(0, 200);
  return res.json({ data: rows });
};

// Endereço é opcional no cadastro (consumidor de balcão), mas o que vier é
// validado; a emissão real exige o endereço completo (ver validacaoFiscal.js).
function camposCliente(f, base = {}) {
  const uf = informado(f.uf) && f.uf !== "" ? D.exigirUf(f.uf) : (f.uf === "" ? "" : base.uf);
  const cmunBruto = informado(f.cmun) ? f.cmun : base.cmun;
  const out = semAusentes({
    nome: informado(f.nome) ? D.exigirTexto(f.nome, "Nome", { min: 2, max: 60 }) : undefined,
    ie: informado(f.ie) ? D.normalizarIe(f.ie) : undefined,
    uf: informado(f.uf) ? uf : undefined,
    municipio: informado(f.municipio) ? String(f.municipio).trim().slice(0, 60) : undefined,
    cep: informado(f.cep) ? (f.cep === "" ? "" : D.exigirCep(f.cep)) : undefined,
    logradouro: informado(f.logradouro) ? String(f.logradouro).trim().slice(0, 60) : undefined,
    numero: informado(f.numero) ? String(f.numero).trim().slice(0, 60) : undefined,
    bairro: informado(f.bairro) ? String(f.bairro).trim().slice(0, 60) : undefined,
    fone: informado(f.fone) ? D.somenteDigitos(f.fone) : undefined,
    email: informado(f.email) ? String(f.email).trim().slice(0, 60) : undefined,
  });
  if ((informado(f.cmun) || informado(f.uf)) && cmunBruto) out.cmun = D.exigirMunicipio(cmunBruto, uf || undefined);
  else if (f.cmun === "") out.cmun = "";
  return out;
}

exports.clientesCreate = (req, res) => {
  const f = req.body || {};
  const doc = D.exigirDoc(f.cpf_cnpj, "CPF/CNPJ");
  if (!informado(f.nome)) return res.status(400).json({ error: "Nome é obrigatório", campo: "nome" });
  if (get("clientes", (c) => c.empresa_id === req.user.empresa_id && D.normalizarDoc(c.cpf_cnpj) === doc)) {
    return res.status(409).json({ error: "Já existe cliente com este CPF/CNPJ", campo: "cpf_cnpj" });
  }
  const id = uuid();
  insert("clientes", {
    id,
    empresa_id: req.user.empresa_id,
    tipo: D.tipoDoc(doc) === "CPF" ? "F" : "J",
    cpf_cnpj: doc,
    ...camposCliente(f),
    created_at: new Date().toISOString(),
  });
  audit(req, "criar", "cliente", id);
  return res.status(201).json({ id });
};

exports.clientesUpdate = (req, res) => {
  const atual = get("clientes", (c) => c.id === req.params.id && c.empresa_id === req.user.empresa_id);
  if (!atual) return res.status(404).json({ error: "Cliente não encontrado" });
  const f = req.body || {};
  const patch = camposCliente(f, atual);
  if (informado(f.cpf_cnpj)) {
    const doc = D.exigirDoc(f.cpf_cnpj, "CPF/CNPJ");
    if (get("clientes", (c) => c.id !== atual.id && c.empresa_id === atual.empresa_id && D.normalizarDoc(c.cpf_cnpj) === doc)) {
      return res.status(409).json({ error: "Já existe cliente com este CPF/CNPJ", campo: "cpf_cnpj" });
    }
    patch.cpf_cnpj = doc;
    patch.tipo = D.tipoDoc(doc) === "CPF" ? "F" : "J";
  }
  patch.updated_at = new Date().toISOString();
  update("clientes", (c) => c.id === atual.id, patch);
  audit(req, "atualizar", "cliente", atual.id);
  return res.json({ ok: true });
};

exports.produtosList = (req, res) => {
  return res.json({ data: all("produtos", (p) => p.empresa_id === req.user.empresa_id) });
};

function camposProduto(f, exigirTudo) {
  const exige = (campo) => exigirTudo || informado(f[campo]);
  return semAusentes({
    codigo: exige("codigo") ? D.exigirTexto(f.codigo, "Código", { min: 1, max: 60 }) : undefined,
    descricao: exige("descricao") ? D.exigirTexto(f.descricao, "Descrição", { min: 1, max: 120 }) : undefined,
    ncm: exige("ncm") ? D.exigirDigitos(f.ncm, 8, "NCM") : undefined,
    cfop: exige("cfop") ? D.exigirDigitos(f.cfop, 4, "CFOP") : undefined,
    unidade: exige("unidade") ? D.exigirTexto(f.unidade ?? "LT", "Unidade", { min: 1, max: 6 }) : undefined,
    preco: exige("preco") ? D.exigirNumero(f.preco, "Preço", { min: 0, padrao: 0 }) : undefined,
    anp: informado(f.anp) ? (f.anp === "" ? "" : D.exigirDigitos(f.anp, 9, "Código ANP")) : undefined,
    desc_anp: informado(f.desc_anp) ? String(f.desc_anp).trim().slice(0, 95) : undefined,
    cst_icms: exige("cst_icms") ? D.exigirCstIcms(f.cst_icms ?? "00") : undefined,
    aliq_icms: exige("aliq_icms") ? D.exigirNumero(f.aliq_icms, "Alíquota de ICMS", { min: 0, max: 100, padrao: 0 }) : undefined,
  });
}

exports.produtosCreate = (req, res) => {
  const f = req.body || {};
  const campos = camposProduto(f, true);
  if (get("produtos", (p) => p.empresa_id === req.user.empresa_id && p.codigo === campos.codigo)) {
    return res.status(409).json({ error: "Já existe produto com este código", campo: "codigo" });
  }
  const id = uuid();
  insert("produtos", { id, empresa_id: req.user.empresa_id, ...campos, created_at: new Date().toISOString() });
  audit(req, "criar", "produto", id);
  return res.status(201).json({ id });
};

exports.produtosUpdate = (req, res) => {
  const atual = get("produtos", (p) => p.id === req.params.id && p.empresa_id === req.user.empresa_id);
  if (!atual) return res.status(404).json({ error: "Produto não encontrado" });
  const patch = camposProduto(req.body || {}, false);
  if (patch.codigo && get("produtos", (p) => p.id !== atual.id && p.empresa_id === atual.empresa_id && p.codigo === patch.codigo)) {
    return res.status(409).json({ error: "Já existe produto com este código", campo: "codigo" });
  }
  patch.updated_at = new Date().toISOString();
  update("produtos", (p) => p.id === atual.id, patch);
  audit(req, "atualizar", "produto", atual.id);
  return res.json({ ok: true });
};
