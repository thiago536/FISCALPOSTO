// Cliente do web service PEF da ANTT (mTLS, certificado ICP-Brasil A1 em PFX).
// Referência: manual DCS PEF v1.1. Hosts oficiais na pág. 66 do DCS
// (https://appservices[-hml].antt.gov.br/pefServices); o sufixo "/api/<Serviço>"
// vem do exemplo do próprio DCS ("api/ConsultarExcecao") e foi confirmado em
// 15/10/2026 contra a homologação (ConsultarCIOTGerado respondeu código 297).
// O servidor da ANTT usa certificado GlobalSign (raiz já confiável no Node).
const fs = require("fs");
const https = require("https");
const tls = require("tls");
const crypto = require("crypto");
const { get, insert, update } = require("../db");

const BASES = {
  homologacao: "https://appservices-hml.antt.gov.br/pefServices/api",
  producao: "https://appservices.antt.gov.br/pefServices/api",
};
const HOST_HOMOLOGACAO = "appservices-hml.antt.gov.br";
const HOST_PRODUCAO = "appservices.antt.gov.br";
const TIMEOUT_PADRAO_MS = 30000;
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const hostOficial = (h) => h === HOST_HOMOLOGACAO || h === HOST_PRODUCAO;
// Únicos códigos de sucesso do manual: 110 "Dados inseridos", 111 "Consulta".
const SUCESSO = new Set(["110", "111"]);

/**
 * tipo:
 *  - "rejeicao": a ANTT respondeu e recusou (código de regra ou HTTP 4xx).
 *  - "indeterminado": não dá para saber se a ANTT processou (rede, timeout, 5xx,
 *    resposta sem código). Quem chamou deve consultar antes de repetir.
 *  - "configuracao": problema local (certificado, senha, URL) ou handshake TLS
 *    recusado; a operação não chegou a ser processada.
 */
class AnttError extends Error {
  constructor(message, { tipo = "indeterminado", codigo, status, protocolo, raw } = {}) {
    super(message);
    this.name = "AnttError";
    this.tipo = tipo;
    this.codigo = codigo;
    this.status = status;
    this.protocolo = protocolo;
    this.raw = raw;
  }
}
const erroConfig = (msg) => new AnttError(msg, { tipo: "configuracao" });

const modoAntt = () => String(process.env.CIOT_PROVIDER || "local").toLowerCase() === "antt";
const ambiente = () => (String(process.env.ANTT_AMBIENTE || "homologacao").toLowerCase() === "producao" ? "producao" : "homologacao");

function baseUrl() {
  if (ambiente() === "producao" && !(process.env.NODE_ENV === "production" && process.env.ALLOW_PRODUCAO === "sim")) {
    throw erroConfig("ANTT_AMBIENTE=producao exige NODE_ENV=production e ALLOW_PRODUCAO=sim");
  }
  const override = String(process.env.ANTT_BASE_URL || "").trim();
  if (!override) return BASES[ambiente()];
  let u;
  try {
    u = new URL(override);
  } catch {
    throw erroConfig("ANTT_BASE_URL inválida");
  }
  if (u.protocol !== "https:") throw erroConfig("ANTT_BASE_URL deve usar https");
  if (u.username || u.password) throw erroConfig("ANTT_BASE_URL não pode conter credenciais (user@host) — host não permitido");
  // Trava de segurança: o certificado A1 real só pode ir para o host oficial do ambiente.
  const amb = ambiente();
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const permitido = amb === "producao" ? host === HOST_PRODUCAO : host === HOST_HOMOLOGACAO || local;
  if (!permitido) {
    throw erroConfig(`ANTT_BASE_URL host "${host}" não permitido para ambiente ${amb} (permitido: ${amb === "producao" ? HOST_PRODUCAO : `${HOST_HOMOLOGACAO}, localhost, 127.0.0.1`})`);
  }
  return override.replace(/\/+$/, "");
}

