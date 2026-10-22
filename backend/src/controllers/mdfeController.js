const { v4: uuid } = require("uuid");
const { all, get, insert, update, transaction } = require("../db");
const { montarChave, num } = require("../utils/fiscal");
const D = require("../utils/documentos");
const { infMdfe } = require("../services/xml");
const sefaz = require("../services/sefaz");
const emissor = require("../services/emissor");
const focusPayload = require("../services/focusPayload");
const { exigirEmpresaApta } = require("../services/validacaoFiscal");
const C = require("./comum");
const ciotCtrl = require("./ciotController");
const { audit, auditFiscal } = require("../services/audit");

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
    const ciot = m.ciot_id ? get("ciot", (c) => c.id === m.ciot_id && c.empresa_id === m.empresa_id) : null;
    return { ...m, ciot_numero: ciot ? ciot.numero : null };
  });
  return res.json(paginar(mapped, Number(page), Number(limit)));
};

exports.detalhe = async (req, res) => {
  let mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (mdfe.status === "processando" && !mdfe.simulado && emissor.modo() === "focus") {
    mdfe = await emissor.sincronizar("mdfe", mdfe.id, C.ctxDe(req));
  }
  const ciotRow = mdfe.ciot_id ? get("ciot", (c) => c.id === mdfe.ciot_id && c.empresa_id === mdfe.empresa_id) : null;
  return res.json({
    mdfe,
    condutores: all("mdfe_condutores", (c) => c.mdfe_id === mdfe.id),
    percurso: all("mdfe_percurso", (c) => c.mdfe_id === mdfe.id).sort((a, b) => a.ordem - b.ordem),
    documentos: all("mdfe_docs", (c) => c.mdfe_id === mdfe.id),
    // resumo: sem payload/entrada (dados bancários/Pix) nem respostas brutas da ANTT.
    ciot: ciotRow ? ciotCtrl.resumo(ciotRow) : null,
  });
};

// CIOT oficial = declarado na ANTT e confirmado com o código verificador.
const ciotOficial = (c) => c && c.provider === "antt" && c.status === "emitido" && !c.simulado && String(c.numero || "").length === 16;

