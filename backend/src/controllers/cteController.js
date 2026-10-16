const { v4: uuid } = require("uuid");
const { all, get, insert, update, transaction } = require("../db");
const { montarChave, num } = require("../utils/fiscal");
const D = require("../utils/documentos");
const { infCte } = require("../services/xml");
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

exports.listar = (req, res) => {
  const { data_ini, data_fim, documento, status, page = 1, limit = 50 } = req.query;
  let rows = all("cte", (n) => n.empresa_id === req.user.empresa_id);
  if (data_ini) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) >= data_ini);
  if (data_fim) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) <= data_fim);
  if (documento) rows = rows.filter((n) => String(n.numero) === String(Number(documento)));
  if (status) rows = rows.filter((n) => n.status === status);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.json(paginar(rows, Number(page), Number(limit)));
};

exports.detalhe = async (req, res) => {
  let cte = get("cte", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!cte) return res.status(404).json({ error: "CT-e não encontrado" });
  if (cte.status === "processando" && !cte.simulado && emissor.modo() === "focus") {
    cte = await emissor.sincronizar("cte", cte.id, C.ctxDe(req));
  }
  return res.json({ cte });
};

exports.emitir = async (req, res) => {
  const f = req.body || {};
  const real = emissor.modo() === "focus";
  const valor = Number(f.valor_servico);
  if (!(valor > 0)) return res.status(400).json({ error: "Valor do serviço inválido" });
  let aliq;
  try {
    aliq = num(f.icms_aliq, 12, "Alíquota de ICMS");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (aliq < 0 || aliq > 100) return res.status(400).json({ error: "Alíquota de ICMS fora de 0..100" });
  const icmsValor = Number(((valor * aliq) / 100).toFixed(2));
  const ctx = C.ctxDe(req);

  let payload = null;
  let reaproveitado = null;
  try {
    const idemp = C.chaveIdempotencia(req);
    const result = transaction(() => {
      reaproveitado = C.documentoJaCriado(req, "cte", idemp);
      if (reaproveitado) return { id: reaproveitado.id };

      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      if (real) exigirEmpresaApta(e);
      // Na emissão real remetente e destinatário são exatamente os do cadastro.
      const parteDe = (prefixo, nome) => {
        const cid = f[`${prefixo}_cliente_id`];
        if (cid) {
          const c = get("clientes", (x) => x.id === cid && x.empresa_id === e.id);
          if (!c) throw new D.ValidacaoError(`${nome} não encontrado no cadastro`, `${prefixo}_cliente_id`);
          return deCliente(c);
        }
        if (real) throw new D.ValidacaoError(`Na emissão real o ${nome} precisa vir do cadastro de clientes (${prefixo}_cliente_id)`, `${prefixo}_cliente_id`);
        return { nome: f[`${prefixo}_nome`], doc: f[`${prefixo}_doc`], uf: f[`${prefixo}_uf`], municipio: f[`${prefixo}_municipio`] };
      };
      const rem = parteDe("rem", "remetente");
      const dest = parteDe("dest", "destinatário");
      if (!rem.nome || !D.normalizarDoc(rem.doc) || !dest.nome || !D.normalizarDoc(dest.doc)) {
        throw new D.ValidacaoError("Remetente e destinatário são obrigatórios", "remetente");
      }
      const chavesNfe = (Array.isArray(f.chaves_nfe) ? f.chaves_nfe : [])
        .filter((c) => String(c ?? "").trim())
        .map((c, i) => D.exigirChave(c, `Chave de NF-e ${i + 1}`));
      const rntrc = D.normalizarRntrc(f.rntrc);
      if (real) {
        exigirParteCompleta(rem, "remetente");
        exigirParteCompleta(dest, "destinatário");
        if (!rntrc) throw new D.ValidacaoError("RNTRC é obrigatório no CT-e rodoviário", "rntrc");
        if (!chavesNfe.length) throw new D.ValidacaoError("Informe ao menos uma chave de NF-e transportada", "chaves_nfe");
        D.exigirDigitos(f.cfop || "5353", 4, "CFOP");
      }
      const tomador = Number(f.tomador ?? 0);
      if (![0, 3].includes(tomador)) throw new D.ValidacaoError("Tomador deve ser 0 (remetente) ou 3 (destinatário)", "tomador");
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const cte = {
        ...f,
        ambiente: emissor.ambiente(e),
        rem_doc: D.normalizarDoc(rem.doc),
        dest_doc: D.normalizarDoc(dest.doc),
        valor_servico: valor,
        icms_base: valor,
        icms_aliq: aliq,
        icms_valor: icmsValor,
        valor_carga: num(f.valor_carga, 0, "Valor da carga"),
        peso_kg: num(f.peso_kg, 0, "Peso da carga"),
        tomador,
        rntrc,
        emitido_em: emitidoEm,
        natureza: D.exigirTexto(f.natureza || "PRESTACAO DE SERVICO DE TRANSPORTE", "Natureza da operação", { min: 1, max: 60 }),
        cfop: f.cfop || "5353",
        carga: f.carga || "COMBUSTIVEL",
      };
      if (cte.valor_carga < 0 || cte.peso_kg < 0) throw new D.ValidacaoError("Valor e peso da carga não podem ser negativos", "carga");
      const base = {
        id,
        empresa_id: e.id,
        ambiente: cte.ambiente,
        cfop: cte.cfop,
        natureza: cte.natureza,
        rem_nome: rem.nome,
        rem_doc: cte.rem_doc,
        rem_uf: rem.uf,
        rem_municipio: rem.municipio,
        rem_cliente_id: f.rem_cliente_id || null,
        dest_nome: dest.nome,
        dest_doc: cte.dest_doc,
        dest_uf: dest.uf,
        dest_municipio: dest.municipio,
        dest_cliente_id: f.dest_cliente_id || null,
        tomador,
        rntrc: rntrc || undefined,
        chaves_nfe: chavesNfe,
        carga: cte.carga,
        valor_carga: cte.valor_carga,
        peso_kg: cte.peso_kg,
        valor_servico: valor,
        icms_base: valor,
        icms_aliq: aliq,
        icms_valor: icmsValor,
        emitido_em: emitidoEm,
        usuario_id: req.user.id,
        created_at: emitidoEm,
      };

      if (real) {
        payload = focusPayload.cte(e, cte, rem, dest, chavesNfe);
        insert("cte", { ...base, provedor: "focus", simulado: false, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
      } else {
        const numero = e.prox_cte;
        const serie = e.serie_cte;
        const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "57", serie, numero });
        const xml = infCte(e, { ...cte, numero, serie, rem_nome: rem.nome, rem_uf: rem.uf, rem_municipio: rem.municipio, dest_nome: dest.nome, dest_uf: dest.uf, dest_municipio: dest.municipio }, chave);
        const sef = sefaz.autorizar("cte", { ...cte, chave });
        insert("cte", {
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
        if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_cte: numero + 1 });
      }
      C.registrarIdempotencia(req, "cte", idemp, id);
      return { id };
    });

    if (reaproveitado) return res.status(200).json({ ...C.resumo(reaproveitado), reaproveitado: true });
    let row = get("cte", (n) => n.id === result.id);
    auditFiscal({
      empresa_id: row.empresa_id, usuario_id: req.user.id, entidade: "cte", entidade_id: row.id, operacao: "emitir",
      status_anterior: null, status_novo: row.status, ambiente: row.ambiente, provedor: row.provedor,
      mensagem: row.motivo, correlacao: req.correlacao, proxima_acao: C.proximaAcao(row),
    });
    if (real) row = await emissor.emitir("cte", row.id, payload, ctx);
    return res.status(201).json(C.resumo(row));
  } catch (err) {
    if (err.status && err.status >= 500) throw err;
    return res.status(400).json({ error: err.message, campo: err.campo, correlacao: req.correlacao });
  }
};

exports.cancelar = async (req, res) => {
  const cte = get("cte", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!cte) return res.status(404).json({ error: "CT-e não encontrado" });
  if (cte.status !== "autorizada") return res.status(400).json({ error: "Somente CT-e autorizado pode ser cancelado" });
  if (!cte.simulado && emissor.modo() === "focus") {
    try {
      await emissor.cancelar("cte", cte, (req.body || {}).justificativa, C.ctxDe(req));
      return res.json({ ok: true });
    } catch (err) {
      return C.erroProvedor(req, res, err);
    }
  }
  if (!cte.simulado) {
    return res.status(409).json({ error: "Documento real só pode ser cancelado com o provedor fiscal configurado (FISCAL_PROVIDER=focus)" });
  }
  const sef = sefaz.cancelar(cte);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("cte", (n) => n.id === cte.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
  audit(req, "cancelar", "cte", cte.id);
  auditFiscal({
    empresa_id: cte.empresa_id, usuario_id: req.user.id, entidade: "cte", entidade_id: cte.id, operacao: "cancelar",
    status_anterior: cte.status, status_novo: "cancelada", ambiente: cte.ambiente, provedor: "local",
    mensagem: sef.xMotivo, correlacao: req.correlacao,
  });
  return res.json({ ok: true });
};

exports.xml = (req, res) => {
  const cte = get("cte", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!cte || !cte.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${cte.chave || "cte"}.xml"`);
  return res.send(cte.xml);
};

exports.sincronizar = C.sincronizar("cte", "CT-e");
exports.pdf = C.pdf("cte", "CT-e");
