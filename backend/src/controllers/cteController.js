const { v4: uuid } = require("uuid");
const { all, get, insert, update, transaction } = require("../db");
const { montarChave, onlyDigits, num } = require("../utils/fiscal");
const { infCte } = require("../services/xml");
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
  if (cte.status === "processando" && emissor.modo() === "focus") cte = await emissor.sincronizar("cte", cte.id);
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

  try {
    let payload = null;
    const result = transaction(() => {
      const e = get("empresas", (x) => x.id === req.user.empresa_id);
      // Remetente/destinatário vêm do cadastro de clientes quando informado o id;
      // emissão real exige endereço completo com código IBGE.
      const parteDe = (prefixo) => {
        const cid = f[`${prefixo}_cliente_id`];
        if (cid) {
          const c = get("clientes", (x) => x.id === cid && x.empresa_id === e.id);
          if (!c) throw new Error("Cliente não encontrado");
          return deCliente(c);
        }
        return { nome: f[`${prefixo}_nome`], doc: f[`${prefixo}_doc`], uf: f[`${prefixo}_uf`], municipio: f[`${prefixo}_municipio`] };
      };
      const rem = parteDe("rem");
      const dest = parteDe("dest");
      if (!rem.nome || !onlyDigits(rem.doc) || !dest.nome || !onlyDigits(dest.doc)) {
        throw new Error("Remetente e destinatário são obrigatórios");
      }
      const chavesNfe = (Array.isArray(f.chaves_nfe) ? f.chaves_nfe : []).map(onlyDigits).filter(Boolean);
      if (chavesNfe.some((c) => c.length !== 44)) throw new Error("Chave de NF-e deve ter 44 dígitos");
      if (real) {
        for (const [nome, p] of [["Remetente", rem], ["Destinatário", dest]]) {
          if (!p.logradouro || !onlyDigits(p.cmun) || !p.uf || !p.municipio) {
            throw new Error(`${nome} precisa estar cadastrado com endereço e código IBGE do município`);
          }
        }
        if (!onlyDigits(f.rntrc)) throw new Error("RNTRC é obrigatório no CT-e rodoviário");
        if (!chavesNfe.length) throw new Error("Informe ao menos uma chave de NF-e transportada");
      }
      const id = uuid();
      const emitidoEm = new Date().toISOString();
      const cte = {
        ...f,
        ambiente: emissor.ambiente(e),
        rem_doc: onlyDigits(rem.doc),
        dest_doc: onlyDigits(dest.doc),
        valor_servico: valor,
        icms_base: valor,
        icms_aliq: aliq,
        icms_valor: icmsValor,
        valor_carga: num(f.valor_carga, 0, "Valor da carga"),
        peso_kg: num(f.peso_kg, 0, "Peso da carga"),
        emitido_em: emitidoEm,
        natureza: f.natureza || "PRESTACAO DE SERVICO DE TRANSPORTE",
        cfop: f.cfop || "5353",
        carga: f.carga || "COMBUSTIVEL",
      };
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
        dest_nome: dest.nome,
        dest_doc: cte.dest_doc,
        dest_uf: dest.uf,
        dest_municipio: dest.municipio,
        tomador: Number(f.tomador) === 3 ? 3 : 0,
        rntrc: onlyDigits(f.rntrc) || undefined,
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
        insert("cte", { ...base, numero: null, serie: null, chave: null, protocolo: null, status: "processando", motivo: "Enviado à SEFAZ", xml: null, autorizado_em: null });
        return { id };
      }

      const numero = e.prox_cte;
      const serie = e.serie_cte;
      const chave = montarChave({ cuf: e.cuf, cnpj: e.cnpj, modelo: "57", serie, numero });
      const xml = infCte(e, { ...cte, numero, serie, rem_nome: rem.nome, rem_uf: rem.uf, rem_municipio: rem.municipio, dest_nome: dest.nome, dest_uf: dest.uf, dest_municipio: dest.municipio }, chave);
      const sef = sefaz.autorizar("cte", { ...cte, chave });
      insert("cte", {
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
      if (sef.ok) update("empresas", (x) => x.id === e.id, { prox_cte: numero + 1 });
      return { id };
    });
    const row = real ? await emissor.emitir("cte", result.id, payload) : get("cte", (n) => n.id === result.id);
    audit(req, "emitir", "cte", row.id, row.status);
    return res.status(201).json(resumo(row));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.cancelar = async (req, res) => {
  const cte = get("cte", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!cte) return res.status(404).json({ error: "CT-e não encontrado" });
  if (cte.status !== "autorizada") return res.status(400).json({ error: "Somente CT-e autorizado pode ser cancelado" });
  if (emissor.modo() === "focus") {
    try {
      await emissor.cancelar("cte", cte, (req.body || {}).justificativa);
      audit(req, "cancelar", "cte", cte.id);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
    }
  }
  const sef = sefaz.cancelar(cte);
  if (!sef.ok) return res.status(400).json({ error: sef.xMotivo });
  update("cte", (n) => n.id === cte.id, { status: "cancelada", motivo: sef.xMotivo, cancelado_em: new Date().toISOString() });
  audit(req, "cancelar", "cte", cte.id);
  return res.json({ ok: true });
};

exports.xml = (req, res) => {
  const cte = get("cte", (n) => n.id === req.params.id && n.empresa_id === req.user.empresa_id);
  if (!cte || !cte.xml) return res.status(404).json({ error: "XML não encontrado" });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${cte.chave || "cte"}.xml"`);
  return res.send(cte.xml);
};

exports.sincronizar = sincronizar("cte", "CT-e");
exports.pdf = pdf("cte", "CT-e");
