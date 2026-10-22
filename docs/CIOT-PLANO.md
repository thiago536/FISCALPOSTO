# CIOT — plano para a 1ª homologação ANTT (sem dados reais)

Fonte: `CLAUDE.md`, `docs/CIOT-STATUS.md` (Pendências 3, 5, 6, 7), código lido em 17/10/2026.
Destino pedido: `docs/CIOT-PLANO.md` (planner só pode gravar em `.squad/`; copiar na T11).

Regras globais (todas as tarefas):
- Sem rede nos testes; ANTT só via mock mTLS de `tests/antt-mtls.test.js` (roteirizar/recebidas) ou funções puras.
- Nunca chave da DLL oficial, nunca CNPJ do certificado real/senha em docs ou testes (usar 11222333000181 / 11444777000161 dos testes).
- Modo local intacto: `npm test` continua com os 42 atuais passando (novos testes somam; atualizar contagem em docs).
- Todo dado do servidor em innerHTML passa por `esc()`. Código/comentários/UI em português.
- `npm run test:all` verde ao fim de cada tarefa.

Legenda: **[dev]** = lógica/decisão; **[impl]** = mecânico. **∥** = paralelo-seguro.

---

## T1 [dev] ∥ — Backend: `GET /api/ciot/config` (frontend descobre o provedor)

Arquivos: `backend/src/routes/ciot.js` (rota ANTES de `/:id`), `backend/src/controllers/ciotController.js` (nova `exports.config`).

Comportamento:
- Local: `{ provider: "local" }`.
- ANTT: `{ provider: "antt", ambiente, id_modo, empresa_cnpj, certificado: { ok, cnpj, valido_ate, icp_brasil } | { ok:false, erro } }`.
  - `id_modo` via `modoId()`; `ANTT_ID_MODO` inválido → `id_modo: null, erro_config: <msg>` (não 500).
  - `antt.verificarCertificado()` em try/catch; `erro` = `e.message` (já testado que não contém senha). Nunca devolver `ANTT_PFX_PATH`/senha/base URL.
  - `ambiente === "producao"` sem `ALLOW_PRODUCAO` → `certificado.ok:false` com a mensagem de `baseUrl()`.
- Auth obrigatório (`auth`), sem rede.

Pronto quando / testes:
- `tests/e2e.js`: novo teste "config do CIOT no modo local" → 200, `provider === "local"`.
- `tests/antt-mtls.test.js`: config com PFX_OK → `provider antt`, `certificado.ok`, `cnpj 11222333000181`, `JSON.stringify(body)` sem `SENHA` nem caminho do pfx; com senha errada → `ok:false`, sem senha; `recebidas.length` inalterado.

## T2 [dev] — Backend: guardar evidência da declaração e entrada para reenvio (Pendência 3)

Arquivos: `ciotController.js`. Depois de T1 (mesmo arquivo).

Comportamento:
- Ao gravar `pendente`: `payload_declaracao` = payload exato enviado (já com `IdOperacaoTransporte` final) e `entrada_antt` = objeto de entrada normalizado (saída de `dadosAntt(...)` + campos legados `contratante_nome`, `motorista_nome`, `motorista_cpf`, `valor_contrato`, `valor_adiantamento`, `id_operacao`). Serve para pré-preencher "Reenviar com o mesmo ID" (T7).
- Em toda resposta da declaração (110, rejeição, indeterminado com JSON): `resposta_antt` = JSON bruto (`r` ou `e.raw`), limitado a 4000 chars quando string. Na consulta bem-sucedida: `resposta_consulta`. Objetivo: registrar o formato real do 1º 110 (nome do campo do ID, tipo do `CodigoVerificador`) sem depurar.
- `listar` devolve versão resumida (sem `payload_declaracao`, `entrada_antt`, `resposta_*`); `detalhe` devolve tudo.
- Nenhum desses campos entra na trilha fiscal (só código/mensagem, como hoje).

Pronto quando / testes (`antt-mtls.test.js`):
- Após 110: linha tem `payload_declaracao.IdOperacaoTransporte`, `resposta_antt.Codigo === "110"`; após 205: `resposta_antt` presente e status `rejeitado`.
- `listar` não traz `payload_declaracao`; `detalhe` traz.
- Conteúdo do arquivo do banco não contém `SENHA`.

