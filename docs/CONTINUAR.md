# Continuar de outro PC (estado em 21/10/2026)

Leia primeiro `docs/CIOT-STATUS.md` (fonte da verdade do CIOT) e `docs/CIOT-PLANO.md`.

## Estado

- Prioridade atual: **CIOT direto na ANTT** (Web Service PEF, mTLS com certificado A1, DCS PEF v1.1). Notas (NF-e/CT-e/MDF-e via Focus NFe) estão paradas: não há empresa/CNPJ próprio nem token Focus.
- Código do CIOT completo: backend (`backend/src/services/antt.js`, `anttPayload.js`, `ciotController.js`, rota `/api/ciot/config`), frontend (`frontend/src/ciot.js`, formulário ANTT), evidência da resposta da ANTT gravada, `infCIOT` com CNPJ da ETC.
- Comunicação mTLS com a homologação da ANTT já comprovada (respostas 297/207/220/205).
- `npm run test:all` verde em 21/10/2026 (e2e 43, segurança 12, Focus 17, emissor 9, antt, mTLS 50, frontend 20).
- **Nenhum CIOT 110 (emitido) real ainda.**

## O que falta (teste com dados da transportadora)

1. Certificado A1 (`.pfx`) da transportadora (ETC) + senha. Guardar FORA do repo; o `.gitignore` já bloqueia `*.pfx`, `*.p12`, `.env`.
2. RNTRC da ETC e placa(s) de veículo **automotor** vinculadas ao RNTRC.
3. ID de operação gerado pelo **gerador oficial da ANTT de homologação** (`GeradorCIOT.zip`, página "documentos técnicos" do PEF no gov.br) para o CNPJ do certificado. ID local é rejeitado ("O campo IdOperacaoTransporte é inválido").
4. Preencher `backend/.env` (ver `backend/.env.example`):
   ```
   CIOT_PROVIDER=antt
   ANTT_AMBIENTE=homologacao
   ANTT_ID_MODO=manual
   ANTT_PFX_PATH=<caminho absoluto do .pfx fora do repo>
   ANTT_PFX_SENHA=<senha>
   ```
5. Validar sem rede: copiar `docs/ciot-homologacao.exemplo.json` para fora do repo, preencher, rodar
   `node scripts/ciot-homologacao.js validar <arquivo.json>`.
6. Executar em homologação: `node scripts/ciot-homologacao.js executar <arquivo.json>` (ou pelo frontend). Esperado código **110**.
7. Depois: `GET /api/ciot/:id/consulta`, encerrar essa operação, emitir outra e cancelar.
8. Registrar resultado (protocolos, códigos) em `docs/CIOT-STATUS.md` — **sem CNPJ, RNTRC, placa ou nome reais** (repo é público).

## Setup no PC novo

```bash
git clone https://github.com/thiago536/FISCALPOSTO.git
cd FISCALPOSTO/backend
npm install
cp .env.example .env      # editar
npm run test:all          # precisa de openssl (Git for Windows serve)
node scripts/dev-antt-mock.js   # app em http://localhost:3002 contra mock ANTT
npm start                 # app real
```

## Cuidados (repo público)

- Nunca commitar `.env`, `.pfx`, `backend/data/`, logs, JSON de homologação preenchido.
- Não publicar dados reais da transportadora em docs/commits.
- Produção (`ANTT_AMBIENTE=producao`) só com operação legítima.
