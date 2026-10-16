const { v4: uuid } = require("uuid");
const { all, get, insert, insertMany, update, transaction } = require("../db");
const { montarChave, num } = require("../utils/fiscal");
const D = require("../utils/documentos");
const { infNfe } = require("../services/xml");
const sefaz = require("../services/sefaz");
const emissor = require("../services/emissor");
const focusPayload = require("../services/focusPayload");
const { exigirEmpresaApta, exigirParteCompleta } = require("../services/validacaoFiscal");
const { deCliente } = focusPayload;
const C = require("./comum");
const { audit, auditFiscal } = require("../services/audit");

function paginar(rows, page, limit) {
  const total = rows.length;
  const start = (page - 1) * limit;
  return { total, page, pages: Math.ceil(total / limit) || 1, data: rows.slice(start, start + limit) };
}

const FORMAS = new Set(["DINHEIRO", "CHEQUE", "CARTAO", "CREDITO", "DEBITO", "BOLETO", "PIX", "TED", "PRAZO", "OUTROS"]);

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
  if (!nota) return res.status(404).json({ error: "NF-e não encontrada" });
  if (nota.status === "processando" && !nota.simulado && emissor.modo() === "focus") {
    nota = await emissor.sincronizar("nfe", nota.id, C.ctxDe(req));
  }
  const itens = all("nfe_itens", (i) => i.nfe_id === nota.id).sort((a, b) => a.item - b.item);
  return res.json({ nota, itens });
};

// Item a partir do cadastro de produto (fonte única dos dados fiscais) ou, só
// no modo local, a partir dos campos enviados pela tela.
function montarItem(it, i, e, real, destUf) {
  const n = i + 1;
  let fiscal;
  if (it.produto_id) {
    const p = get("produtos", (x) => x.id === it.produto_id && x.empresa_id === e.id);
    if (!p) throw new D.ValidacaoError(`Produto do item ${n} não encontrado`, `itens[${i}].produto_id`);
    fiscal = {
      produto_id: p.id, codigo: p.codigo, descricao: p.descricao, ncm: p.ncm, cfop: p.cfop, unidade: p.unidade,
      anp: p.anp, desc_anp: p.desc_anp, cst: p.cst_icms, aliq: p.aliq_icms,
    };
  } else if (real) {
    throw new D.ValidacaoError(`Item ${n}: na emissão real o item precisa vir do cadastro de produtos (produto_id)`, `itens[${i}].produto_id`);
  } else {
    fiscal = {
      produto_id: null, codigo: it.codigo, descricao: it.descricao, ncm: it.ncm, cfop: it.cfop || "5656", unidade: it.unidade || "LT",
      anp: it.anp, desc_anp: it.desc_anp, cst: it.icms_cst || "00", aliq: num(it.icms_aliq, 0, `alíquota de ICMS do item ${n}`),
    };
  }
  const cst = D.exigirCstIcms(fiscal.cst, `CST do item ${n}`);
  if (real) {
    D.exigirDigitos(fiscal.ncm, 8, `NCM do item ${n}`);
    D.exigirDigitos(fiscal.cfop, 4, `CFOP do item ${n}`);
  }
  const qtd = num(it.quantidade, NaN, `quantidade do item ${n}`);
  const vu = num(it.valor_unitario, NaN, `valor unitário do item ${n}`);
  const total = Number((qtd * vu).toFixed(2));
  const aliq = num(fiscal.aliq, 0, `alíquota de ICMS do item ${n}`);
  if (aliq < 0 || aliq > 100) throw new D.ValidacaoError(`Alíquota de ICMS do item ${n} fora de 0..100`, `itens[${i}]`);
  // CST 60/61 (ICMS já recolhido/monofásico) não destaca imposto próprio.
  const base = cst === "60" || cst === "61" ? 0 : total;
  return {
    id: uuid(),
    item: n,
    produto_id: fiscal.produto_id,
    codigo: fiscal.codigo,
    descricao: fiscal.descricao,
    ncm: fiscal.ncm,
    cfop: fiscal.cfop,
    unidade: fiscal.unidade,
    quantidade: qtd,
    valor_unitario: vu,
    valor_total: total,
    anp: fiscal.anp,
    desc_anp: fiscal.desc_anp,
    uf_consumo: it.uf_consumo || destUf || e.uf,
    icms_cst: cst,
    icms_base: base,
    icms_aliq: aliq,
    icms_valor: Number(((base * aliq) / 100).toFixed(2)),
  };
}