## T3 [dev] — Backend: pequenos acertos do fluxo CIOT

Arquivos: `ciotController.js`, `frontend/index.html`. Depois de T2.

1. Modo ANTT: se `placa` vier vazia e `veiculos[0].placa` existir, usar essa como `placa` legada (hoje 400 "Contratante, motorista e placa são obrigatórios" obriga duplicar). Modo local inalterado.
2. `listar?placa=` também casa com `veiculos[].placa` (CIOT ANTT com várias placas).
3. `index.html` linha ~200: texto "Obrigatório no contrato de frete com TAC" está desatualizado (Res. ANTT 6.078/2026: toda operação rodoviária remunerada; TAC exige Instituição de Pagamento). Trocar por texto fiel a `CIOT-STATUS.md`.

Testes (`antt-mtls.test.js`): emitir ANTT sem `placa` com `veiculos` → 201/emitido com `placa` = 1ª placa; filtro por 2ª placa encontra o CIOT. `e2e.js` (local) sem mudança e verde.

## T4 [dev] ∥ — MDF-e `infCIOT`: responsável = ETC (Pendência 5, parcial)

Evidência no repo: `CIOT-STATUS.md` pend. 5 ("para operação ETC o responsável é o CNPJ da ETC") + regra B115 já implementada (contratado = CNPJ do certificado = quem gera o CIOT). Bug concreto: os dois caminhos divergem e nenhum usa a ETC — `focusPayload.js:196` usa `contratante_doc` (o cliente), `xml.js:224` usa `motorista_cpf`.

Arquivos: `backend/src/services/focusPayload.js`, `backend/src/services/xml.js`, helper único (sugestão `responsavelCiot(ciot, empresa)` em `backend/src/utils/fiscal.js`), `backend/src/controllers/mdfeController.js` só se precisar passar a empresa.

Comportamento:
- `responsavelCiot` = `normalizarDoc(ciot.contratado_doc || empresa.cnpj)`; tag/campo CPF ou CNPJ conforme `tipoDoc` (11 → CPF, 14 → CNPJ).
- Focus: `cnpj_responsavel`/`cpf_responsavel` com esse doc. XML local: `<CNPJ>`/`<CPF>` com esse doc (simulado usa CNPJ da empresa).
- Manter `slice(0, 12)` do número (ver Questão Q1). Comentário citando a fonte e que falta conferência com o MOC.

Testes:
- `tests/antt-payload.test.js`: novo grupo "MDF-e infCIOT": `focusPayload.mdfe(emp, m, [], [], [], ciotAntt)` → `modal_rodoviario.ciot[0].cnpj_responsavel === "11222333000181"`, sem `contratante_doc`; `ciot === numero.slice(0,12)`.
- `tests/e2e.js` teste "XML do MDF-e: documentos, CIOT e condutor presentes": acrescentar assert de `<infCIOT>...<CNPJ>{cnpj empresa}</CNPJ>` (sem novo teste; 42 continua 42).

## T5 [impl] ∥ — Frontend: módulos testáveis sem navegador

Arquivos: novo `frontend/src/esc.js` (move `esc`, `fmt`), novo `frontend/src/ciot.js` (funções puras), `frontend/index.html` (scripts `esc.js`, `ciot.js` antes de `app.js`), `frontend/src/app.js` (remove cópia de `esc/fmt`; `apiFetch` em erro lança `Error` com `.status` e `.data` = corpo JSON — compatível com quem só lê `.message`), novo `backend/tests/frontend-ciot.test.js`, `backend/package.json` (`test:frontend`, incluir em `test:all`).

Padrão dos módulos: `(function (g) { ... ; if (typeof module !== "undefined") module.exports = api; else Object.assign(g, api); })(this);`

`ciot.js` exporta (implementação na T6/T7; aqui só esqueleto + `esc` reaproveitado):
- `montarCorpoCiotAntt(campos)` → corpo do `POST /api/ciot` no formato de `dadosAntt`.
- `acoesCiot(c)` → lista de ações permitidas por `provider`/`status`/`operacao_pendente`/`mdfe_id`.
- `rotuloStatusCiot(status)`, `textoProximaAcao(proxima_acao)`.
- `detalheCiotHtml(c)` → HTML do painel, tudo por `esc()`.

