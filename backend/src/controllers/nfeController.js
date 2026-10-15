const { v4: uuid } = require("uuid");
const { all, get, insert, insertMany, update, transaction } = require("../db");
const { montarChave, onlyDigits, num } = require("../utils/fiscal");
const { infNfe } = require("../services/xml");
const sefaz = require("../services/sefaz");
const emissor = require("../services/emissor");
const focusPayload = require("../services/focusPayload");
const { deCliente } = focusPayload;
const { resumo, sincronizar, pdf } = require("./comum");
const { audit } = require("../services/audit");

function paginar(rows, page, limit) {
  const total = rows.length;
  const start = (page - 1) * limit;
  return { total, page, pages: Math.ceil(total / limit) || 1, data: rows.slice(start, start + limit) };
}

exports.listar = (req, res) => {
  const { data_ini, data_fim, documento, status, cliente, page = 1, limit = 50 } = req.query;
  let rows = all("nfe", (n) => n.empresa_id === req.user.empresa_id);
  if (data_ini) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) >= data_ini);
  if (data_fim) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) <= data_fim);
  if (documento) rows = rows.filter((n) => String(n.numero) === String(Number(documento)));
  if (status) rows = rows.filter((n) => n.status === status);
  if (cliente) rows = rows.filter((n) => (n.dest_nome || "").toLowerCase().includes(String(cliente).toLowerCase()));
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.json(paginar(rows, Number(page), Number(limit)));
};

