const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { a } = require("../utils/rota");
const ctrl = require("../controllers/authController");
router.post("/login", a(ctrl.login));
router.get("/me", auth, a(ctrl.me));
router.post("/senha", auth, a(ctrl.trocarSenha));
module.exports = router;
