# CIOT — estado da integração ANTT (15/10/2026)

Documento de passagem: outra sessão deve conseguir continuar só com ele + `CLAUDE.md`.

## Resumo honesto

| Estado | Situação | Evidência |
| --- | --- | --- |
| TESTADO LOCALMENTE | **Sim** | `npm run test:antt` (10 grupos de payload + fluxo do controller) |
| TESTADO COM MOCK | **Sim** | `npm run test:antt-mtls` — 50 cenários contra mock HTTPS com mTLS real |
| Comunicação com homologação ANTT | **Sim (parcial)** | mTLS aceito; respostas reais 297, 207, 220 e 205 (abaixo) |
| HOMOLOGADO NA ANTT | **Não** | nenhum CIOT gerado com sucesso (código 110) na homologação |
| PRODUÇÃO VALIDADA | **Não** | nada foi enviado à produção |

**Não está pronto para emitir CIOT real.** Bloqueadores na seção "Pendências".

## Fontes oficiais usadas

- DCS PEF v1.1 — https://www.gov.br/antt/pt-br/assuntos/cargas/ciot-para-todos-1/dcs_pef_v1-1.pdf
- Documentos técnicos (DLL/executável do gerador) — https://www.gov.br/antt/pt-br/assuntos/cargas/ciot-para-todos-1/documentos-tecnicos
- Portaria SUROC nº 6/2026 (redação da Portaria SUROC nº 16/2026) — anttlegis.antt.gov.br
- Resolução ANTT nº 6.078/2026 (CIOT para toda operação de transporte rodoviário remunerado; vigência 24/05/2026)
- Perguntas frequentes "CIOT para todos" — https://www.gov.br/antt/pt-br/assuntos/cargas/ciot-para-todos-1/perguntas-frequentes

## Arquitetura

```
POST /api/ciot ─► ciotController.emitir
                   ├─ CIOT_PROVIDER=local → número simulado (simulado:true, sem validade)
                   └─ CIOT_PROVIDER=antt
                        1. valida tudo sem rede (certificado, B115, payload DCS)
                        2. grava status "pendente" com id_operacao  ◄── antes de qualquer rede
                        3. antt.declarar (mTLS, PFX A1)
                        4. 110 + CIOT completo → "emitido" (oficial:true)
                           rejeição → "rejeitado" | acesso/TLS recusado → "nao_enviado"
                           timeout/5xx/não-JSON/219/sem DV → continua "pendente"
GET  /api/ciot/:id/consulta   ConsultarCIOTGerado: pendente → emitido | nao_registrado
POST /api/ciot/:id/cancelar   CancelamentoOperacaoTransporte (só "emitido")
POST /api/ciot/:id/encerrar   EncerramentoOperacaoTransporte (só "emitido")
GET  /api/ciot/config        provedor/ambiente ativo (usado pelo frontend)
GET  /api/ciot/transportador  ConsultarSituacaoTransportador
POST /api/ciot/frota          ConsultarFrotaTransportador
```

- `backend/src/services/antt.js` — cliente HTTPS/mTLS, trava de host, validação do certificado, classificação da resposta.
- `backend/src/services/anttPayload.js` — montagem dos JSON do DCS (funções puras) e regras locais B*.
- `backend/src/controllers/ciotController.js` — máquina de estados, persistência, trilha fiscal, travas.

### Estados

| Status | Significado | `id_operacao` reutilizável? |
| --- | --- | --- |
| `pendente` | enviado, sem confirmação; **nunca é CIOT** | não (só a consulta resolve) |
| `emitido` | ANTT confirmou; `numero` = 12 + DV (16) | — |
| `rejeitado` | ANTT respondeu com rejeição | sim |
| `nao_enviado` | certificado/TLS/acesso (401/403) recusado; nada processado | sim |
| `nao_registrado` | consulta (297/220) confirmou que o ID não existe na ANTT, após a margem | sim — **reenviar com o mesmo ID** |
| `cancelado` / `encerrado` | confirmados pela ANTT (110, ou 222/251 "já está ...") | — |

`oficial: true` somente para `provider=antt` + `status=emitido`. Pendente mostra `id_operacao` (não é CIOT).

## Regras confirmadas (fonte) e o que o código faz

