const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const { all, insert, transaction } = require("./index");

// Dados de DEMONSTRAÇÃO (empresa fictícia em SP e admin com senha conhecida).
// Só em desenvolvimento/teste e só num banco sem nenhum usuário: renomear ou
// desativar o admin não pode fazer um novo admin padrão reaparecer.
// Em produção o primeiro acesso é criado por scripts/provisionar.js.
function seed() {
  if (process.env.NODE_ENV === "production") {
    if (!all("usuarios").length) {
      console.warn("Nenhum usuário cadastrado. Crie o primeiro administrador com: npm run provisionar (ver README).");
    }
    return;
  }
  if (all("usuarios").length) return;

  transaction(() => {
    const empresaId = uuid();
    const agora = new Date().toISOString();
    insert("empresas", {
      id: empresaId,
      razao_social: "POSTO DEMO LTDA",
      nome_fantasia: "Posto Demo",
      cnpj: "00000000000191",
      ie: "ISENTO",
      uf: "SP",
      cuf: "35",
      municipio: "São Paulo",
      cmun: "3550308",
      cep: "01001000",
      logradouro: "Praça da Sé",
      numero: "100",
      bairro: "Sé",
      crt: 3,
      fone: "1133334444",
      email: "fiscal@postodemo.local",
      ambiente: 2,
      serie_nfe: 1,
      serie_cte: 1,
      serie_mdfe: 1,
      prox_nfe: 1,
      prox_cte: 1,
      prox_mdfe: 1,
      // Empresa de demonstração nunca transmite para SEFAZ/ANTT (ver emissor).
      demo: true,
      created_at: agora,
    });

    insert("usuarios", {
      id: uuid(),
      empresa_id: empresaId,
      nome: "Administrador",
      login: "admin",
      senha_hash: bcrypt.hashSync("Admin@2026", 12),
      perfil: "admin",
      ativo: 1,
      created_at: agora,
    });

    insert("clientes", {
      id: uuid(),
      empresa_id: empresaId,
      tipo: "F",
      nome: "CONSUMIDOR NAO IDENTIFICADO",
      cpf_cnpj: "00000000191",
      uf: "SP",
      municipio: "São Paulo",
      cmun: "3550308",
      created_at: agora,
    });
    insert("clientes", {
      id: uuid(),
      empresa_id: empresaId,
      tipo: "J",
      nome: "TRANSPORTADORA DEMO LTDA",
      cpf_cnpj: "11111111000191",
      uf: "SP",
      municipio: "Campinas",
      cmun: "3509502",
      created_at: agora,
    });

    const produtos = [
      ["GASOLINA", "Gasolina C Comum", "27101259", "5656", 5.89, "320101001", "GASOLINA C COMUM"],
      ["ETANOL", "Etanol Hidratado", "22071090", "5656", 3.99, "320102001", "ETANOL HIDRATADO COMUM"],
      ["DIESEL", "Óleo Diesel S10", "27101921", "5656", 6.15, "320103001", "OLEO DIESEL B S10"],
    ];
    for (const p of produtos) {
      insert("produtos", {
        id: uuid(),
        empresa_id: empresaId,
        codigo: p[0],
        descricao: p[1],
        ncm: p[2],
        cfop: p[3],
        unidade: "LT",
        preco: p[4],
        anp: p[5],
        desc_anp: p[6],
        cst_icms: "60",
        aliq_icms: 0,
        created_at: agora,
      });
    }
  });

  console.log("Seed de DEMONSTRAÇÃO criado: admin / Admin@2026 (somente desenvolvimento)");
}

module.exports = { seed };