Pronto: `npm run test:frontend` roda `require("../../frontend/src/esc.js")` e testa `esc("<img src=x onerror=alert(1)>")`; páginas existentes funcionam (e2e não cobre frontend → checklist manual: login, NF-e lista, CIOT lista).

## T6 [dev] — Frontend: formulário CIOT modo ANTT (Pendência 6)

Depende de T1, T5. Arquivos: `frontend/src/app.js` (`openCiotForm`), `frontend/src/ciot.js`, `frontend/style.css` se preciso.

Comportamento:
- `cache.ciotConfig` = `GET /ciot/config` (1x por sessão, recarrega no "Atualizar"). `provider !== "antt"` → formulário atual idêntico (local).
- Faixa no topo do modal: ambiente (HOMOLOGAÇÃO = "sem validade jurídica"), certificado (CNPJ/validade ou erro de `config`) — tudo `esc()`. Certificado `ok:false` → botão Emitir desabilitado com o motivo.
- Campos ANTT (nomes = `dadosAntt`):
  - `tipo_operacao`: 1 Padrão, 2 Fracionada; 3 TAC-Agregado ausente/desabilitado com texto "exige Instituição de Pagamento (B27/B115)".
  - `id_operacao`: obrigatório no `id_modo manual`, `pattern="[0-9A-Z]{12}"`, maiúsculas automáticas, ajuda: "gerado no executável oficial da ANTT (regra B4)". `sequencial_experimental`: campo oculto + aviso amarelo.
  - Contratado: CNPJ da empresa (readonly, de `config.empresa_cnpj`), `contratado_rntrc` obrigatório (8–9 dígitos).
  - Contratante: nome, doc, `contratante_rntrc` opcional. `destinatario_doc` obrigatório (tipos 1/2).
  - Motorista nome/CPF (legado, usado no MDF-e).
  - Veículos: lista dinâmica 1–5 (`placa`, `eixos` 1–4, `rntrc` opcional); botão "+ veículo" some no 5º (B49); placa repetida bloqueada (B5).
  - Datas: `data_inicio_viagem` (min hoje, max hoje+30, B6/B22), `data_fim_viagem` (≥ início, ≤ início+90, B13/B21). Datas em America/Sao_Paulo.
  - Origem/destino: linhas; **um** seletor de tipo por linha (município IBGE 7 dígitos / CEP 8 / lat-long) aplicado a origem e destino (B111), `distancia` km obrigatória.
  - Carga (tipos 1/2): `natureza` (até 4 dígitos), `tipo` 1–12 (numérico; ver Q3), `peso` kg; tipo 2: `contratantes_frac` (um doc por linha, ≠ contratante — B119).
  - Pagamento: `tipo_pagamento` 2 CC, 3 Poupança, 4 Conta pagamento, 5 Outros, 6 Pix (1 não aparece — B118); condicionais: 2–4 banco/agência/conta; 6 `chave_pix` + `identificador_pix` (≤32); `creditado_doc` opcional; `ind_pagamento` 0/1 com parcela (número, vencimento, valor) só se 1 (B105).
  - `valor_contrato` (= ValorFrete), `valor_adiantamento`.
  - Tipo 1: indicadores (alto desempenho, retorno vazio, composição veicular).
  - Contingência: checkbox + justificativa obrigatória ≤255 (backend já suporta; ver T-fora).
- Validação no cliente é só ajuda; backend continua a autoridade (mensagens 400 dele exibidas como vieram, via `textContent`/`esc`).
- Envio com header `Idempotency-Key: crypto.randomUUID()` gerado ao abrir o modal. **Regerar a chave** após resposta definitiva (201 emitido, 400 validação, `rejeitado`, `nao_enviado`) — senão o reenvio corrigido devolve a linha rejeitada antiga (`reaproveitado`). Manter a mesma chave só se a requisição falhou sem resposta (rede do navegador).
- Respostas: 201 → toast com número (ou "SIMULADO"); erro com `ex.data.status === "pendente"` → toast aviso "Sem confirmação da ANTT: consulte" e abre o detalhe (T7); `rejeitado`/`nao_enviado` → mensagem da ANTT dentro do modal, formulário continua aberto para corrigir e reenviar com o mesmo ID.

