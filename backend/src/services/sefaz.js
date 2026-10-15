/**
 * Provedor de autorização.
 * Homologação padrão: autoriza localmente (sem certificado).
 * Produção real exige certificado A1 e integração com SEFAZ ou um provedor
 * (Focus NFe, PlugNotas, TecnoSpeed). Este módulo é o ponto de troca.
 */
const { pad } = require("../utils/fiscal");

function protocolo(prefix) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`;
  return `${prefix}${stamp}${pad(Math.floor(Math.random() * 999999), 6)}`;
}

function validarBasico(tipo, payload) {
  const erros = [];
  if (!payload.chave || payload.chave.length !== 44) erros.push("Chave de acesso inválida");
  if (tipo === "nfe" && (!payload.itens || !payload.itens.length)) erros.push("NF-e sem itens");
  if (tipo === "nfe" && Number(payload.total_nota) <= 0) erros.push("Valor da NF-e deve ser maior que zero");
  if (tipo === "cte" && Number(payload.valor_servico) <= 0) erros.push("Valor do serviço do CT-e deve ser maior que zero");
  if (tipo === "mdfe" && !payload.placa) erros.push("Placa do veículo é obrigatória no MDF-e");
  return erros;
}

function autorizar(tipo, payload) {
  const erros = validarBasico(tipo, payload);
  if (erros.length) {
    return { ok: false, cStat: "215", xMotivo: erros.join("; "), protocolo: null };
  }
  const prefix = tipo === "nfe" ? "1" : tipo === "cte" ? "2" : "3";
  return {
    ok: true,
    cStat: "100",
    xMotivo: "Autorizado o uso do documento (homologação local)",
    protocolo: protocolo(prefix),
  };
}

function cancelar(payload) {
  if (!payload.protocolo) {
    return { ok: false, cStat: "501", xMotivo: "Documento sem protocolo de autorização" };
  }
  return {
    ok: true,
    cStat: "135",
    xMotivo: "Evento registrado e vinculado (homologação local)",
    protocolo: protocolo("9"),
  };
}

function encerrarMdfe(payload) {
  if (payload.status !== "autorizada") {
    return { ok: false, xMotivo: "Somente MDF-e autorizado pode ser encerrado" };
  }
  return { ok: true, xMotivo: "Encerramento registrado (homologação local)", protocolo: protocolo("8") };
}

module.exports = { autorizar, cancelar, encerrarMdfe };
