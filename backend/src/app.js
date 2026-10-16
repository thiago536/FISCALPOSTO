const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// ENV_FILE permite aos testes isolar o .env da máquina.
require("dotenv").config({ path: process.env.ENV_FILE || path.join(__dirname, "../.env") });

const { validarConfiguracao, producao } = require("./config");

function abortar(linhas) {
  console.error(["", "ERRO DE INICIALIZAÇÃO — o servidor não foi iniciado:", ...linhas.map((l) => `  - ${l}`), ""].join("\n"));
  process.exit(1);
}

const { erros, avisos } = validarConfiguracao();
if (erros.length) abortar(erros);
avisos.forEach((a) => console.warn(`AVISO: ${a}`));

if (!process.env.JWT_SECRET) {
  // Só chega aqui fora de produção (validarConfiguracao barra em produção).
  process.env.JWT_SECRET = "dev-only-" + crypto.randomBytes(24).toString("hex");
  console.warn("JWT_SECRET não definido. Usando chave temporária de desenvolvimento (logins caem ao reiniciar).");
}

try {
  require("./db");
} catch (err) {
  if (err.name === "DbError") abortar(err.message.split("\n"));
  throw err;
}
const { seed } = require("./db/seed");
seed();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const logger = require("./middleware/logger");

const app = express();
const frontendDir = path.join(__dirname, "../../frontend");

app.use(helmet({ contentSecurityPolicy: false }));
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : true;

app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id"],
}));

// Identificador de correlação: liga resposta, log e trilha de auditoria.
app.use((req, res, next) => {
  const recebido = req.get("X-Request-Id");
  req.correlacao = recebido && /^[A-Za-z0-9-]{8,64}$/.test(recebido) ? recebido : crypto.randomUUID();
  res.set("X-Request-Id", req.correlacao);
  next();
});

// Limitadores só na API: assets estáticos do frontend não consomem a cota.
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, message: { error: "Muitas tentativas de login." } });
app.use(compression());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { correlacao: req.correlacao });
  next();
});

app.get("/api/health", (req, res) => res.json({ status: "ok", ts: new Date() }));
// Limite estrito nas duas rotas que comparam senha; /me fica fora da cota.
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/senha", loginLimiter);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/cadastros", require("./routes/cadastros"));
app.use("/api/nfe", require("./routes/nfe"));
app.use("/api/cte", require("./routes/cte"));
app.use("/api/mdfe", require("./routes/mdfe"));
app.use("/api/ciot", require("./routes/ciot"));

if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(frontendDir, "index.html")));
}

app.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));

// Tratamento central: erro de validação vira 400 com o campo; o resto vira 500
// genérico (detalhe só no log), sempre com o identificador de correlação.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON inválido no corpo da requisição", correlacao: req.correlacao });
  }
  if (err.name === "ValidacaoError" || (err.status >= 400 && err.status < 500 && err.expose !== false)) {
    return res.status(err.status || 400).json({ error: err.message, campo: err.campo, correlacao: req.correlacao });
  }
  logger.error("Erro não tratado", { correlacao: req.correlacao, error: err.message, stack: err.stack });
  return res.status(500).json({ error: "Erro interno do servidor", correlacao: req.correlacao });
});

process.on("unhandledRejection", (err) => {
  logger.error("Promise rejeitada sem tratamento", { error: err && err.message, stack: err && err.stack });
});
// Encerramento limpo libera o lock do banco.
for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => process.exit(0));

// Com FISCAL_PROVIDER=focus, consulta periodicamente os documentos "processando".
const emissor = require("./services/emissor");
emissor.iniciarSincronizador();
console.log(`Emissor fiscal: ${emissor.modo() === "focus" ? `Focus NFe (${require("./services/focus").config().ambiente})` : "LOCAL (simulado, sem valor fiscal)"}`);
if (producao()) console.log("Modo produção: seed de demonstração desativado.");

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  logger.info(`Servidor em ${HOST}:${PORT}`);
  console.log(`API e interface: http://localhost:${PORT}`);
  for (const [, addrs] of Object.entries(require("os").networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) {
        console.log(`Rede local:        http://${a.address}:${PORT}`);
      }
    }
  }
});

module.exports = app;
