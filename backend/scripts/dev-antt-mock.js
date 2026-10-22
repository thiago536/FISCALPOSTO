// Ambiente de desenvolvimento do CIOT contra um MOCK da ANTT (nunca toca a ANTT real).
//
// Uso (a partir de backend/):  node scripts/dev-antt-mock.js
//
// O que sobe:
//  - mock HTTPS com mTLS em 127.0.0.1 (porta aleatória), certificados gerados com openssl
//    num diretório temporário (CN "EMPRESA TESTE LTDA:11222333000181", CNPJ fictício);
//  - o app completo em http://localhost:3002 com banco TEMPORÁRIO (DATA_DIR em os.tmpdir;
//    backend/data/ nunca é usado), CIOT_PROVIDER=antt, ANTT_AMBIENTE=homologacao,
//    ANTT_BASE_URL apontando para o mock. A empresa do seed recebe o CNPJ 11222333000181.
//  - login: admin / Admin@2026.
//
// Respostas do mock (por padrão, 110 "Dados inseridos" para declaração/cancelamento/
// encerramento, 111 para ConsultarCIOTGerado, 110 para situação/frota). Para forçar um
// código, use o prefixo do id_operacao (12 caracteres [0-9A-Z]) ou o header
// "X-Mock-Codigo" (útil em curl direto no mock, não pelo navegador):
//    E205xxxxxxxx  -> 205 (rejeição de regra)       ex.: E20500000001
//    E219xxxxxxxx  -> 219 (ID já cadastrado)        ex.: E21900000001
//    E297xxxxxxxx  -> 297 (CIOT não existe; vale também para a consulta desse ID)
//    X-Mock-Codigo: 205|219|297|...  -> o mesmo, qualquer serviço
// Qualquer outro id_operacao -> 110 e CIOT = id + "0042" (a consulta devolve o mesmo; MOCK_DV_CONSULTA=1234 força divergência).
// Ctrl+C encerra tudo e apaga o diretório temporário.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { gerarCertificados, subirMock } = require("../tests/antt-mock-helper");

const CNPJ = "11222333000181";
const PORTA_APP = "3002";

// Mesmo DV na declaração e na consulta (como a ANTT real). MOCK_DV_CONSULTA força divergência.
const DV = "0042";
const DV_CONSULTA = process.env.MOCK_DV_CONSULTA || DV;

const MSG = {
  "110": "Dados inseridos",
  "111": "Consulta realizada",
  "205": "Rejeição simulada pelo mock (regra violada)",
  "219": "Código de identificação da operação já cadastrado.",
  "297": "Código 297 - Rejeição: O CIOT informado não existe na base de dados da ANTT.",
};

function codigoForcado({ body, headers }) {
  const h = headers["x-mock-codigo"];
  if (h) return String(h);
  const id = String((body && (body.IdOperacaoTransporte || body.CodigoIdentificacaoOperacao)) || "");
  const m = /^E(205|219|297)/.exec(id);
  return m ? m[1] : null;
}

function responder(req) {
  const { servico, body } = req;
  const forcado = codigoForcado(req);
  const id = String((body && (body.IdOperacaoTransporte || body.CodigoIdentificacaoOperacao)) || "").slice(0, 12);
  const base = (cod, extra = {}) => ({
    status: 200,
    json: { Codigo: [cod], Mensagem: [MSG[cod] || "Resposta forçada pelo mock"], Protocolo: "MOCK" + Date.now(), ...extra },
  });
  if (forcado) return base(forcado, forcado === "297" ? { CodigoIdentificacaoOperacao: "" } : {});
  switch (servico) {
    case "DeclaracaoOperacaoTransporte":
      return base("110", { CodigoIdentificacaoOperacao: id, CodigoVerificador: DV });
    case "ConsultarCIOTGerado":
      return base("111", { CodigoIdentificacaoOperacao: id + DV_CONSULTA });
    case "CancelamentoOperacaoTransporte":
    case "EncerramentoOperacaoTransporte":
    case "ConsultarSituacaoTransportador":
    case "ConsultarFrotaTransportador":
      return base("110");
    default:
      return { status: 404, json: { Message: "No HTTP resource was found" } };
  }
}

(async () => {
  let certs;
  try {
    certs = gerarCertificados({ cnpj: CNPJ });
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
  const { server, porta } = await subirMock(certs, (r) => {
    const out = responder(r);
    console.log(`[mock ANTT] ${r.servico} -> ${out.json ? out.json.Codigo : out.status}`);
    return out;
  });

  const dataDir = path.join(certs.dir, "data");
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    NODE_ENV: "development",
    PORT: PORTA_APP,
    HOST: "127.0.0.1",
    ENV_FILE: path.join(certs.dir, "sem.env"), // ignora o backend/.env da máquina
    FISCAL_PROVIDER: "local",
    CIOT_PROVIDER: "antt",
    ANTT_AMBIENTE: "homologacao",
    ANTT_BASE_URL: `https://127.0.0.1:${porta}/pefServices/api`,
    ANTT_CA_PATH: certs.ca,
    ANTT_TIMEOUT_MS: "5000",
    ANTT_ID_MODO: "manual",
    ANTT_PFX_PATH: certs.pfx,
    ANTT_PFX_SENHA: certs.senha,
  });
  delete process.env.ALLOW_PRODUCAO;

  // Trava de segurança: nunca prosseguir se algo apontar para fora do mock/tmp.
  if (!process.env.ANTT_BASE_URL.startsWith("https://127.0.0.1:") || !path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()))) {
    console.error("ERRO: configuração fora do mock/tmp; abortando.");
    process.exit(1);
  }

  // Seed em banco temporário e CNPJ da empresa igual ao do certificado do mock.
  const db = require("../src/db");
  require("../src/db/seed").seed();
  const emp = db.all("empresas")[0];
  db.update("empresas", (e) => e.id === emp.id, { cnpj: CNPJ, razao_social: "EMPRESA TESTE LTDA", uf: "PB", demo: false });

  const limpar = () => {
    try {
      server.closeAllConnections();
      server.close();
      fs.rmSync(certs.dir, { recursive: true, force: true });
    } catch {
      /* Windows pode segurar arquivos; é diretório temporário */
    }
  };
  process.on("exit", limpar);

  require("../src/app"); // sobe o Express na porta 3002
  setTimeout(() => {
    console.log("\n=== Ambiente CIOT com ANTT MOCK pronto ===");
    console.log(`URL:    http://localhost:${PORTA_APP}`);
    console.log("Login:  admin / Admin@2026");
    console.log(`Mock:   https://127.0.0.1:${porta} (CNPJ ${CNPJ}, homologação, banco em ${dataDir})`);
    console.log("Forçar código: id_operacao E205.../E219.../E297... (ver comentário no topo do script)");
  }, 400);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
