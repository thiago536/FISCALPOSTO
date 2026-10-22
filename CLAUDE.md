# CLAUDE.md — contexto do PostoFiscal

Leia isto antes de mexer no projeto. Visão completa (custos, arquitetura, pendências) em `docs/Relatorio-PostoFiscal.pdf` (fonte HTML em `docs/relatorio.html`).

## O que é

Sistema web de emissão fiscal para posto de combustível e transporte: **NF-e (55), CT-e, MDF-e e CIOT**. Emitente real fica na **Paraíba (PB)**. Escrito do zero; não usa nada do sistema legado "Gerente" (descompilado, que fica fora deste repositório e **nunca** deve ser copiado para cá).

- Backend: Node.js 24 + Express 4, banco em arquivo JSON (`backend/data/fiscal.json`, fora do git). `backend/src/db/schema.sql` existe mas não é usado.
- Frontend: HTML/CSS/JS puro em `frontend/`, servido pelo próprio Express na porta 3001.
- Login padrão de desenvolvimento: `admin` / `Admin@2026` (criado por `db/seed.js`).

## Rodar

```bash
cd backend
cp .env.example .env     # Windows: copy
npm install
npm start                # http://localhost:3001 e IP da rede local
npm run test:all         # test (43) + seguranca (12) + focus (17) + emissor (9) + antt (12 grupos) + antt-mtls (50) + frontend (20)
```

`test:frontend` roda sem servidor. `npm test` e `test:focus` sobem o próprio servidor com banco temporário (ou usam `BASE_URL`). `test:antt-mtls` precisa de `openssl` (Git for Windows serve). Rodar a suíte muitas vezes em 15 min esgota o limitador de login (12 tentativas) → reinicie o servidor.

## Modos de emissão (`backend/.env`)

| Variável | Valores | Efeito |
| --- | --- | --- |
| `FISCAL_PROVIDER` | `local` (padrão) / `focus` | local = aprovação simulada sem valor fiscal (`services/sefaz.js`); focus = transmissão real via Focus NFe |
| `FOCUS_TOKEN`, `FOCUS_AMBIENTE` | token / `homologacao` \| `producao` | credencial da empresa no painel Focus |
| `CIOT_PROVIDER` | `local` / `antt` | antt = Web Service PEF da ANTT direto, mTLS |
| `ANTT_PFX_PATH`, `ANTT_PFX_SENHA`, `ANTT_AMBIENTE` | | certificado A1 do CNPJ |
| `ANTT_ID_MODO` | `manual` (padrão) / `sequencial_experimental` | manual = operador informa `id_operacao` gerado pelo gerador oficial da ANTT; sequencial é só teste (ANTT rejeita com 205) |

## Arquitetura dos pontos sensíveis

- `services/focus.js` — cliente HTTP da Focus (Basic auth, token só vai para a origem da Focus).
- `services/focusPayload.js` — converte registros internos no JSON da Focus (referência: campos.focusnfe.com.br). Numeração/série/chave vêm da Focus.
- `services/emissor.js` — decide local×focus; fluxo **assíncrono**: grava `processando` antes do envio, `ref` na Focus = id interno, sincronizador a cada `FOCUS_POLL_MS`. Regras: status nunca regride (cancelada/encerrada são finais), consulta ignora documento com POST em andamento, 404 só vira `rejeitada` após `FOCUS_PRAZO_404_MS` (5 min), 408/429 são temporários, MDF-e rejeitado libera CIOT.
- `services/antt.js` + `anttPayload.js` + `controllers/ciotController.js` — CIOT pelo **DCS PEF v1.1**, Web Service direto da ANTT como ETC em nome próprio (contratado = CNPJ do certificado, regra B115; operação com TAC exige Instituição de Pagamento). Grava `pendente` antes da rede; timeout/5xx/219 nunca viram rejeição; `GET /api/ciot/:id/consulta` recupera (297/220 → `nao_registrado` após margem). **Estado completo, regras com fonte, evidências de homologação e próximo passo: `docs/CIOT-STATUS.md`.**
- Controllers NF-e/CT-e/MDF-e têm dois caminhos (local e real) no `emitir`; não quebre o modo local, os 43 testes dependem dele.
- Frontend: todo dado vindo do servidor passa por `esc()` antes de ir para innerHTML (houve XSS; não reintroduza).

## Estado (14/10/2026)

- Código de emissão real pronto e testado contra mock da Focus (`tests/focus-mock.js`). **Nunca foi testado contra SEFAZ real.**
- CIOT (15/10/2026): comunicação mTLS com a **homologação** da ANTT comprovada (respostas 297/207/220/205). **Nenhum CIOT gerado com sucesso** — falta ID do gerador oficial + RNTRC/placa reais. Ver `docs/CIOT-STATUS.md`.
- Revisão de código feita; 6 achados corrigidos (XSS, duplicidade por corrida, regressão de status, CIOT preso, CIOT duplicado, vazamento de token).
- Frontend exercitado no navegador em 17/10/2026: modo local (NF-e, CT-e, MDF-e, CIOT, cadastros) e CIOT no modo ANTT contra `scripts/dev-antt-mock.js` (emitir, rejeição, 219, consultar, encerrar, cancelar, verificar RNTRC). Checklist em `docs/CIOT-STATUS.md`.

## Pendências (ordem)

1. Certificado e-CNPJ A1 **válido do próprio CNPJ** (vencido não serve; de cliente só com autorização escrita).
2. Conta Focus NFe (plano Solo R$ 94,90/mês, 100 docs, R$ 0,11 extra), token de homologação no `.env`.
3. Trocar empresa de exemplo do seed (SP, CNPJ fictício) pelos dados reais de PB.
4. Clientes com endereço + código IBGE (obrigatório no modo real).
5. Validar tributação com contador: CST combustível (60 vs 61 monofásico), PIS/COFINS 04, CFOP, ICMS CT-e PB, IBS/CBS 2026.
6. Homologação: emitir, corrigir rejeições da SEFAZ.
7. CIOT: `IdOperacaoTransporte` vem do gerador oficial da ANTT (DCS regra B4; homologação rejeitou ID local). Hoje: operador gera no executável oficial e informa `id_operacao`. **Não** embutir a chave da DLL oficial no código (repo público) nem usar o gerador AWS do projeto Delphi de terceiro. Próximos passos em `docs/CIOT-STATUS.md`.
8. Decidir **NFC-e (modelo 65)**: venda ao consumidor na bomba normalmente é NFC-e e o sistema não emite.
9. Backup de `backend/data/` (XML guardado 5 anos); considerar SQLite/PostgreSQL se volume crescer.
10. Trocar senha admin e `JWT_SECRET` antes de produção.

## Convenções

- Código, comentários e mensagens de UI em português; comentários explicam o porquê.
- Nunca commitar `.env`, `backend/data/`, logs, certificados (`*.pfx`, `*.p12`).
- Não afirmar que algo foi emitido de verdade sem token/certificado reais configurados.