exports.emitir = async (req, res) => {
  const f = req.body || {};
  const itensIn = Array.isArray(f.itens) ? f.itens : [];
  if (!f.cliente_id && (!f.dest_nome || !f.dest_doc)) return res.status(400).json({ error: "Destinatário obrigatório" });
  if (!itensIn.length) return res.status(400).json({ error: "Informe ao menos um item" });
  const real = emissor.modo() === "focus";
  const forma = String(f.forma_pagamento || "DINHEIRO").toUpperCase();
  if (!FORMAS.has(forma)) return res.status(400).json({ error: `Forma de pagamento inválida: ${f.forma_pagamento}`, campo: "forma_pagamento" });
  const ctx = C.ctxDe(req);

  let payload = null;
  let reaproveitado = null;
  try {
    const idemp = C.chaveIdempotencia(req);
    const result = transaction(() => {
      reaproveitado = C.documentoJaCriado(req, "nfe", idemp);
      if (reaproveitado) return { id: reaproveitado.id };

      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      if (real) exigirEmpresaApta(e);
      let dest;
      if (f.cliente_id) {
        const c = get("clientes", (x) => x.id === f.cliente_id && x.empresa_id === e.id);
        if (!c) throw new D.ValidacaoError("Cliente não encontrado", "cliente_id");
        // Na emissão real o destinatário é exatamente o do cadastro: nada da
        // tela sobrescreve documento, UF ou endereço que vai para a SEFAZ.
        dest = real ? deCliente(c) : { ...deCliente(c), nome: f.dest_nome || c.nome, doc: f.dest_doc || c.cpf_cnpj, uf: f.dest_uf || c.uf };
      } else if (real) {
        throw new D.ValidacaoError("Na emissão real o destinatário precisa vir do cadastro de clientes (cliente_id)", "cliente_id");
      } else {
        dest = { nome: f.dest_nome, doc: f.dest_doc, uf: f.dest_uf, municipio: f.dest_municipio, ie: f.dest_ie };
      }
      if (!dest.nome || !D.normalizarDoc(dest.doc)) throw new D.ValidacaoError("Destinatário obrigatório", "destinatario");
      if (real) exigirParteCompleta(dest, "destinatário");

      const itens = itensIn.map((it, i) => montarItem(it, i, e, real, dest.uf));
      // Asserção positiva: NaN falha em todas as comparações, então `qtd <= 0`
      // deixaria passar item sem quantidade e gerar documento com vNF zerado.
      if (itens.some((i) => !i.descricao || !(i.quantidade > 0) || !(i.valor_unitario >= 0) || !(i.valor_total >= 0))) {
        throw new Error("Itens inválidos: informe descrição, quantidade maior que zero e valor unitário numérico");
      }
      const totalProd = Number(itens.reduce((s, i) => s + i.valor_total, 0).toFixed(2));
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const destDoc = D.normalizarDoc(dest.doc);
      const nfe = {
        ...f,
        ambiente: emissor.ambiente(e),
        natureza: D.exigirTexto(f.natureza || "VENDA DE COMBUSTIVEL", "Natureza da operação", { min: 1, max: 60 }),
        forma_pagamento: forma,
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
        forma_pagamento: forma,
        total_produtos: totalProd,
        total_nota: totalProd,
        emitido_em: emitidoEm,
        usuario_id: req.user.id,
        created_at: emitidoEm,
      };

      if (real) {
        // Número, série e chave chegam da Focus quando a SEFAZ autorizar.
        payload = focusPayload.nfe(e, nfe, itens, dest);
        insert("nfe", { ...base, provedor: "focus", simulado: false, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
      } else {
        const numero = e.prox_nfe;
        const serie = e.serie_nfe;
        const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "55", serie, numero });
        const xml = infNfe(e, { ...nfe, numero, serie }, itens, chave);
        const sef = sefaz.autorizar("nfe", { ...nfe, numero, serie, chave, itens });
        insert("nfe", {
          ...base,
          provedor: "local",
          simulado: true,
          numero,
          serie,
          chave,
          protocolo: sef.protocolo,
          status: sef.ok ? "autorizada" : "rejeitada",
          motivo: sef.xMotivo,
          xml,
          autorizado_em: sef.ok ? emitidoEm : null,
        });
        if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_nfe: numero + 1 });
      }
      insertMany("nfe_itens", itens.map((it) => ({ ...it, nfe_id: id })));
      C.registrarIdempotencia(req, "nfe", idemp, id);
      return { id };
    });

    if (reaproveitado) return res.status(200).json({ ...C.resumo(reaproveitado), reaproveitado: true });
    let row = get("nfe", (n) => n.id === result.id);
    auditFiscal({
      empresa_id: row.empresa_id, usuario_id: req.user.id, entidade: "nfe", entidade_id: row.id, operacao: "emitir",
      status_anterior: null, status_novo: row.status, ambiente: row.ambiente, provedor: row.provedor,
      mensagem: row.motivo, correlacao: req.correlacao, proxima_acao: C.proximaAcao(row),
    });
    if (real) row = await emissor.emitir("nfe", row.id, payload, ctx);
    return res.status(201).json(C.resumo(row));
  } catch (err) {
    if (err.status && err.status >= 500) throw err;
    return res.status(400).json({ error: err.message, campo: err.campo, correlacao: req.correlacao });
  }
};

exports.cancelar = async (req, res) => {
  const nota = get("nfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!nota) return res.status(404).json({ error: "NF-e não encontrada" });
  if (nota.status !== "autorizada") return res.status(400).json({ error: "Somente NF-e autorizada pode ser cancelada" });
  if (!nota.simulado && emissor.modo() === "focus") {
    try {
      const r = await emissor.cancelar("nfe", nota, (req.body || {}).justificativa, C.ctxDe(req));
      return res.json({ ok: true, motivo: r.mensagem_sefaz });
    } catch (err) {
      return C.erroProvedor(req, res, err);
    }
  }
  if (!nota.simulado) {
    return res.status(409).json({ error: "Documento real só pode ser cancelado com o provedor fiscal configurado (FISCAL_PROVIDER=focus)" });
  }
  const sef = sefaz.cancelar(nota);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("nfe", (n) => n.id === nota.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
  audit(req, "cancelar", "nfe", nota.id);
  auditFiscal({
    empresa_id: nota.empresa_id, usuario_id: req.user.id, entidade: "nfe", entidade_id: nota.id, operacao: "cancelar",
    status_anterior: nota.status, status_novo: "cancelada", ambiente: nota.ambiente, provedor: "local",
    mensagem: sef.xMotivo, correlacao: req.correlacao,
  });
  return res.json({ ok: true, motivo: sef.xMotivo });
};

exports.xml = (req, res) => {
  const nota = get("nfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!nota || !nota.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${nota.chave || "nfe"}.xml"`);
  return res.send(nota.xml);
};

exports.sincronizar = C.sincronizar("nfe", "NF-e");
exports.pdf = C.pdf("nfe", "NF-e");
