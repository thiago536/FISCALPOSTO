// Express 4 não captura rejeição de handler async: sem isto a requisição fica
// pendurada e o erro escapa do tratamento central (app.js).
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { a };
