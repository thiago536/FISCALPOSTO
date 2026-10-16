/**
 * Pré-condições para TRANSMISSÃO REAL (Focus/SEFAZ). Barram antes do envio o
 * que certamente seria rejeitado ou que nem deveria sair do sistema (empresa de
 * demonstração, cadastro incompleto). Não decide tributação.
 */
const D = require("../utils/documentos");

function coletar(regras) {
  const faltas = [];
  for (const [ok, msg] of regras) if (!ok) faltas.push(msg);
  return faltas;
}

function tenta(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function exigirEmpresaApta(e) {
  if (!e) throw new D.ValidacaoError("Empresa não encontrada", "empresa");
  if (e.demo) {
    throw new D.ValidacaoError(
      "Empresa de demonstração não transmite documentos reais. Cadastre os dados reais da empresa (CNPJ próprio) antes de usar a emissão real.",
      "empresa"
    );
  }
  const faltas = coletar([
    [D.cnpjValido(e.cnpj), "CNPJ válido"],
    [!!D.normalizarIe(e.ie), "inscrição estadual"],
    [tenta(() => D.exigirUf(e.uf)), "UF"],
    [D.CUF[e.uf] && String(e.cuf) === D.CUF[e.uf], "código da UF coerente com a UF"],
    [tenta(() => D.exigirMunicipio(e.cmun, e.uf)), "código IBGE do município (da mesma UF)"],
    [!!(e.municipio && String(e.municipio).trim()), "nome do município"],
    [tenta(() => D.exigirCep(e.cep)), "CEP"],
    [!!(e.logradouro && String(e.logradouro).trim()), "logradouro"],
    [!!(e.numero && String(e.numero).trim()), "número do endereço"],
    [!!(e.bairro && String(e.bairro).trim()), "bairro"],
    [tenta(() => D.exigirCrt(e.crt)), "CRT (regime tributário)"],
  ]);
  if (faltas.length) {
    throw new D.ValidacaoError(`Cadastro da empresa incompleto para emissão real: ${faltas.join(", ")}`, "empresa");
  }
}

// Parte com endereço completo (destinatário da NF-e, remetente/destinatário do CT-e).
function exigirParteCompleta(p, nome) {
  if (!p) throw new D.ValidacaoError(`${nome} não encontrado`, nome);
  const faltas = coletar([
    [!!(p.nome && String(p.nome).trim()), "nome"],
    [D.docValido(p.doc), "CPF/CNPJ válido"],
    [tenta(() => D.exigirUf(p.uf)), "UF"],
    [tenta(() => D.exigirMunicipio(p.cmun, p.uf)), "código IBGE do município (da mesma UF)"],
    [!!(p.municipio && String(p.municipio).trim()), "nome do município"],
    [!!(p.logradouro && String(p.logradouro).trim()), "logradouro"],
    [!!(p.bairro && String(p.bairro).trim()), "bairro"],
    [tenta(() => D.exigirCep(p.cep)), "CEP"],
  ]);
  if (faltas.length) {
    throw new D.ValidacaoError(`Cadastro de ${nome} incompleto para emissão real: ${faltas.join(", ")}`, nome);
  }
}

module.exports = { exigirEmpresaApta, exigirParteCompleta };