Testes (`frontend-ciot.test.js`, sem navegador):
- `montarCorpoCiotAntt` com campos do `corpo()` de `antt-mtls` gera objeto que `P.montarDeclaracao(...)` aceita (via `require("../src/services/anttPayload")`, emissorDoc 11222333000181) — pega divergência de nomes.
- B111: linha com tipo único gera origem/destino do mesmo tipo.
- Tipo 2 não manda indicadores; tipo 1 manda.
- `antt-mtls.test.js`: um teste emitindo com o corpo produzido por `montarCorpoCiotAntt` → 110 → `emitido`.
Checklist manual (anotar no CIOT-STATUS): local e antt (mock) no navegador.

## T7 [dev] — Frontend: detalhe do CIOT e ações (consulta, confirmar, encerrar, cancelar, reenviar)

Depende de T2, T5, T6 (mesmo `app.js` → sequencial). Arquivos: `frontend/src/app.js` (`loadCiot` com clique na linha, `openCiotDetail`), `frontend/src/ciot.js`.

Painel (`openPanel`, tudo `esc`): número (só se `oficial` ou simulado com selo), `id_operacao` "(não é CIOT)" se não emitido, status + explicação (tabela de estados do CIOT-STATUS), ambiente, `codigo_antt`, `mensagem_antt`, protocolos (declaração/cancelamento/encerramento), veículos, datas, contratado, MDF-e vinculado, `operacao_pendente` em destaque.

Matriz `acoesCiot` (provider antt):
| status | ações |
| --- | --- |
| pendente | Consultar na ANTT |
| emitido | Consultar, Encerrar, Cancelar (Cancelar oculto se `mdfe_id` com MDF-e autorizado — backend já barra) |
| rejeitado / nao_enviado / nao_registrado | Reenviar com o mesmo ID (abre T6 pré-preenchido com `entrada_antt`, datas revalidadas) |
| cancelado / encerrado | nenhuma |
| `operacao_pendente` | rótulo "Repetir cancelamento/encerramento" |
Local: emitido → Cancelar (sem motivo, como hoje); nada de consulta/encerrar.

Fluxos:
- Consultar: `GET /ciot/:id/consulta`. 200 → atualiza. 409 `consultar_novamente` → mostra a espera (texto do backend). 409 `confirmar_com_antt` → caixa explicando 219 + número devolvido → `confirm()` → `GET ...?confirmar=1`. 404 `reenviar_mesmo_id` → status `nao_registrado` + botão Reenviar. 502 `verificar_com_antt` → mensagem. 409 "operação em andamento" → toast. Sem polling automático (cada consulta é chamada à ANTT).
- Encerrar: modal; `peso_carga` obrigatório se `tipo_operacao === 1`, ausente se 2 (B65/B57); 409 com status `encerrado`/`cancelado` (222/251) → recarrega.
- Cancelar (ANTT): `motivo` obrigatório ≤500 → `POST /cancelar {motivo}`.
- Toda ação recarrega lista + painel.

Testes (`frontend-ciot.test.js`): matriz `acoesCiot` completa (inclui local); `detalheCiotHtml` com `mensagem_antt`, `contratante_nome`, `id_operacao`, placa contendo `<img src=x onerror=alert(1)>` não contém `<img`; `rotuloStatusCiot` para os 7 status. Backend já cobre os códigos (219/297/222/251).

## T8 [impl] — Frontend: lista e MDF-e

Depois de T7 (`app.js`). Arquivos: `frontend/src/app.js`, `frontend/index.html`.
- Lista CIOT: selo `HML` quando `ambiente === "homologacao"`; status por `rotuloStatusCiot` ("Pendente (sem CIOT)", "Não registrado", "Não enviado"); `badgeStatus` com `pendente` explícito amber.
- Placa na lista: `veiculos.map(placa).join(", ")` quando houver.
- `openMdfeForm`: opção do CIOT mostra selo ANTT/SIMULADO; pré-preenche placa ao escolher CIOT ANTT (1ª placa declarada).
Pronto: checklist manual; `frontend-ciot.test.js` verde.

## T9 [dev] — Frontend + teste: verificar transportador/frota antes de declarar

