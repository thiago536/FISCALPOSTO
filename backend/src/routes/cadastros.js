const router = require("express").Router();
const { auth, adminOnly } = require("../middleware/auth");
const { a } = require("../utils/rota");
const ctrl = require("../controllers/cadastrosController");
router.get("/dashboard", auth, a(ctrl.dashboard));
router.get("/empresa", auth, a(ctrl.empresaGet));
// Dados do emitente e cadastro fiscal de produtos (CST, alíquota, NCM) mudam o
// conteúdo das notas: só administrador.
router.put("/empresa", auth, adminOnly, a(ctrl.empresaPut));
router.get("/clientes", auth, a(ctrl.clientesList));
router.post("/clientes", auth, a(ctrl.clientesCreate));
router.put("/clientes/:id", auth, a(ctrl.clientesUpdate));
router.get("/produtos", auth, a(ctrl.produtosList));
router.post("/produtos", auth, adminOnly, a(ctrl.produtosCreate));
router.put("/produtos/:id", auth, adminOnly, a(ctrl.produtosUpdate));
module.exports = router;
