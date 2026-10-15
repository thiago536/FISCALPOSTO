const { v4: uuid } = require("uuid");
const { all, get, insert, update, transaction } = require("../db");
const { montarChave, num, onlyDigits } = require("../utils/fiscal");
const { infMdfe } = require("../services/xml");
const sefaz = require("../services/sefaz");
const emissor = require("../services/emissor");
const focusPayload = require("../services/focusPayload");
const { resumo, sincronizar, pdf } = require("./comum");
const { audit } = require("../services/audit");

function paginar(rows, page, limit) {
  const total = rows.length;
  const start = (page - 1) * limit;
  return { total, page, pages: Math.ceil(total / limit) || 1, data: rows.slice(start, start + limit) };
}

exports.listar = (req, res) => {
  const { data_ini, data_fim, status, page = 1, limit = 50 } = req.query;
  let rows = all("mdfe", (n) => n.empresa_id === req.user.empresa_id);
  if (data_ini) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) >= data_ini);
  if (data_fim) rows = rows.filter((n) => (n.created_at || "").slice(0, 10) <= data_fim);
  if (status) rows = rows.filter((n) => n.status === status);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const mapped = rows.map((m) => {
    const ciot = m.ciot_id ? get("ciot", (c) => c.id === m.ciot_id) : null;
    return { ...m, ciot_numero: ciot ? ciot.numero : null };
  });
  return res.json(paginar(mapped, Number(page), Number(limit)));
};

exports.detalhe = async (req, res) => {
  let mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (mdfe.status === "processando" && emissor.modo() === "focus") mdfe = await emissor.sincronizar("mdfe", mdfe.id);
  return res.json({
    mdfe,
    condutores: all("mdfe_condutores", (c) => c.mdfe_id === mdfe.id),
    percurso: all("mdfe_percurso", (c) => c.mdfe_id === mdfe.id).sort((a, b) => a.ordem - b.ordem),
    documentos: all("mdfe_docs", (c) => c.mdfe_id === mdfe.id),
    ciot: mdfe.ciot_id ? get("ciot", (c) => c.id === mdfe.ciot_id) : null,
  });
};

