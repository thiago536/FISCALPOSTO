PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS empresas (
  id TEXT PRIMARY KEY,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  ie TEXT,
  uf TEXT NOT NULL,
  cuf TEXT NOT NULL,
  municipio TEXT,
  cmun TEXT,
  cep TEXT,
  logradouro TEXT,
  numero TEXT,
  bairro TEXT,
  crt INTEGER NOT NULL DEFAULT 3,
  fone TEXT,
  email TEXT,
  ambiente INTEGER NOT NULL DEFAULT 2,
  serie_nfe INTEGER NOT NULL DEFAULT 1,
  serie_cte INTEGER NOT NULL DEFAULT 1,
  serie_mdfe INTEGER NOT NULL DEFAULT 1,
  prox_nfe INTEGER NOT NULL DEFAULT 1,
  prox_cte INTEGER NOT NULL DEFAULT 1,
  prox_mdfe INTEGER NOT NULL DEFAULT 1,
  certificado_nome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL DEFAULT 'operador',
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL DEFAULT 'J',
  nome TEXT NOT NULL,
  cpf_cnpj TEXT NOT NULL,
  ie TEXT,
  uf TEXT,
  municipio TEXT,
  cmun TEXT,
  cep TEXT,
  logradouro TEXT,
  numero TEXT,
  bairro TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  ncm TEXT,
  cfop TEXT,
  unidade TEXT NOT NULL DEFAULT 'LT',
  preco REAL NOT NULL DEFAULT 0,
  anp TEXT,
  desc_anp TEXT,
  cst_icms TEXT DEFAULT '00',
  aliq_icms REAL DEFAULT 18,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nfe (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  numero INTEGER NOT NULL,
  serie INTEGER NOT NULL,
  modelo TEXT NOT NULL DEFAULT '55',
  chave TEXT,
  protocolo TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho',
  motivo TEXT,
  ambiente INTEGER NOT NULL,
  natureza TEXT,
  cliente_id TEXT,
  dest_nome TEXT,
  dest_doc TEXT,
  dest_uf TEXT,
  dest_municipio TEXT,
  dest_ie TEXT,
  dest_endereco TEXT,
  total_produtos REAL NOT NULL DEFAULT 0,
  total_nota REAL NOT NULL DEFAULT 0,
  xml TEXT,
  emitido_em TEXT,
  autorizado_em TEXT,
  cancelado_em TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nfe_itens (
  id TEXT PRIMARY KEY,
  nfe_id TEXT NOT NULL REFERENCES nfe(id) ON DELETE CASCADE,
  item INTEGER NOT NULL,
  codigo TEXT,
  descricao TEXT NOT NULL,
  ncm TEXT,
  cfop TEXT,
  unidade TEXT,
  quantidade REAL NOT NULL,
  valor_unitario REAL NOT NULL,
  valor_total REAL NOT NULL,
  anp TEXT,
  uf_consumo TEXT,
  icms_cst TEXT,
  icms_base REAL,
  icms_aliq REAL,
  icms_valor REAL
);

CREATE TABLE IF NOT EXISTS cte (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  numero INTEGER NOT NULL,
  serie INTEGER NOT NULL,
  chave TEXT,
  protocolo TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho',
  motivo TEXT,
  ambiente INTEGER NOT NULL,
  cfop TEXT,
  natureza TEXT,
  rem_nome TEXT,
  rem_doc TEXT,
  rem_uf TEXT,
  rem_municipio TEXT,
  dest_nome TEXT,
  dest_doc TEXT,
  dest_uf TEXT,
  dest_municipio TEXT,
  carga TEXT,
  valor_servico REAL NOT NULL DEFAULT 0,
  icms_base REAL,
  icms_aliq REAL,
  icms_valor REAL,
  xml TEXT,
  emitido_em TEXT,
  autorizado_em TEXT,
  cancelado_em TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mdfe (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  numero INTEGER NOT NULL,
  serie INTEGER NOT NULL,
  chave TEXT,
  protocolo TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho',
  motivo TEXT,
  ambiente INTEGER NOT NULL,
  uf_ini TEXT,
  uf_fim TEXT,
  placa TEXT,
  rntrc TEXT,
  uf_veiculo TEXT,
  valor_carga REAL NOT NULL DEFAULT 0,
  ciot_id TEXT,
  xml TEXT,
  emitido_em TEXT,
  autorizado_em TEXT,
  encerrado_em TEXT,
  cancelado_em TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mdfe_condutores (
  id TEXT PRIMARY KEY,
  mdfe_id TEXT NOT NULL REFERENCES mdfe(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cpf TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mdfe_percurso (
  id TEXT PRIMARY KEY,
  mdfe_id TEXT NOT NULL REFERENCES mdfe(id) ON DELETE CASCADE,
  uf TEXT NOT NULL,
  ordem INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mdfe_docs (
  id TEXT PRIMARY KEY,
  mdfe_id TEXT NOT NULL REFERENCES mdfe(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  chave TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ciot (
  id TEXT PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  numero TEXT NOT NULL,
  administradora TEXT,
  status TEXT NOT NULL DEFAULT 'emitido',
  contratante_nome TEXT,
  contratante_doc TEXT,
  motorista_nome TEXT,
  motorista_cpf TEXT,
  placa TEXT,
  valor_contrato REAL NOT NULL DEFAULT 0,
  valor_adiantamento REAL NOT NULL DEFAULT 0,
  forma_pagto TEXT,
  chave_pix TEXT,
  banco TEXT,
  agencia TEXT,
  conta TEXT,
  mdfe_id TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelado_em TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  empresa_id TEXT,
  usuario_id TEXT,
  acao TEXT NOT NULL,
  entidade TEXT,
  entidade_id TEXT,
  detalhe TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nfe_emp ON nfe(empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cte_emp ON cte(empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mdfe_emp ON mdfe(empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ciot_emp ON ciot(empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cli_emp ON clientes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_prod_emp ON produtos(empresa_id);