| Regra | Fonte | Implementação |
| --- | --- | --- |
| Hosts `appservices[-hml].antt.gov.br/pefServices`, serviços em `/api/<Serviço>` | DCS pág. 66 e exemplo `api/ConsultarExcecao`; **confirmado na homologação** | `BASES` em `antt.js`; host pinado |
| mTLS TLS 1.2, certificado ICP-Brasil A1/A3 com EKU "Autenticação Cliente" | DCS "Padrão de Segurança" | `minVersion TLSv1.2`; EKU sem clientAuth → erro; emissor sem `O=ICP-Brasil` bloqueado nos hosts oficiais |
| Servidor ANTT usa GlobalSign | sonda TLS 15/10/2026 | nenhuma `ANTT_CA_PATH` necessária |
| Sucesso só 110/111 | DCS "Final do processamento" | `classificar()` |
| IdOperacaoTransporte gerado pela DLL/executável oficial | DCS regra B4; **homologação rejeitou ID local com 205 "O campo IdOperacaoTransporte é inválido."** | modo padrão `ANTT_ID_MODO=manual`; `sequencial_experimental` só para testes |
| Sem IP, ETC declara em nome próprio (contratado = CNPJ do certificado) | DCS B115; Portaria SUROC 6/2026 art. 3º II; FAQ 6.17/7.3 | 400 local antes de reservar ID |
| TAC/equiparado e TAC-Agregado exigem Instituição de Pagamento | Portaria art. 3º I; DCS B27/B115 | tipo 3 recusado sem IP |
| Cartão pré-pago (TipoPagamento 1) só para IP | DCS B118 | recusado |
| Origem/destino: só a localização mais específica, mesmo tipo nos dois | DCS (OrigemDestino) e B109/B110/B111 | `ponto()` |
| Até 5 veículos | B49 | recusado |
| Início ≥ hoje e ≤ hoje+30 (fora de contingência); fim ≥ início; ≤ 90 dias (≤ 30 TAC-Agregado) | B6/B13/B21/B22/B30 | recusado |
| TAC-Agregado não informa DataInicioViagem | B56 | omitido / recusado |
| ContratantesCargFrac ≠ contratante | B119 | recusado |
| Encerramento: PesoCarga obrigatório na lotação, proibido na fracionada e no TAC-Agregado; OrigemDestino só no TAC-Agregado | B65/B57/B62/B43/B44 | `montarEncerramento()` |
| 219 "ID já cadastrado" não é rejeição definitiva | DCS B17 | fica `pendente` com `id_ja_cadastrado`; a consulta só promove com `?confirmar=1` (o ID pode ser de operação alheia) |
| HTTP sem código de regra: 404 = rota errada (`nao_enviado`); 401/403 = acesso recusado (`nao_enviado`); 408/409/425/429/5xx/não-JSON = indeterminado (`pendente`); demais 4xx = rejeição | revisão de código | `classificar()` |
| Consulta sem operação: 297 | **homologação** ("O CIOT informado não existe na base de dados da ANTT") | `COD_NAO_ENCONTRADO` = 297 e 220 (B34) |
| 222 já cancelada / 251 já encerrada | DCS | estado refletido |
| `Mensagem` pode vir como string com array JSON | **homologação** | `antt.textoMensagem()` |
| CodigoVerificador (4) | DCS saída da declaração | aceito só como string de 4 chars; outro formato → `ConsultarCIOTGerado` (sem completar zeros) |
| Piso mínimo de frete | Portaria arts. 15–16; DCS B80 (código 291) | **validado pela ANTT**, não localmente (rejeição 291 é refletida) |

**Não inventado / não implementado:** cálculo local do piso (tabelas da Res. 5.867/2020), regra de tipo de veículo automotor × implemento (B83/B84/B101 dependem do cadastro RNTRC), prazo de cancelamento (DCS B35 e Portaria art. 18 divergem; a ANTT decide).

## Concorrência, recuperação e persistência

- Gravação `pendente` é síncrona antes do `await` da rede: duas requisições com o mesmo ID → só uma chega à ANTT (teste).
- Sequencial experimental: reserva síncrona, IDs distintos sob concorrência (teste).
- `Idempotency-Key` no `POST /api/ciot`: repetição devolve a mesma operação, sem nova declaração.
- Declaração, cancelar, encerrar e consultar: trava em memória por CIOT (a declaração segura a trava até a resposta; updates só se o registro ainda estiver `pendente`) (processo único garantido pelo `.lock` do banco) → segunda chamada simultânea recebe 409.
- Reinício com pendente: banco em disco preserva `id_operacao`; outro processo recupera pela consulta (teste com processos separados).
- `pendente` só vira `nao_registrado` depois de `max(60 s, 2 × ANTT_TIMEOUT_MS)` desde a declaração.
- Trilha fiscal (`audit_logs`, tipo fiscal) em toda transição, com correlação; nunca contém senha.
- Isolamento: toda busca filtra `empresa_id`; MDF-e só vincula CIOT da mesma empresa, `emitido`, oficial em manifesto real e simulado em manifesto simulado.

## Homologação real executada (15/10/2026)

Certificado: e-CNPJ A1 fornecido pelo usuário (CNPJ omitido neste documento público), emissor ICP-Brasil, válido até 13/07/2027. Ambiente: **homologação** (sem validade jurídica, DCS pág. 65). Nada foi enviado à produção.

