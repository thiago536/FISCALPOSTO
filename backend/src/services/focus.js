/**
 * Cliente HTTP da API Focus NFe (https://doc.focusnfe.com.br).
 *
 * A Focus assina o XML com o certificado A1 cadastrado no painel dela e
 * transmite para a SEFAZ. Este módulo só fala HTTP: não conhece controllers
 * nem banco. Autenticação é HTTP Basic com o token como usuário e senha vazia.
 */
const URLS = {
  homologacao: "https://homologacao.focusnfe.com.br",
  producao: "https://api.focusnfe.com.br",
};

const ROTAS = { nfe: "nfe", cte: "cte", mdfe: "mdfe" };

function config() {
  const ambiente = (process.env.FOCUS_AMBIENTE || "homologacao").toLowerCase();
  if (!URLS[ambiente]) throw new Error(`FOCUS_AMBIENTE inválido: ${ambiente} (use homologacao ou producao)`);
  const token = process.env.FOCUS_TOKEN;
  if (!token) throw new Error("FOCUS_TOKEN não configurado no .env");
  // FOCUS_URL existe para apontar os testes para um servidor falso.
  const base = (process.env.FOCUS_URL || URLS[ambiente]).replace(/\/+$/, "");
  return { ambiente, token, base };
}

function rota(tipo) {
  const r = ROTAS[tipo];
  if (!r) throw new Error(`Tipo de documento sem rota na Focus: ${tipo}`);
  return r;
}

class FocusError extends Error {
  constructor(status, body) {
    const detalhes = Array.isArray(body && body.erros)
      ? body.erros.map((e) => (e.campo ? `${e.campo}: ${e.mensagem}` : e.mensagem)).join("; ")
      : "";
    const base = (body && (body.mensagem || body.mensagem_sefaz)) || `HTTP ${status}`;
    super(detalhes ? `${base} (${detalhes})` : base);
    this.status = status;
    this.body = body;
    this.codigo = body && body.codigo;
  }
}

async function request(method, path, body, { raw = false, timeoutMs = 60000 } = {}) {
  const { token, base } = config();
  const url = /^https?:\/\//.test(path) ? path : `${base}${path}`;
  // Arquivos às vezes vêm como URL absoluta de storage externo; o token só
  // vai para o host da própria Focus.
  const headers = new URL(url).origin === new URL(base).origin
    ? { Authorization: "Basic " + Buffer.from(`${token}:`).toString("base64") }
    : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (raw) {
    if (!res.ok) throw new FocusError(res.status, await res.json().catch(() => null));
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { mensagem: text.slice(0, 300) };
  }
  if (!res.ok) throw new FocusError(res.status, json);
  return json;
}

const enc = encodeURIComponent;

module.exports = {
  config,
  FocusError,
  emitir: (tipo, ref, payload) => request("POST", `/v2/${rota(tipo)}?ref=${enc(ref)}`, payload),
  consultar: (tipo, ref) => request("GET", `/v2/${rota(tipo)}/${enc(ref)}?completa=0`),
  cancelar: (tipo, ref, justificativa) => request("DELETE", `/v2/${rota(tipo)}/${enc(ref)}`, { justificativa }),
  encerrarMdfe: (ref, dados) => request("POST", `/v2/mdfe/${enc(ref)}/encerrar`, dados),
  // Os caminhos de XML/DANFE vêm relativos ao host da Focus (ex.: /arquivos/...).
  baixar: (caminho) => request("GET", caminho, undefined, { raw: true }),
};