function placasDoCiot(c) {
  // CIOT da ANTT: só as placas efetivamente declaradas (c.placa é campo do formulário).
  const declaradas = (c.veiculos || []).map((v) => v && v.placa);
  const lista = (c.provider === "antt" ? declaradas : [c.placa, ...declaradas]).filter(Boolean);
  return lista.map((p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

exports.emitir = async (req, res) => {
  const f = req.body || {};
  const real = emissor.modo() === "focus";
  if (!f.placa || !f.uf_ini || !f.uf_fim) {
    return res.status(400).json({ error: "Placa, UF origem e UF destino são obrigatórios" });
  }
  const condutoresIn = Array.isArray(f.condutores) ? f.condutores : [];
  if (!condutoresIn.length) return res.status(400).json({ error: "Informe ao menos um condutor" });
  const ctx = C.ctxDe(req);

  let payload = null;
  let reaproveitado = null;
  try {
    const idemp = C.chaveIdempotencia(req);
    const placa = D.exigirPlaca(f.placa);
    const ufIni = D.exigirUf(f.uf_ini, "UF de início");
    const ufFim = D.exigirUf(f.uf_fim, "UF de fim");
    const percurso = (Array.isArray(f.percurso) ? f.percurso : []).map((uf) => D.exigirUf(uf, "UF de percurso"));
    const condutores = condutoresIn.map((c, i) => ({
      nome: D.exigirTexto(c && c.nome, `Nome do condutor ${i + 1}`, { min: 2, max: 60 }),
      cpf: D.exigirDoc(c && c.cpf, `CPF do condutor ${i + 1}`, { aceitar: ["CPF"] }),
    }));
    const documentos = (Array.isArray(f.documentos) ? f.documentos : [])
      .filter((d) => d && String(d.chave ?? "").trim())
      .map((d, i) => ({ tipo: d.tipo === "cte" ? "cte" : "nfe", chave: D.exigirChave(d.chave, `Chave do documento ${i + 1}`) }));
    const rntrc = D.normalizarRntrc(f.rntrc);
    const tipoEmitente = f.tipo_emitente == null || f.tipo_emitente === "" ? undefined : Number(f.tipo_emitente);
    if (tipoEmitente !== undefined && ![1, 2].includes(tipoEmitente)) {
      throw new D.ValidacaoError("Tipo de emitente deve ser 1 (prestador de serviço) ou 2 (carga própria)", "tipo_emitente");
    }

    const result = transaction(() => {
      reaproveitado = C.documentoJaCriado(req, "mdfe", idemp);
      if (reaproveitado) return { id: reaproveitado.id };

      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      if (real) exigirEmpresaApta(e);
      let ciot = null;
      if (f.ciot_id) {
        ciot = get("ciot", (c) => c.id === f.ciot_id && c.empresa_id === e.id);
        if (!ciot || ciot.status !== "emitido" || ciot.mdfe_id) throw new D.ValidacaoError("CIOT inválido", "ciot_id");
        // Manifesto real só aceita CIOT confirmado pela ANTT; simulado só
        // aceita CIOT simulado (não prende um CIOT real num documento de teste).
        if (real && !ciotOficial(ciot)) {
          throw new D.ValidacaoError("MDF-e real exige CIOT confirmado pela ANTT; este CIOT é simulado ou não foi confirmado", "ciot_id");
        }
        if (!real && ciotOficial(ciot)) {
          throw new D.ValidacaoError("CIOT oficial não pode ser vinculado a MDF-e simulado", "ciot_id");
        }
        if (!placasDoCiot(ciot).includes(placa)) {
          throw new D.ValidacaoError(`Placa ${placa} não consta no CIOT ${ciot.numero}`, "ciot_id");
        }
      }
      const descCmun = f.descarregamento_cmun ? D.exigirMunicipio(f.descarregamento_cmun, ufFim, "Código IBGE do descarregamento") : undefined;
      if (real) {
        if (!documentos.length) throw new D.ValidacaoError("MDF-e precisa de ao menos uma NF-e ou CT-e vinculada", "documentos");
        if (!descCmun || !f.descarregamento_municipio) throw new D.ValidacaoError("Informe município de descarregamento e código IBGE", "descarregamento_cmun");
        if (!(Number(f.tara_kg) > 0)) throw new D.ValidacaoError("Informe a tara do veículo em kg", "tara_kg");
        if (!(Number(f.peso_kg) > 0)) throw new D.ValidacaoError("Informe o peso bruto da carga em kg", "peso_kg");
      }
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const mdfe = {
        ...f,
        ambiente: emissor.ambiente(e),
        placa,
        uf_ini: ufIni,
        uf_fim: ufFim,
        rntrc,
        tipo_emitente: tipoEmitente,
        valor_carga: num(f.valor_carga, 0, "Valor da carga"),
        peso_kg: num(f.peso_kg, 0, "Peso da carga"),
        uf_veiculo: f.uf_veiculo ? D.exigirUf(f.uf_veiculo, "UF do veículo") : e.uf,
        descarregamento_cmun: descCmun,
        emitido_em: emitidoEm,
      };
      if (mdfe.valor_carga < 0 || mdfe.peso_kg < 0) throw new D.ValidacaoError("Valor e peso da carga não podem ser negativos", "carga");
      const perc = percurso.map((uf, i) => ({ id: uuid(), mdfe_id: id, uf, ordem: i + 1 }));
      const base = {
        id,
        empresa_id: e.id,
        ambiente: mdfe.ambiente,
        uf_ini: ufIni,
        uf_fim: ufFim,
        placa,
        rntrc: rntrc || undefined,
        uf_veiculo: mdfe.uf_veiculo,
        tara_kg: Number(f.tara_kg) || undefined,
        tipo_emitente: tipoEmitente,
        valor_carga: mdfe.valor_carga,
        peso_kg: mdfe.peso_kg,
        descarregamento_municipio: f.descarregamento_municipio,
        descarregamento_cmun: descCmun,
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
        insert("mdfe", { ...base, provedor: "focus", simulado: false, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
        filhos();
      } else {
        const numero = e.prox_mdfe;
        const serie = e.serie_mdfe;
        const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "58", serie, numero });
        const xml = infMdfe(e, { ...mdfe, numero, serie }, condutores, perc, documentos, ciot, chave);
        const sef = sefaz.autorizar("mdfe", { ...mdfe, chave });
        insert("mdfe", {
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
        filhos();
        if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_mdfe: numero + 1 });
      }
      C.registrarIdempotencia(req, "mdfe", idemp, id);
      return { id };
    });

    if (reaproveitado) return res.status(200).json({ ...C.resumo(reaproveitado), reaproveitado: true });
    let row = get("mdfe", (n) => n.id === result.id);
    auditFiscal({
      empresa_id: row.empresa_id, usuario_id: req.user.id, entidade: "mdfe", entidade_id: row.id, operacao: "emitir",
      status_anterior: null, status_novo: row.status, ambiente: row.ambiente, provedor: row.provedor,
      mensagem: row.motivo, correlacao: req.correlacao, proxima_acao: C.proximaAcao(row),
    });
    if (real) row = await emissor.emitir("mdfe", row.id, payload, ctx);
    // Manifesto rejeitado (no envio ou no simulador) não prende o CIOT.
    if (row.status === "rejeitada" && row.ciot_id) {
      update("ciot", (c) => c.id === row.ciot_id && c.mdfe_id === row.id, { mdfe_id: null });
    }
    return res.status(201).json(C.resumo(row));
  } catch (err) {
    if (err.status && err.status >= 500) throw err;
    return res.status(400).json({ error: err.message, campo: err.campo, correlacao: req.correlacao });
  }
};

exports.encerrar = async (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (!mdfe.simulado && emissor.modo() === "focus") {
    if (mdfe.status !== "autorizada") return res.status(400).json({ error: "Somente MDF-e autorizado pode ser encerrado" });
    const b = req.body || {};
    try {
      const uf = D.exigirUf(b.uf || mdfe.uf_fim, "UF de encerramento");
      const municipio = D.exigirTexto(b.municipio || mdfe.descarregamento_municipio, "Município de encerramento", { min: 2, max: 60 });
      await emissor.encerrarMdfe(mdfe, { uf, municipio, data: b.data }, C.ctxDe(req));
    } catch (err) {
      if (err.name === "ValidacaoError") return res.status(400).json({ error: err.message, campo: err.campo });
      return C.erroProvedor(req, res, err);
    }
    return res.json({ ok: true });
  }
  if (!mdfe.simulado) {
    return res.status(409).json({ error: "Documento real só pode ser encerrado com o provedor fiscal configurado (FISCAL_PROVIDER=focus)" });
  }
  const sef = sefaz.encerrarMdfe(mdfe);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("mdfe", (n) => n.id === mdfe.id, { status: "encerrada", motivo: sef.xMotivo, encerrado_em: new Date().toISOString() });
  audit(req, "encerrar", "mdfe", mdfe.id);
  auditFiscal({
    empresa_id: mdfe.empresa_id, usuario_id: req.user.id, entidade: "mdfe", entidade_id: mdfe.id, operacao: "encerrar",
    status_anterior: mdfe.status, status_novo: "encerrada", ambiente: mdfe.ambiente, provedor: "local",
    mensagem: sef.xMotivo, correlacao: req.correlacao,
  });
  return res.json({ ok: true });
};

exports.cancelar = async (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe) return res.status(404).json({ error: "MDF-e não encontrado" });
  if (mdfe.status !== "autorizada") return res.status(400).json({ error: "Somente MDF-e autorizado pode ser cancelado" });
  if (!mdfe.simulado && emissor.modo() === "focus") {
    try {
      await emissor.cancelar("mdfe", mdfe, (req.body || {}).justificativa, C.ctxDe(req));
    } catch (err) {
      return C.erroProvedor(req, res, err);
    }
  } else if (!mdfe.simulado) {
    return res.status(409).json({ error: "Documento real só pode ser cancelado com o provedor fiscal configurado (FISCAL_PROVIDER=focus)" });
  } else {
    const sef = sefaz.cancelar(mdfe);
    if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
    update("mdfe", (n) => n.id === mdfe.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
    audit(req, "cancelar", "mdfe", mdfe.id);
    auditFiscal({
      empresa_id: mdfe.empresa_id, usuario_id: req.user.id, entidade: "mdfe", entidade_id: mdfe.id, operacao: "cancelar",
      status_anterior: mdfe.status, status_novo: "cancelada", ambiente: mdfe.ambiente, provedor: "local",
      mensagem: sef.xMotivo, correlacao: req.correlacao,
    });
  }
  if (mdfe.ciot_id) update("ciot", (c) => c.id === mdfe.ciot_id && c.mdfe_id === mdfe.id, { mdfe_id: null });
  return res.json({ ok: true });
};

exports.xml = (req, res) => {
  const mdfe = get("mdfe", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!mdfe || !mdfe.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${mdfe.chave || "mdfe"}.xml"`);
  return res.send(mdfe.xml);
};

exports.sincronizar = C.sincronizar("mdfe", "MDF-e");
exports.pdf = C.pdf("mdfe", "MDF-e");