| # | Serviço | Requisição (sanitizada) | Resposta da ANTT |
| --- | --- | --- | --- |
| 1 | TLS sem certificado | — | ambos os hosts: TLS 1.2, cadeia GlobalSign confiável |
| 2 | ConsultarExcecao (GET) | `?CPFCNPJTransportador=<CNPJ>` | HTTP 404 "No type was found that matches the controller named 'ConsultarExcecao'" — serviço não publicado na homologação |
| 3 | ConsultarCIOTGerado | `{CodigoIdentificacaoOperacao:"000000000001", AnoDeclaracao:2026}` | HTTP 200, **297** "O CIOT informado não existe na base de dados da ANTT." (mTLS aceito) |
| 4 | ConsultarSituacaoTransportador | interessado = transportador = CNPJ do certificado, RNTRC `000000001` | HTTP 200, **207** "Não foi encontrado nenhum transportador com CPF/CNPJ … e RNTRC 000000001." |
| 5 | CancelamentoOperacaoTransporte | CIOT inexistente `0000000000010001` | HTTP 200, **220** + mensagem B113 |
| 6 | EncerramentoOperacaoTransporte | CIOT inexistente, PesoTotalCarga 1000 | HTTP 200, **220**, Protocolo `N98000000003026` |
| 7 | DeclaracaoOperacaoTransporte (pelo controller) | ID local `000000000001`, contratado = CNPJ do certificado, RNTRC fictício, placa de teste | HTTP 200, **205**, Protocolo `E98000000136968`: "É necessário informar ao menos um veículo do tipo automotor." / "Não foi encontrado transportador contratado com CPF/CNPJ … e RNTRC 000000001." / "O campo IdOperacaoTransporte é inválido." → gravado `rejeitado`, `oficial:false` |

Conclusões: endpoint, caminho, mTLS, certificado e formato JSON estão corretos; a ANTT processa as requisições. Para chegar ao 110 faltam: ID do gerador oficial, RNTRC real do contratado e placa automotora vinculada a ele.

### Gerador oficial do ID (inspecionado, não executado)

`GeradorCIOT.zip` (homologação, 172 MB) é aplicativo gráfico (Avalonia/SkiaSharp) para win-x64, win-x86 e linux-x64 — não automatizável por linha de comando; não foi executado. `GeradorCIOT_DLL.zip` (homologação) contém `GeradorCIOTShared.dll` (.NET Standard 2.0). Por inspeção de strings: base `https://appservices-hml.antt.gov.br/pefServices`, `POST /token` com CNPJ e uma chave embutida na DLL → token Bearer → `POST /gerar` com `cpfCnpj` → `dados.ciot`; também `ValidarCIOT`. A DLL substitui a validação do certificado do servidor (`ServerCertificateCustomValidationCallback`). **Decisão:** não extrair nem copiar a chave embutida para este repositório público; não usar geradores de terceiros (ex.: AWS do projeto Delphi).

## Revisão de código

Revisor (opus, read-only) achou 5 pontos; 4 corrigidos com teste: 408/429/404 não viram rejeição; após 219 a consulta exige confirmação; MDF-e só aceita placa declarada no CIOT ANTT; declaração e consulta simultâneas não competem pelo status. O 5º (formulário sem campos ANTT) segue em Pendências.

## Pendências e bloqueadores (ordem)

1. **ID oficial**: escolher como obter o `IdOperacaoTransporte` — (a) operador gera no executável oficial da ANTT e informa `id_operacao` (funciona hoje, modo `manual`); ou (b) adaptador que executa a DLL/executável oficial num processo .NET isolado (precisa de aprovação para executar binário baixado e de runtime .NET). Nunca embutir a chave da DLL no código.
2. **RNTRC e frota reais** da ETC contratada (o CNPJ do certificado não foi encontrado no RNTRC com RNTRC fictício — confirmar se a empresa do certificado é ETC ativa). Sem isso a ANTT rejeita (207/B3/C1).
3. Primeira declaração 110 em homologação REAL → o formato esperado da resposta de sucesso agora está **guardado como evidência** em `resposta_antt` e `resposta_consulta` de cada CIOT (e na trilha); falta só obter o primeiro 110 real e comparar nome do campo do ID e tipo do `CodigoVerificador`.
4. Testar em homologação: consulta do CIOT gerado, cancelamento, encerramento, recuperação após falha simulada.
5. (**parcial**) MDF-e: Q1/Q2 respondidas e implementadas (ver `docs/CIOT-PLANO.md`); resta validar com o MOC do MDF-e antes de produção. Original: `xml.js`/`focusPayload.js` enviam os 12 primeiros caracteres do CIOT e, no XML local, o CPF do motorista em `infCIOT`; para operação ETC o responsável é o CNPJ da ETC — validar com o MOC do MDF-e antes de produção (fora do escopo desta sessão).
6. **Feita**: formulário do frontend tem os campos ANTT (id_operacao, RNTRC, veículos, origem/destino, carga, datas, contingência), detalhe com ações consultar/encerrar/cancelar/reenviar e botão Verificar RNTRC/frota.
7. Não implementados: RetificacaoOperacaoTransporte (fracionada), ConsultarExcecao, fluxo completo de contingência (DataDeclaracao original, 168 h).
8. Produção: só com operação legítima, `NODE_ENV=production`, `ALLOW_PRODUCAO=sim`, `ANTT_AMBIENTE=producao`.