function timeoutMs() {
  const n = Number(process.env.ANTT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_PADRAO_MS;
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const mtime = (p) => {
  try {
    return String(fs.statSync(p).mtimeMs);
  } catch {
    return "";
  }
};

// CN de e-CNPJ ICP-Brasil: "RAZAO SOCIAL:CNPJ".
function cnpjDoSubject(subject) {
  const cn = String(subject || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("CN="));
  const m = cn && /:([0-9A-Z]{12}[0-9]{2})\s*$/.exec(cn.slice(3));
  return m ? m[1] : null;
}

const dataBr = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/");

// Cache do agente: chave = caminho + mtime + hash da senha (a senha em claro não fica na chave).
let cache = null;

function carregar() {
  const path = process.env.ANTT_PFX_PATH;
  const senha = process.env.ANTT_PFX_SENHA || "";
  if (!path) throw erroConfig("ANTT_PFX_PATH não configurado");
  const caPath = process.env.ANTT_CA_PATH || "";
  const pfxMtime = mtime(path);
  const key = [path, pfxMtime, hash(senha), caPath, caPath ? mtime(caPath) : ""].join("|");
  if (!cache || cache.key !== key) {
    let pfx;
    try {
      pfx = fs.readFileSync(path);
    } catch (e) {
      throw erroConfig(`Não foi possível ler o certificado A1 (${e.code || "erro de leitura"})`);
    }
    let ctx;
    try {
      ctx = tls.createSecureContext({ pfx, passphrase: senha });
    } catch {
      // Mensagem do OpenSSL omitida de propósito: não ecoa senha nem bytes do arquivo.
      throw erroConfig("Certificado A1 inválido ou senha incorreta (ANTT_PFX_PATH / ANTT_PFX_SENHA)");
    }
    let ca;
    if (caPath) {
      try {
        ca = [...tls.rootCertificates, fs.readFileSync(caPath, "utf8")];
      } catch (e) {
        throw erroConfig(`Não foi possível ler ANTT_CA_PATH (${e.code || "erro de leitura"})`);
      }
    }
    let info = { disponivel: false, cnpj: null, valido_de: null, valido_ate: null, icp_brasil: null };
    const getCert = ctx.context && typeof ctx.context.getCertificate === "function" ? ctx.context.getCertificate.bind(ctx.context) : null;
    const der = getCert ? getCert() : null;
    if (getCert && !der) throw erroConfig("O arquivo PFX não contém certificado");
    if (der && typeof crypto.X509Certificate === "function") {
      const x = new crypto.X509Certificate(der);
      // DCS "Padrão de Segurança": EKU com "Autenticação Cliente". Sem a extensão
      // EKU o certificado vale para qualquer uso; com ela, clientAuth é exigido.
      const eku = Array.isArray(x.keyUsage) ? x.keyUsage : null;
      if (eku && !eku.includes(OID_CLIENT_AUTH)) {
        throw erroConfig("Certificado A1 sem permissão de Autenticação Cliente (Extended Key Usage); a ANTT recusaria o mTLS");
      }
      info = {
        disponivel: true,
        cnpj: cnpjDoSubject(x.subject),
        valido_de: new Date(x.validFrom),
        valido_ate: new Date(x.validTo),
        icp_brasil: /(^|\n)\s*O=ICP-Brasil\s*(\n|$)/.test(x.issuer),
      };
    }
    const agent = new https.Agent({ pfx, passphrase: senha, ca, minVersion: "TLSv1.2", keepAlive: true });
    if (cache) cache.agent.destroy();
    cache = { key, agent, info };
  }
  const { info } = cache;
  // Validade conferida a cada uso: o tempo passa com o agente em cache.
  if (info.disponivel) {
    const agora = Date.now();
    if (agora > info.valido_ate.getTime()) throw erroConfig(`Certificado A1 vencido em ${dataBr(info.valido_ate)}`);
    if (agora < info.valido_de.getTime()) throw erroConfig(`Certificado A1 só é válido a partir de ${dataBr(info.valido_de)}`);
  }
  return cache;
}

// Erros de handshake: o servidor recusou nosso certificado ou não confiamos no dele.
// A requisição não foi processada pela aplicação da ANTT.
const TLS_RECUSADO =
  /ALERT_CERTIFICATE_REQUIRED|ALERT_BAD_CERTIFICATE|ALERT_UNKNOWN_CA|ALERT_CERTIFICATE_EXPIRED|ALERT_CERTIFICATE_REVOKED|ALERT_ACCESS_DENIED|ALERT_HANDSHAKE_FAILURE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF|ERR_TLS_CERT_ALTNAME/;

function postJson(servico, payload) {
  // Host guard antes de qualquer leitura do certificado.
  const url = new URL(`${baseUrl()}/${servico}`);
  const { agent, info } = carregar();
  // DCS: só certificado ICP-Brasil é aceito. Mock local (testes) usa CA própria.
  if (hostOficial(url.hostname) && info.disponivel && !info.icp_brasil) {
    throw erroConfig("Certificado A1 não foi emitido por AC da ICP-Brasil; a ANTT só aceita ICP-Brasil");
  }
  const body = JSON.stringify(payload);
  const limite = timeoutMs();
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent,
        timeout: limite,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", (e) => reject(new AnttError(`Falha de comunicação com a ANTT: ${e.code || e.message}`)));
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
    req.on("timeout", () => {
      const e = new Error(`timeout após ${limite} ms`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.on("error", (e) => {
      const desc = e.code === "ETIMEDOUT" ? e.message : e.code || e.message;
      if (TLS_RECUSADO.test(String(e.code || "")) || TLS_RECUSADO.test(String(e.message || ""))) {
        return reject(erroConfig(`Conexão TLS com a ANTT recusada (${desc}); verifique o certificado A1 e a cadeia confiável`));
      }
      return reject(new AnttError(`Falha de comunicação com a ANTT: ${desc}`));
    });
    req.end(body);
  });
}

const lista = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// Homologação (15/10/2026) devolveu Mensagem como string contendo um array JSON:
// "[\"Rejeição: ...\",\"Rejeição: ...\"]". Desembrulha para não exibir colchetes.
function texto(v) {
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) v = arr;
    } catch {
      /* string comum que começa com "[" */
    }
  }
  return Array.isArray(v) ? v.map((x) => String(x).trim()).join(" | ") : typeof v === "string" ? v.trim() : v;
}
// Codigo pode vir como 110, "110" ou "110 - Dados inseridos".
const codigoDe = (v) => {
  const s = String(v ?? "").trim();
  const m = /^(\d{3})\b/.exec(s);
  return m ? m[1] : s || null;
};