exports.detalhe = async (req, res) => {
  let nota = get("nfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (nota && nota.status === "processando" && emissor.modo() === "focus") nota = await emissor.sincronizar("nfe", nota.id);
  if (!nota) return res.status(404).json({ error: "NF-e não encontrada" });
  const itens = all("nfe_itens", (i) => i.nfe_id === nota.id).sort((a, b) => a.item - b.item);
  return res.json({ nota, itens });
};

exports.emitir = async (req, res) => {
  const f = req.body || {};
  const itensIn = Array.isArray(f.itens) ? f.itens : [];
  if (!f.dest_nome && !f.cliente_id) return res.status(400).json({ error: "Destinatário obrigatório" });
  if (!f.dest_doc && !f.cliente_id) return res.status(400).json({ error: "Destinatário obrigatório" });
  if (!itensIn.length) return res.status(400).json({ error: "Informe ao menos um item" });
  const real = emissor.modo() === "focus";

  try {
    let payload = null;
    const result = transaction(() => {
      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      let dest = { nome: f.dest_nome, doc: f.dest_doc, uf: f.dest_uf, municipio: f.dest_municipio, ie: f.dest_ie };
      if (f.cliente_id) {
        const c = get("clientes", (x) => x.id === f.cliente_id && x.empresa_id === e.id);
        if (!c) throw new Error("Cliente não encontrado");
        dest = { ...deCliente(c), nome: f.dest_nome || c.nome, doc: f.dest_doc || c.cpf_cnpj, uf: f.dest_uf || c.uf };
      }
      if (!dest.nome || !onlyDigits(dest.doc)) throw new Error("Destinatário obrigatório");
      if (real && (!dest.logradouro || !onlyDigits(dest.cmun) || !dest.uf)) {
        throw new Error("Para emissão real o destinatário precisa estar cadastrado com endereço e código IBGE do município");
      }
      const itens = itensIn.map((it, i) => {
        const qtd = num(it.quantidade, NaN, `quantidade do item ${i + 1}`);
        const vu = num(it.valor_unitario, NaN, `valor unitário do item ${i + 1}`);
        const total = Number((qtd * vu).toFixed(2));
        const cst = it.icms_cst || "00";
        const aliq = num(it.icms_aliq, 0, `alíquota de ICMS do item ${i + 1}`);
        // CST 60/61 (ICMS já recolhido/monofásico) não destaca imposto.
        const base = cst === "60" || cst === "61" ? 0 : total;
        return {
          id: uuid(),
          item: i + 1,
          codigo: it.codigo,
          descricao: it.descricao,
          ncm: it.ncm,
          cfop: it.cfop || "5656",
          unidade: it.unidade || "LT",
          quantidade: qtd,
          valor_unitario: vu,
          valor_total: total,
          anp: it.anp,
          desc_anp: it.desc_anp,
          uf_consumo: it.uf_consumo || dest.uf || e.uf,
          icms_cst: cst,
          icms_base: base,
          icms_aliq: aliq,
          icms_valor: Number(((base * aliq) / 100).toFixed(2)),
        };
      });
      // Asserção positiva: NaN falha em todas as comparações, então `qtd <= 0`
      // deixaria passar item sem quantidade e gerar documento com vNF zerado.
      if (itens.some((i) => !i.descricao || !(i.quantidade > 0) || !(i.valor_unitario >= 0) || !(i.valor_total >= 0))) {
        throw new Error("Itens inválidos: informe descrição, quantidade maior que zero e valor unitário numérico");
      }
      const totalProd = itens.reduce((s, i) => s + i.valor_total, 0);
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const destDoc = onlyDigits(dest.doc);
      const nfe = {
        ...f,
        ambiente: emissor.ambiente(e),
        natureza: f.natureza || "VENDA DE COMBUSTIVEL",
        forma_pagamento: f.forma_pagamento,
        dest_doc: destDoc,
        total_produtos: totalProd,
        total_nota: totalProd,
        emitido_em: emitidoEm,
      };
      const base = {
        id,
        empresa_id: e.id,
        modelo: "55",
        ambiente: nfe.ambiente,
        natureza: nfe.natureza,
        cliente_id: f.cliente_id || null,
        dest_nome: dest.nome,
        dest_doc: destDoc,
        dest_uf: dest.uf,
        dest_municipio: dest.municipio,
        dest_ie: dest.ie,
        dest_endereco: f.dest_endereco || [dest.logradouro, dest.numero, dest.bairro].filter(Boolean).join(", ") || undefined,
        forma_pagamento: f.forma_pagamento || "DINHEIRO",
        total_produtos: totalProd,
        total_nota: totalProd,
        emitido_em: emitidoEm,
        usuario_id: req.user.id,
        created_at: emitidoEm,
      };

      if (real) {
        // Número, série e chave chegam da Focus quando a SEFAZ autorizar.
        payload = focusPayload.nfe(e, nfe, itens, dest);
        insert("nfe", { ...base, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
        insertMany("nfe_itens", itens.map((it) => ({ ...it, nfe_id: id })));
        return { id };
      }

      const numero = e.prox_nfe;
      const serie = e.serie_nfe;
      const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "55", serie, numero });
      const xml = infNfe(e, { ...nfe, numero, serie }, itens, chave);
      const sef = sefaz.autorizar("nfe", { ...nfe, numero, serie, chave, itens });
      insert("nfe", {
        ...base,
        numero,
        serie,
        chave,
        protocolo: sef.protocolo,
        status: sef.ok ? "autorizada" : "rejeitada",
        motivo: sef.xMotivo,
        xml,
        autorizado_em: sef.ok ? emitidoEm : null,
      });
      insertMany("nfe_itens", itens.map((it) => ({ ...it, nfe_id: id })));
      if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_nfe: numero + 1 });
      return { id };
    });
    const row = real ? await emissor.emitir("nfe", result.id, payload) : get("nfe", (n) => n.id === result.id);
    audit(req, "emitir", "nfe", row.id, row.status);
    return res.status(201).json(resumo(row));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.cancelar = async (req, res) => {
  const nota = get("nfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!nota) return res.status(404).json({ error: "NF-e não encontrada" });
  if (nota.status !== "autorizada") return res.status(400).json({ error: "Somente NF-e autorizada pode ser cancelada" });
  try {
    if (emissor.modo() === "focus") {
      const r = await emissor.cancelar("nfe", nota, (req.body || {}).justificativa);
      audit(req, "cancelar", "nfe", nota.id);
      return res.json({ ok: true, motivo: r.mensagem_sefaz });
    }
  } catch (err) {
    return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
  const sef = sefaz.cancelar(nota);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("nfe", (n) => n.id === nota.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
  audit(req, "cancelar", "nfe", nota.id);
  return res.json({ ok: true, motivo: sef.xMotivo });
};

exports.xml = (req, res) => {
  const nota = get("nfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!nota || !nota.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${nota.chave || "nfe"}.xml"`);
  return res.send(nota.xml);
};

exports.sincronizar = sincronizar("nfe", "NF-e");
exports.pdf = pdf("nfe", "NF-e");