Depois de T8. Arquivos: `frontend/src/app.js`, `backend/tests/antt-mtls.test.js`.
- Modo ANTT: botão "Verificar RNTRC/frota" na barra do CIOT → modal (RNTRC, placas) → `GET /ciot/transportador?doc=<empresa>&rntrc=` e `POST /ciot/frota`; resposta em `<pre>` com `esc(JSON.stringify(r, null, 2))`.
- Testes mock: `situacaoTransportador` e `frota` (hoje sem teste) — 200 ok repassa JSON; 207 → 400 com código; modo local → 400.

## T10 [dev] ∥ — Roteiro executável da 1ª homologação

Arquivos: novo `backend/scripts/ciot-homologacao.js`, novo `docs/ciot-homologacao.exemplo.json` (dados fictícios dos testes), `.gitignore` (garantir `backend/data/`).
- `node scripts/ciot-homologacao.js validar <arquivo.json>`: sem rede — normaliza como o controller, roda `P.montarDeclaracao` (e certificado se configurado) e imprime payload sem senha.
- `... executar <arquivo.json>`: recusa se `ANTT_AMBIENTE !== "homologacao"` ou `CIOT_PROVIDER !== "antt"`; usa o controller (como os testes): declarar → consulta → encerrar; `--cancelar <id_operacao2>` faz outra declaração e cancela; imprime tabela de evidência (serviço, código, protocolo, mensagem, `resposta_antt`) já sanitizada para colar no CIOT-STATUS.
- Arquivo real fica em `backend/data/` (fora do git).
Testes: `antt-payload.test.js` chama `validar` com o exemplo (sem rede) e espera sucesso; dado inválido (B111) → código de saída ≠ 0. `executar` testado contra o mock em `antt-mtls` (opcional).

## T11 [impl] — Docs

Depois de tudo. Copiar este plano para `docs/CIOT-PLANO.md`. `docs/CIOT-STATUS.md`: pend. 5 (parcial, Q1/Q2), 6 (feito), 3 (evidência gravada), nova rota `config`, roteiro T10, contagens de teste. `CLAUDE.md`: contagens e `test:frontend`. Sem CNPJ real.

---

## Paralelismo / ordem

- ∥ desde o início: **T1**, **T4**, **T5**, **T10**.
- `ciotController.js` em série: T1 → T2 → T3.
- `app.js` em série: T5 → T6 → T7 → T8 → T9.
- T11 por último.

## Fora de escopo (Pendência 7)

- **RetificacaoOperacaoTransporte**: campos/regras do DCS não estão transcritos no repo; exige ler o DCS v1.1 primeiro.
- **ConsultarExcecao**: homologação respondeu 404 (serviço não publicado).
- **Contingência completa** (DataDeclaracao original, 168 h): regra não detalhada no repo. Já existe `IndContingencia` + justificativa (backend e T6); nada além.
- Adaptador .NET do gerador oficial do ID (pend. 1b): precisa aprovação para executar binário.
- Qualquer coisa que dependa de RNTRC/placa/ID oficial reais.

## Riscos

- Idempotency-Key reaproveitada após rejeição devolve linha antiga (tratado na T6).
- Mudar `apiFetch` afeta todas as páginas: manter `.message` igual.
- Frontend nunca rodou no navegador: T6–T9 exigem checklist manual (local + ANTT contra mock).
- Rodar `test:all` repetidamente esgota limitador de login (12/15 min).
- T4 muda XML/payload do MDF-e real sem MOC conferido (Q2).

## Questões abertas

- **Q1** MDF-e `infCIOT/CIOT`: layout citado no repo é `[0-9]{12}`, mas o ID da ANTT é `[0-9A-Z]{12}` (testes usam `ADM000000001`) e o CIOT completo tem 16. Conferir MOC/NT vigente do MDF-e; se letras forem barradas, MDF-e real com CIOT alfanumérico será rejeitado. Sem código até haver fonte.
- **Q2** Confirmar no MOC que `infCIOT/CPF|CNPJ` = responsável pela geração (ETC) — T4 assume isso.
- **Q3** Tabela de `CodigoTipoCarga` (1–12) e natureza da carga não estão no repo: UI mostra só números até transcrever do DCS.
- **Q4** Mostrar ou esconder `sequencial_experimental` na UI (proposta: só aviso, sem campo).
- **Q5** Prazo de cancelamento (DCS B35 × Portaria art. 18): continua decidido pela ANTT.