exports.emitir = async (req, res) => {
  const f = req.body || {};
  const real = emissor.modo() === "focus";
  if (!f.placa || !f.uf_ini || !f.uf_fim) {
    return res.status(400).json({ error: "Placa, UF origem e UF destino são obrigatórios" });
  }
  const condutores = Array.isArray(f.condutores) ? f.condutores : [];
  const percurso = Array.isArray(f.percurso) ? f.percurso : [];
  const documentos = (Array.isArray(f.documentos) ? f.documentos : [])
    .map((d) => ({ tipo: d && d.tipo === "cte" ? "cte" : "nfe", chave: onlyDigits(d && d.chave) }))
    .filter((d) => d.chave);
  if (!condutores.length) return res.status(400).json({ error: "Informe ao menos um condutor" });

  try {
    let payload = null;
    const result = transaction(() => {
      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      let ciot = null;
      if (f.ciot_id) {
        ciot = get("ciot", (c) => c.id === f.ciot_id && c.empresa_id === e.id);
        if (!ciot || ciot.status !== "emitido" || ciot.mdfe_id) throw new Error("CIOT inválido");
      }
      if (documentos.some((d) => d.chave.length !== 44)) throw new Error("Chave de documento deve ter 44 dígitos");
      if (real) {
        if (!documentos.length) throw new Error("MDF-e precisa de ao menos uma NF-e ou CT-e vinculada");
        if (!onlyDigits(f.descarregamento_cmun) || !f.descarregamento_municipio) {
          throw new Error("Informe município de descarregamento e código IBGE");
        }
        if (!(Number(f.tara_kg) > 0)) throw new Error("Informe a tara do veículo em kg");
        if (!(Number(f.peso_kg) > 0)) throw new Error("Informe o peso bruto da carga em kg");
      }
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const mdfe = {
        ...f,
        ambiente: emissor.ambiente(e),
        placa: String(f.placa).toUpperCase().replace(/[^A-Z0-9]/g, ""),
        valor_carga: num(f.valor_carga, 0, "Valor da carga"),
        peso_kg: num(f.peso_kg, 0, "Peso da carga"),
        uf_veiculo: f.uf_veiculo || e.uf,
        emitido_em: emitidoEm,
      };
      const perc = percurso.map((uf, i) => ({ id: uuid(), mdfe_id: id, uf, ordem: i + 1 }));
      const base = {
        id,
        empresa_id: e.id,
        ambiente: mdfe.ambiente,
        uf_ini: f.uf_ini,
        uf_fim: f.uf_fim,
        placa: mdfe.placa,
        rntrc: f.rntrc,
        uf_veiculo: mdfe.uf_veiculo,
        tara_kg: Number(f.tara_kg) || undefined,
        tipo_emitente: f.tipo_emitente,
        valor_carga: mdfe.valor_carga,
        peso_kg: mdfe.peso_kg,
        descarregamento_municipio: f.descarregamento_municipio,
        descarregamento_cmun: onlyDigits(f.descarregamento_cmun) || undefined,
        ciot_id: ciot ? ciot.id : null,
        emitido_em: emitidoEm,
        usuario_id: req.user.id,
        created_at: emitidoEm,
      };
      const filhos = () => {
        condutores.forEach((c) => insert("mdfe_condutores", { id: uuid(), mdfe_id: id, nome: c.nome, cpf: c.cpf }));
        perc.forEach((p) => insert("mdfe_percurso", p));
        documentos.forEach((d) => insert("mdfe_docs", { id: uuid(), mdfe_id: id, tipo: d.tipo, chave: d.chave }));
        if (ciot) update("ciot", (c) => c.id === ciot.id, { mdfe_id: id });
      };

      if (real) {
        payload = focusPayload.mdfe(e, mdfe, condutores, perc, documentos, ciot);
        insert("mdfe", { ...base, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
        filhos();
        return { id };
      }

      const numero = e.prox_mdfe;
      const serie = e.serie_mdfe;
      const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "58", serie, numero });
      const xml = infMdfe(e, { ...mdfe, numero, serie }, condutores, perc, documentos, ciot, chave);
      const sef = sefaz.autorizar("mdfe", { ...mdfe, chave });
      insert("mdfe", {
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
      filhos();
      if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_mdfe: numero + 1 });
      return { id };
    });
    const row = real ? await emissor.emitir("mdfe", result.id, payload) : get("mdfe", (n) => n.id === result.id);
    // Manifesto rejeitado não prende o CIOT.
    if (row.status === "rejeitada" && row.ciot_id) {
      update("ciot", (c) => c.id === row.ciot_id && c.mdfe_id === row.id, { mdfe_id: null });
    }
    audit(req, "emitir", "mdfe", row.id, row.status);
    return res.status(201).json(resumo(row));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.encerrar = async (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (emissor.modo() === "focus") {
    if (mdfe.status !== "autorizada") return res.status(400).json({ error: "Somente MDF-e autorizado pode ser encerrado" });
    const b = req.body || {};
    try {
      await emissor.encerrarMdfe(mdfe, {
        uf: b.uf || mdfe.uf_fim,
        municipio: b.municipio || mdfe.descarregamento_municipio,
        data: b.data,
      });
    } catch (err) {
      return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
    }
    audit(req, "encerrar", "mdfe", mdfe.id);
    return res.json({ ok: true });
  }
  const sef = sefaz.encerrarMdfe(mdfe);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("mdfe", (n) => n.id === mdfe.id, { status: "encerrada", motivo: sef.xMotivo, encerrado_em: new Date().toISOString() });
  audit(req, "encerrar", "mdfe", mdfe.id);
  return res.json({ ok: true });
};

exports.cancelar = async (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (mdfe.status !== "autorizada") return res.status(400).json({ error: "Somente MDF-e autorizado pode ser cancelado" });
  if (emissor.modo() === "focus") {
    try {
      await emissor.cancelar("mdfe", mdfe, (req.body || {}).justificativa);
    } catch (err) {
      return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
    }
  } else {
    const sef = sefaz.cancelar(mdfe);
    if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
    update("mdfe", (n) => n.id === mdfe.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
  }
  if (mdfe.ciot_id) update("ciot", (c) => c.id === mdfe.ciot_id && c.mdfe_id === mdfe.id, { mdfe_id: null });
  audit(req, "cancelar", "mdfe", mdfe.id);
  return res.json({ ok: true });
};

exports.xml = (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe || !mdfe.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${mdfe.chave || "mdfe"}.xml"`);
  return res.send(mdfe.xml);
};

exports.sincronizar = sincronizar("mdfe", "MDF-e");
exports.pdf = pdf("mdfe", "MDF-e");
