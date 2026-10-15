const jwt = require("jsonwebtoken");
const { get } = require("../db");

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não informado" });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = get("usuarios", (u) => u.id === payload.id);
    if (!user || !user.ativo) {
      return res.status(401).json({ error: "Usuário inválido ou inativo" });
    }
    req.user = {
      id: user.id,
      empresa_id: user.empresa_id,
      nome: user.nome,
      login: user.login,
      perfil: user.perfil,
      ativo: user.ativo,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.perfil !== "admin") {
    return res.status(403).json({ error: "Acesso restrito ao administrador" });
  }
  next();
}

module.exports = { auth, adminOnly };