## Próximo passo exato

Obter com o responsável da empresa: RNTRC da ETC do certificado e placa(s) automotora(s) vinculadas. Gerar um ID no executável oficial de **homologação** (`GeradorCIOT.zip` da página de documentos técnicos) para o CNPJ do certificado. Rodar uma declaração em homologação (`CIOT_PROVIDER=antt`, `ANTT_AMBIENTE=homologacao`, `ANTT_ID_MODO=manual`, `id_operacao=<ID gerado>`), depois `GET /api/ciot/:id/consulta`, encerrar e cancelar outra.

## Comandos de teste

```bash
cd backend
npm run test:antt        # payload + regras + fluxo do controller (sem rede)
npm run test:antt-mtls   # 50 cenários com mock mTLS (precisa de openssl; Git for Windows serve)
npm run test:frontend    # 20 testes do frontend CIOT (ciot.js, detalhe, formulário)
npm run test:all         # regressão completa (e2e 43, segurança 12, Focus 17, emissor 9, antt 12 grupos, antt-mtls 50, frontend 20)
node scripts/ciot-homologacao.js   # roteiro de homologação real (ver docs/ciot-homologacao.exemplo.json)
node scripts/dev-antt-mock.js      # app em http://localhost:3002 contra mock ANTT local (banco temporário)
```

Mock (`dev-antt-mock.js`): prefixos de `id_operacao` forçam códigos — `E205...` rejeição, `E219...` ID já cadastrado, `E297...` CIOT inexistente. Consulta devolve o mesmo verificador da declaração (`MOCK_DV_CONSULTA` força divergência). A consulta com CIOT diferente do guardado devolve `divergencia: {local, antt}`, mantém o número local e grava na trilha/`resposta_consulta`; o frontend mostra aviso.

### Checklist no navegador (17/10/2026)

- Modo local: emitir e cancelar — OK.
- Mock ANTT: emissão pelo formulário (110) — OK; rejeição 205 exibida no modal, novo Idempotency-Key a cada reenvio — OK; 219 → pendente sem CIOT — OK; consulta — OK; encerrar com peso — OK; cancelar com motivo — OK; Verificar RNTRC/frota — OK.
- Fluxo de confirmação do 219 (`?confirmar=1`) coberto só pelos testes automatizados, pois o mock força 219 também na consulta.
- Achados corrigidos: selo ANTT some em encerrado/cancelado; textarea sem estilo; aviso de divergência na consulta.

Resultados em 17/10/2026: todos verdes (e2e 43/43, segurança 12, Focus 17/17, emissor 9/9, antt 12 grupos, mTLS 50, frontend 20).

## Arquivos alterados nesta sessão

- `backend/src/services/antt.js` — comentário de hosts com evidência; EKU clientAuth; bloqueio de não ICP-Brasil nos hosts oficiais; 401/403 sem código = acesso recusado (`configuracao`); `textoMensagem`; comentário B4 do ID.
- `backend/src/services/anttPayload.js` — B111/B109/B110, B115, B27, B56, B22/B21/B30, B49, B118, B119, encerramento B57/B62/B65/B44, `CodigoPagamento` sem perda de dígitos.
- `backend/src/controllers/mdfeController.js` — `placasDoCiot`: CIOT da ANTT usa só as placas declaradas (achado da revisão).
- `backend/src/controllers/ciotController.js` — contratado = empresa; DV estrito; 219 → pendente; 297/220 → `nao_registrado` com margem; 222/251 refletidos; travas; Idempotency-Key; veículos/datas persistidos.
- `frontend/src/app.js` — lista CIOT mostra SIMULADO/ANTT; selo ANTT por provider+status; aviso de divergência na consulta e "ID op. … (sem CIOT)" para pendente; toast avisa simulado; cores de status.
- `backend/tests/antt-payload.test.js`, `backend/tests/antt-mtls.test.js` — testes novos e dados de teste corrigidos para as regras do DCS (ex.: origem município × destino CEP violava B111).
- `docs/CIOT-STATUS.md`, `CLAUDE.md`.
