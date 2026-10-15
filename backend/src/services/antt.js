// Cliente do web service PEF da ANTT (mTLS, certificado ICP-Brasil A1 em PFX).
const fs = require("fs");
const https = require("https");
const { get, insert, update } = require("../db");

const BASES = {
  homologacao: "https://appservices-hml.antt.gov.br/pefServices/api",
  producao: "https://appservices.antt.gov.br/pefServices/api",
};
const TIMEOUT_MS = 30000;
const SUCESSO = new Set(["110", "111", "200"]); // 110 inserido, 111 consulta (manual pag. 64)

class AnttError extends Error {
  constructor(message, { codigo, status, protocolo, raw } = {}) {
    super(message);
    this.name = "AnttError";
    this.codigo = codigo;
    this.status = status;
    this.protocolo = protocolo;
    this.raw = raw;
  }
}

const modoAntt = () => String(process.env.CIOT_PROVIDER || "local").toLowerCase() === "antt";
const ambiente = () => (String(process.env.ANTT_AMBIENTE || "homologacao").toLowerCase() === "producao" ? "producao" : "homologacao");

let agent = null;
let agentKey = "";
function getAgent() {
  const path = process.env.ANTT_PFX_PATH;
  const senha = process.env.ANTT_PFX_SENHA;
  if (!path) throw new AnttError("ANTT_PFX_PATH não configurado");
  const key = `${path}|${senha}`;
  if (agent && key === agentKey) return agent;
  let pfx;
  try {
    pfx = fs.readFileSync(path);
  } catch (e) {
    throw new AnttError(`Não foi possível ler o certificado A1: ${e.code || e.message}`);
  }
  agent = new https.Agent({ pfx, passphrase: senha || "", minVersion: "TLSv1.2", keepAlive: true });
  agentKey = key;
  return agent;
}

function postJson(servico, payload) {
  const url = new URL(`${BASES[ambiente()]}/${servico}`);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent: getAgent(),
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* resposta nao-JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new AnttError(`Falha de comunicação com a ANTT: ${e.message}`)));
    req.end(body);
  });
}

const primeiro = (v) => (Array.isArray(v) ? v[0] : v);
const texto = (v) => (Array.isArray(v) ? v.join(" | ") : v);

async function chamar(servico, payload) {
  const { status, json, text } = await postJson(servico, payload);
  if (!json || typeof json !== "object") {
    throw new AnttError(`Resposta inválida da ANTT (HTTP ${status})`, { status, raw: text.slice(0, 500) });
  }
  const codigo = primeiro(json.Codigo) != null ? String(primeiro(json.Codigo)) : undefined;
  const ok = status >= 200 && status < 300 && (codigo === undefined || SUCESSO.has(codigo));
  if (!ok) {
    const msg = texto(json.Mensagem) || json.message || json.title || `HTTP ${status}`;
    throw new AnttError(`ANTT${codigo ? ` ${codigo}` : ""}: ${msg}`, { codigo, status, protocolo: json.Protocolo, raw: json });
  }
  return json;
}

// B17: ID unico por ano por declarante. Sequencial por empresa/ano (12 digitos).
function gerarIdOperacao(empresaId, ano = new Date().getFullYear()) {
  const pred = (r) => r.empresa_id === empresaId && r.ano === ano;
  const atual = get("ciot_seq", pred);
  let n;
  if (atual) {
    n = atual.ultimo + 1;
    update("ciot_seq", pred, { ultimo: n });
  } else {
    n = 1;
    insert("ciot_seq", { empresa_id: empresaId, ano, ultimo: n });
  }
  return String(n).padStart(12, "0");
}

module.exports = {
  AnttError,
  modoAntt,
  ambiente,
  gerarIdOperacao,
  // Lança AnttError se o PFX não estiver configurado ou não abrir.
  verificarCertificado: () => { getAgent(); },
  declarar: (p) => chamar("DeclaracaoOperacaoTransporte", p),
  cancelar: (p) => chamar("CancelamentoOperacaoTransporte", p),
  encerrar: (p) => chamar("EncerramentoOperacaoTransporte", p),
  consultarCiotGerado: (p) => chamar("ConsultarCIOTGerado", p),
  consultarSituacaoTransportador: (p) => chamar("ConsultarSituacaoTransportador", p),
  consultarFrotaTransportador: (p) => chamar("ConsultarFrotaTransportador", p),
};
