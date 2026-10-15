# PostoFiscal

Sistema web próprio para emissão e gestão de **NF-e**, **CT-e**, **MDF-e** e **CIOT**, pensado para postos de combustível e operações de transporte.

Não usa o banco nem o código do sistema gerencial descompilado. Tem cadastro próprio, autenticação com senha criptografada (bcrypt) e JWT.

## O que já emite

| Módulo | Função |
| --- | --- |
| NF-e | Venda de combustível (ANP, litros, CST 60/00), XML 4.00, cancelamento |
| CT-e | Serviço de transporte, ICMS, XML 4.00, cancelamento |
| MDF-e | Manifesto com condutor, percurso, documentos vinculados, encerramento |
| CIOT | Número da operação, pagamento (PIX/TED), vínculo no MDF-e (infANTT) |

Ambiente padrão: **local (simulado, sem valor fiscal)**. Gera chave, protocolo e XML para operar o fluxo sem certificado.

## Emissão real

| Documento | Como | Configuração (`backend/.env`) |
| --- | --- | --- |
| NF-e, CT-e, MDF-e | Focus NFe (assina com o A1 cadastrado no painel Focus e transmite à SEFAZ) | `FISCAL_PROVIDER=focus`, `FOCUS_TOKEN`, `FOCUS_AMBIENTE=homologacao|producao` |
| CIOT | Web Service PEF da ANTT, direto, mTLS com certificado A1 | `CIOT_PROVIDER=antt`, `ANTT_PFX_PATH`, `ANTT_PFX_SENHA`, `ANTT_AMBIENTE` |

Pré-requisitos: certificado A1 **válido** do próprio CNPJ emitente, empresa cadastrada na Focus, clientes com endereço e código IBGE do município, veículo na frota RNTRC (CIOT).

Na emissão real o documento fica **processando** até a SEFAZ responder; o servidor consulta a Focus a cada `FOCUS_POLL_MS` e baixa o XML autorizado. Número/série/chave vêm da Focus.

Pendências conhecidas: formato do `IdOperacaoTransporte` do CIOT (geramos sequencial de 12 dígitos por empresa/ano; confirmar na homologação ANTT). Nada foi testado ainda contra SEFAZ/ANTT reais.

Testes: `npm run test:all` (local, Focus simulada, emissor, ANTT).

## Como rodar

Requisitos: [Node.js 18+](https://nodejs.org/) instalado (o comando `node` precisa existir no PATH).

```bash
cd sistema-fiscal/backend
copy .env.example .env
npm install
npm start
```

Abra `http://localhost:3001`

- Usuário: `admin`
- Senha: `Admin@2026`

Troque a senha e o `JWT_SECRET` do `.env` antes de qualquer uso real.

## Segurança (base de produto)

- Senhas com bcrypt (12 rounds)
- JWT com expiração
- Helmet, CORS e limite de tentativas de login
- Dados isolados em `backend/data/fiscal.json` (não aponta para o sistema legado)
- Auditoria de emissão/cancelamento
- XML escapado contra injeção

## Aviso legal

O restante desta pasta de trabalho contém software de terceiros descompilado. **Não copie, não redistribua e não venda esse código.** Este produto em `sistema-fiscal/` foi escrito do zero, com layouts públicos da NF-e/CT-e/MDF-e e regras de negócio de posto/transporte.
