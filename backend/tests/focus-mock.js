/**
 * Servidor falso da Focus NFe, só para testes (sem rede, sem SEFAZ).
 *
 *   const mock = await startMock();   // { url, port, received, state, close }
 *
 * Comportamento:
 *  - Basic auth: usuário = token esperado, senha vazia (401 caso contrário).
 *  - POST /v2/{nfe,cte,mdfe}?ref= valida campos obrigatórios (400) e responde
 *    202 processando_autorizacao. A PRIMEIRA consulta (GET) depois disso
 *    resolve o documento: autorizado, ou erro_autorizacao (status_sefaz 999)
 *    se o payload tiver nome_destinatario/nome_remetente "REJEITAR".
 *  - DELETE /v2/x/:ref  exige justificativa de 15 a 255 caracteres (422).
 *  - POST /v2/mdfe/:ref/encerrar  exige data, sigla_uf, nome_municipio.
 *  - GET /arquivos/...  devolve XML ou PDF.
 *  - state.fail: "5xx" responde 503 a tudo; "drop" derruba a conexão.
 */
const http = require("node:http");

const ROTAS = {
  nfe: { chave: "chave_nfe", xml: "caminho_xml_nota_fiscal", pdf: "caminho_danfe", modelo: "55" },
  cte: { chave: "chave_cte", xml: "caminho_xml", pdf: "caminho_dacte", modelo: "57" },
  mdfe: { chave: "chave_mdfe", xml: "caminho_xml", pdf: "caminho_damdfe", modelo: "58" },
};

const obrigatorios = {
  nfe: ["natureza_operacao", "cnpj_emitente", "nome_destinatario", "formas_pagamento", "items"],
  cte: ["cfop", "cnpj_emitente", "nome_remetente", "nome_destinatario", "valor_total", "modal_rodoviario", "nfes"],
  mdfe: ["emitente", "uf_inicio", "uf_fim", "cnpj_emitente", "modal_rodoviario", "municipios_descarregamento"],
};

const { dvChave } = require("../src/utils/documentos");

