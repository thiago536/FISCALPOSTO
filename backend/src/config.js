/**
 * Validação da configuração na partida. Erro aqui impede o servidor de subir:
 * é melhor não iniciar do que iniciar inseguro ou emitindo no ambiente errado.
 */
const PLACEHOLDERS_JWT = new Set(["troque-esta-chave-por-uma-longa-e-aleatoria", "changeme", "secret"]);

const producao = () => process.env.NODE_ENV === "production";

function validarConfiguracao(env = process.env) {
  const erros = [];
  const avisos = [];
  const prod = env.NODE_ENV === "production";

  const jwt = env.JWT_SECRET || "";
  if (prod) {
    if (!jwt) erros.push("JWT_SECRET não definido. Gere um com: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"");
    else if (jwt.length < 32) erros.push("JWT_SECRET curto demais (mínimo 32 caracteres).");
    else if (PLACEHOLDERS_JWT.has(jwt) || jwt.startsWith("dev-only")) erros.push("JWT_SECRET ainda é o valor de exemplo.");
  }

  // Produção exige opt-in explícito e nunca roda sob NODE_ENV=test (evita certificado/token reais em testes).
  const pedeProducao = ["FOCUS_AMBIENTE", "ANTT_AMBIENTE"].some((k) => String(env[k] || "").toLowerCase() === "producao");
  if (pedeProducao) {
    if (env.NODE_ENV === "test") erros.push("Ambiente producao é proibido com NODE_ENV=test.");
    if (env.ALLOW_PRODUCAO !== "sim") erros.push("Ambiente producao exige ALLOW_PRODUCAO=sim (opt-in explícito).");
  }

  const fiscal = String(env.FISCAL_PROVIDER || "local").toLowerCase();
  if (!["local", "focus"].includes(fiscal)) erros.push(`FISCAL_PROVIDER inválido: ${env.FISCAL_PROVIDER} (use local ou focus).`);
  if (fiscal === "focus") {
    const amb = String(env.FOCUS_AMBIENTE || "homologacao").toLowerCase();
    if (!env.FOCUS_TOKEN) erros.push("FISCAL_PROVIDER=focus exige FOCUS_TOKEN.");
    if (!["homologacao", "producao"].includes(amb)) erros.push(`FOCUS_AMBIENTE inválido: ${env.FOCUS_AMBIENTE}.`);
    if (amb === "producao" && !prod) erros.push("FOCUS_AMBIENTE=producao só é aceito com NODE_ENV=production (evita emitir nota válida de uma máquina de teste).");
    if (env.FOCUS_URL && prod) erros.push("FOCUS_URL é só para testes e não é aceito em produção (o token iria para outro endereço).");
  }
  if (fiscal === "local" && prod && env.PERMITIR_EMISSAO_SIMULADA !== "1") {
    erros.push("Produção com FISCAL_PROVIDER=local emitiria documentos simulados. Configure a Focus ou defina PERMITIR_EMISSAO_SIMULADA=1 conscientemente.");
  }

  const ciot = String(env.CIOT_PROVIDER || "local").toLowerCase();
  if (!["local", "antt"].includes(ciot)) erros.push(`CIOT_PROVIDER inválido: ${env.CIOT_PROVIDER} (use local ou antt).`);
  if (ciot === "antt") {
    if (!env.ANTT_PFX_PATH) erros.push("CIOT_PROVIDER=antt exige ANTT_PFX_PATH.");
    if (String(env.ANTT_AMBIENTE || "homologacao").toLowerCase() === "producao" && !prod) {
      erros.push("ANTT_AMBIENTE=producao só é aceito com NODE_ENV=production.");
    }
  }

  if (prod && !env.CORS_ORIGIN) avisos.push("CORS_ORIGIN não definido: qualquer origem pode chamar a API pelo navegador.");
  return { erros, avisos };
}

module.exports = { validarConfiguracao, producao };
