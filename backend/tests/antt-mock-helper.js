// Helper compartilhado do mock mTLS da ANTT: acha openssl, gera CA/servidor/cliente
// num diretório temporário e sobe um servidor https com requestCert. Usado por
// scripts/dev-antt-mock.js (o antt-mtls.test.js tem sua própria cópia, intocada).
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

function acharOpenssl() {
  const candidatos = [
    process.env.OPENSSL_BIN,
    "openssl",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  ].filter(Boolean);
  for (const c of candidatos) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

// Gera certificados em um mkdtemp novo. Retorna { dir, arq, senha, pfx, ca, srvKey, srvCert }.
function gerarCertificados({ cnpj = "11222333000181", cn = "EMPRESA TESTE LTDA" } = {}) {
  const OPENSSL = acharOpenssl();
  if (!OPENSSL) throw new Error("openssl não encontrado (PATH, Git for Windows ou OPENSSL_BIN).");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antt-mock-"));
  const arq = (n) => path.join(dir, n);
  const ssl = (...args) => {
    const r = spawnSync(OPENSSL, args, { cwd: dir, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    if (r.status !== 0) throw new Error(`openssl ${args[0]} falhou: ${r.stderr || r.error}`);
  };
  fs.writeFileSync(
    arq("openssl.cnf"),
    `[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
[ca_ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[srv_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
[cli_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
`
  );
  const senha = "Senha-Dev-" + Math.random().toString(36).slice(2, 10);
  const CNF = ["-config", "openssl.cnf"];
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3", "-subj", "/CN=PostoFiscal CA de dev", ...CNF, "-extensions", "ca_ext");
  ssl("req", "-x509", "-CA", "ca.crt", "-CAkey", "ca.key", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.crt", "-days", "3", "-subj", "/CN=localhost", ...CNF, "-extensions", "srv_ext");
  ssl("req", "-x509", "-CA", "ca.crt", "-CAkey", "ca.key", "-newkey", "rsa:2048", "-nodes", "-keyout", "cli.key", "-out", "cli.crt", "-days", "3", "-subj", `/CN=${cn}:${cnpj}`, ...CNF, "-extensions", "cli_ext");
  ssl("pkcs12", "-export", "-inkey", "cli.key", "-in", "cli.crt", "-certfile", "ca.crt", "-passout", `pass:${senha}`, "-out", "cli.pfx");
  return { dir, arq, senha, pfx: arq("cli.pfx"), ca: arq("ca.crt"), srvKey: arq("srv.key"), srvCert: arq("srv.crt") };
}

// Sobe o mock com mTLS. `responder({ servico, body, headers })` devolve
// { status, json?, raw?, delay? }. Retorna { server, porta, recebidas }.
async function subirMock(certs, responder, porta = 0) {
  const recebidas = [];
  const server = https.createServer(
    {
      key: fs.readFileSync(certs.srvKey),
      cert: fs.readFileSync(certs.srvCert),
      ca: fs.readFileSync(certs.ca),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      res.on("error", () => {});
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const servico = req.url.split("/").pop();
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* corpo inválido */
        }
        recebidas.push({ servico, body, cn: req.socket.getPeerCertificate().subject?.CN });
        const passo = responder({ servico, body, headers: req.headers }) || { status: 500, raw: "sem roteiro" };
        const enviar = () => {
          if (res.destroyed) return;
          res.writeHead(passo.status, { "Content-Type": passo.json ? "application/json" : "text/plain" });
          res.end(passo.json ? JSON.stringify(passo.json) : passo.raw || "");
        };
        if (passo.delay) setTimeout(enviar, passo.delay);
        else enviar();
      });
    }
  );
  server.on("tlsClientError", () => {});
  await new Promise((r) => server.listen(porta, "127.0.0.1", r));
  return { server, porta: server.address().port, recebidas };
}

module.exports = { acharOpenssl, gerarCertificados, subirMock };
