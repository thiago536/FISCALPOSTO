const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { get, update } = require("../db");
const logger = require("../middleware/logger");

exports.login = async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  }
  try {
    const login = String(usuario).trim().toLowerCase();
    const user = get("usuarios", (u) => String(u.login).toLowerCase() === login);
    if (!user || !user.ativo) return res.status(401).json({ error: "Credenciais inválidas" });
    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });

    update("usuarios", (u) => u.id === user.id, { ultimo_login: new Date().toISOString() });
    const token = jwt.sign(
      { id: user.id, empresa_id: user.empresa_id, perfil: user.perfil },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "8h" }
    );
    logger.info("Login", { login: user.login });
    return res.json({
      token,
      usuario: {
        id: user.id,
        nome: user.nome,
        login: user.login,
        perfil: user.perfil,
        empresa_id: user.empresa_id,
      },
    });
  } catch (err) {
    logger.error("login", { error: err.message });
    return res.status(500).json({ error: "Erro interno" });
  }
};

exports.me = (req, res) => {
  const empresa = get("empresas", (e) => e.id === req.user.empresa_id);
  return res.json({ usuario: req.user, empresa });
};

exports.trocarSenha = async (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_atual || !senha_nova || String(senha_nova).length < 8) {
    return res.status(400).json({ error: "Nova senha deve ter ao menos 8 caracteres" });
  }
  const user = get("usuarios", (u) => u.id === req.user.id);
  const ok = await bcrypt.compare(senha_atual, user.senha_hash);
  if (!ok) return res.status(401).json({ error: "Senha atual incorreta" });
  update("usuarios", (u) => u.id === user.id, { senha_hash: bcrypt.hashSync(senha_nova, 12) });
  return res.json({ ok: true });
};