// Classifica a resposta (função pura, testável sem rede). Retorna { ok, tipo, codigo, mensagem }.
function classificar(status, json) {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? json : null;
  const codigos = obj ? lista(obj.Codigo).map(codigoDe).filter(Boolean) : [];
  const codigo = codigos[0];
  const mensagem = obj ? texto(obj.Mensagem) || obj.message || obj.title : undefined;
  const ok2xx = status >= 200 && status < 300;
  const todosSucesso = codigos.length > 0 && codigos.every((c) => SUCESSO.has(c));
  if (ok2xx && todosSucesso) return { ok: true, codigo, mensagem };
  const ruim = codigos.find((c) => !SUCESSO.has(c)) || codigo;
  if (codigos.length && !todosSucesso && status < 500) return { ok: false, tipo: "rejeicao", codigo: ruim, mensagem };
  // 401/403 sem código de regra: o acesso foi barrado antes da aplicação (certificado
  // não cadastrado/autorizado na ANTT). Nada foi processado.
  if (status === 401 || status === 403) return { ok: false, tipo: "configuracao", codigo, mensagem, acesso_recusado: true };
  // 404 sem código: rota/serviço inexistente (URL errada) — nada foi processado.
  if (status === 404) return { ok: false, tipo: "configuracao", codigo, mensagem };
  // 408/409/425/429 sem código: temporários ou ambíguos; não provam que a ANTT recusou.
  if ([408, 409, 425, 429].includes(status)) return { ok: false, tipo: "indeterminado", codigo, mensagem };
  if (status >= 400 && status < 500) return { ok: false, tipo: "rejeicao", codigo, mensagem };
  return { ok: false, tipo: "indeterminado", codigo, mensagem };
}

async function chamar(servico, payload) {
  const { status, json, text } = await postJson(servico, payload);
  const c = classificar(status, json);
  if (c.ok) return json;
  let msg;
  if (c.acesso_recusado) msg = `Acesso recusado pela ANTT (HTTP ${status}): certificado não cadastrado ou sem permissão para o web service PEF${c.mensagem ? ` — ${c.mensagem}` : ""}`;
  else if (c.tipo === "rejeicao") msg = `ANTT${c.codigo ? ` ${c.codigo}` : ""}: ${c.mensagem || `HTTP ${status}`}`;
  else if (!json) msg = `Resposta inválida da ANTT (HTTP ${status})`;
  else msg = `Resposta sem confirmação da ANTT (HTTP ${status}${c.codigo ? `, código ${c.codigo}` : ""})${c.mensagem ? `: ${c.mensagem}` : ""}`;
  throw new AnttError(msg, {
    tipo: c.tipo,
    codigo: c.codigo,
    status,
    protocolo: json && json.Protocolo,
    raw: json || String(text || "").slice(0, 500),
  });
}

// MODO EXPERIMENTAL (ANTT_ID_MODO=sequencial_experimental). O DCS PEF v1.1 (regra
// B4) diz que o IdOperacaoTransporte "deve ser gerado conforme padrão definido pela
// ANTT, utilizando a DDL/Executável disponibilizada para geração do identificador";
// B16 confere o formato (ID da administradora + DV). Este sequencial NÃO segue esse
// padrão e só existe para testes de integração. B17: único por ano por declarante.
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
  classificar,
  cnpjDoSubject,
  textoMensagem: texto,
  /**
   * Abre o PFX de verdade (senha conferida), checa validade e a URL base.
   * Retorna { cnpj, valido_de, valido_ate, icp_brasil } (cnpj null se não constar no CN).
   * Lança AnttError tipo "configuracao". Nunca faz chamada de rede.
   */
  verificarCertificado() {
    baseUrl();
    const { info } = carregar();
    return { cnpj: info.cnpj, valido_de: info.valido_de, valido_ate: info.valido_ate, icp_brasil: info.icp_brasil };
  },
  declarar: (p) => chamar("DeclaracaoOperacaoTransporte", p),
  cancelar: (p) => chamar("CancelamentoOperacaoTransporte", p),
  encerrar: (p) => chamar("EncerramentoOperacaoTransporte", p),
  consultarCiotGerado: (p) => chamar("ConsultarCIOTGerado", p),
  consultarSituacaoTransportador: (p) => chamar("ConsultarSituacaoTransportador", p),
  consultarFrotaTransportador: (p) => chamar("ConsultarFrotaTransportador", p),
};