function startMock({ token = "test" } = {}) {
  const docs = new Map(); // `${tipo}/${ref}` -> doc
  const received = []; // { tipo, ref, payload }
  const state = { fail: null, contador: { nfe: 0, cte: 0, mdfe: 0 } };

  const chaveDe = (tipo, n) => {
    const base = `35${"2610"}11222333000181${ROTAS[tipo].modelo}001${String(n).padStart(9, "0")}1${String(n).padStart(8, "0")}`;
    return base + dvChave(base);
  };

  function resposta(tipo, d) {
    const r = ROTAS[tipo];
    const out = { status: d.status, ref: d.ref };
    if (d.status_sefaz) out.status_sefaz = d.status_sefaz;
    if (d.mensagem_sefaz) out.mensagem_sefaz = d.mensagem_sefaz;
    if (["autorizado", "cancelado", "encerrado"].includes(d.status)) {
      Object.assign(out, {
        [r.chave]: (tipo === "nfe" ? "NFe" : tipo === "cte" ? "CTe" : "MDFe") + d.chave,
        numero: String(d.numero),
        serie: "1",
        protocolo: d.protocolo,
        [r.xml]: `/arquivos/${tipo}/${d.ref}.xml`,
        [r.pdf]: `/arquivos/${tipo}/${d.ref}.pdf`,
      });
      if (d.status === "cancelado") out.caminho_xml_cancelamento = `/arquivos/${tipo}/${d.ref}-can.xml`;
    }
    return out;
  }

  const server = http.createServer((req, res) => {
    const send = (code, body, type = "application/json", raw = false) => {
      res.writeHead(code, { "Content-Type": type });
      res.end(raw ? body : JSON.stringify(body));
    };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (state.fail === "drop") return req.socket.destroy();
      if (state.fail === "5xx") return send(503, { codigo: "indisponivel", mensagem: "Servico indisponivel" });

      const auth = req.headers.authorization || "";
      const esperado = "Basic " + Buffer.from(`${token}:`).toString("base64");
      if (auth !== esperado) return send(401, { codigo: "nao_autorizado", mensagem: "Token invalido" });

      const url = new URL(req.url, "http://x");
      const partes = url.pathname.split("/").filter(Boolean);
      let body = {};
      const txt = Buffer.concat(chunks).toString("utf8");
      if (txt) {
        try {
          body = JSON.parse(txt);
        } catch {
          return send(400, { codigo: "requisicao_invalida", mensagem: "JSON invalido" });
        }
      }

      // Arquivos
      if (partes[0] === "arquivos") {
        const nome = partes[partes.length - 1];
        if (nome.endsWith(".pdf")) return send(200, Buffer.from("%PDF-1.4\n% mock focus\n%%EOF\n"), "application/pdf", true);
        const tipo = partes[1];
        const d = docs.get(`${tipo}/${nome.replace(/(-can)?\.xml$/, "")}`);
        if (!d) return send(404, { codigo: "nao_encontrado", mensagem: "Arquivo nao encontrado" });
        return send(200, `<?xml version="1.0"?><${tipo}Proc><chave>${d.chave}</chave><protocolo>${d.protocolo}</protocolo></${tipo}Proc>`, "application/xml", true);
      }

      if (partes[0] !== "v2" || !ROTAS[partes[1]]) return send(404, { codigo: "nao_encontrado", mensagem: "Rota inexistente" });
      const tipo = partes[1];
      const ref = partes[2] && decodeURIComponent(partes[2]);
      const chaveDoc = `${tipo}/${ref}`;

      // Emitir
      if (req.method === "POST" && !ref) {
        const refQ = url.searchParams.get("ref");
        if (!refQ) return send(400, { codigo: "requisicao_invalida", mensagem: "Parametro ref obrigatorio" });
        const faltando = obrigatorios[tipo].filter((c) => body[c] === undefined || body[c] === null || body[c] === "" || (Array.isArray(body[c]) && !body[c].length));
        if (faltando.length) {
          return send(400, { codigo: "requisicao_invalida", mensagem: "Campos obrigatorios ausentes", erros: faltando.map((c) => ({ campo: c, mensagem: "obrigatorio" })) });
        }
        if (docs.has(`${tipo}/${refQ}`)) return send(422, { codigo: "already_processed", mensagem: "Referencia ja utilizada" });
        received.push({ tipo, ref: refQ, payload: body });
        const rejeitar = body.nome_destinatario === "REJEITAR" || body.nome_remetente === "REJEITAR";
        const n = ++state.contador[tipo];
        docs.set(`${tipo}/${refQ}`, { ref: refQ, status: "processando_autorizacao", rejeitar, numero: n, chave: chaveDe(tipo, n), protocolo: `13526${String(n).padStart(10, "0")}` });
        return send(202, { status: "processando_autorizacao", ref: refQ });
      }

      const d = docs.get(chaveDoc);
      if (!ref || !d) return send(404, { codigo: "nao_encontrado", mensagem: "Nota fiscal nao encontrada" });

      if (req.method === "GET" && partes.length === 3) {
        if (d.status === "processando_autorizacao") {
          if (d.rejeitar) {
            d.status = "erro_autorizacao";
            d.status_sefaz = "999";
            d.mensagem_sefaz = "Rejeicao: erro simulado pelo mock";
          } else {
            d.status = "autorizado";
            d.status_sefaz = "100";
            d.mensagem_sefaz = "Autorizado o uso";
          }
        }
        return send(200, resposta(tipo, d));
      }

      if (req.method === "DELETE" && partes.length === 3) {
        const j = typeof body.justificativa === "string" ? body.justificativa.trim() : "";
        if (j.length < 15 || j.length > 255) {
          return send(422, { codigo: "requisicao_invalida", mensagem: "Justificativa deve ter de 15 a 255 caracteres" });
        }
        if (d.status !== "autorizado") return send(422, { codigo: "nao_pode_cancelar", mensagem: `Documento em ${d.status}` });
        d.status = "cancelado";
        d.status_sefaz = "135";
        d.mensagem_sefaz = "Evento registrado e vinculado";
        d.justificativa = j;
        return send(200, resposta(tipo, d));
      }

      if (req.method === "POST" && tipo === "mdfe" && partes[3] === "encerrar") {
        const faltando = ["data", "sigla_uf", "nome_municipio"].filter((c) => !body[c]);
        if (faltando.length) return send(400, { codigo: "requisicao_invalida", mensagem: `Campos ausentes: ${faltando.join(", ")}` });
        if (d.status !== "autorizado") return send(422, { codigo: "nao_pode_encerrar", mensagem: `MDF-e em ${d.status}` });
        d.status = "encerrado";
        d.status_sefaz = "135";
        d.mensagem_sefaz = "Encerramento registrado";
        d.encerramento = body;
        return send(200, resposta(tipo, d));
      }

      return send(405, { codigo: "metodo_invalido", mensagem: "Metodo nao suportado" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        received,
        state,
        docs,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

module.exports = { startMock };

if (require.main === module) {
  startMock({ token: process.env.FOCUS_TOKEN || "test" }).then((m) => console.log(`Mock Focus em ${m.url}`));
}
