const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "dev-only-altere-em-producao-" + Date.now();
  console.warn("JWT_SECRET não definido. Usando chave temporária de desenvolvimento.");
}

require("./db");
require("./db/seed");

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
  allowedHeaders: ["Content-Type", "Authorization"],
}));
// Limitadores só na API: assets estáticos do frontend não consomem a cota.
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, message: { error: "Muitas tentativas de login." } });
app.use(compression());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
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
app.use((err, req, res, next) => {
  logger.error("Unhandled", { error: err.message, stack: err.stack });
  const msg = err.message && err.message.startsWith("CIOT") ? err.message : "Erro interno do servidor";
  res.status(500).json({ error: msg });
});

// Com FISCAL_PROVIDER=focus, consulta periodicamente os documentos "processando".
const emissor = require("./services/emissor");
emissor.iniciarSincronizador();
console.log(`Emissor fiscal: ${emissor.modo() === "focus" ? `Focus NFe (${require("./services/focus").config().ambiente})` : "LOCAL (simulado, sem valor fiscal)"}`);

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
