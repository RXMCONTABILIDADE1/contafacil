const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function run(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(pgSql, params);
  return { lastID: result.rows[0]?.id, changes: result.rowCount, rows: result.rows };
}

async function get(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(pgSql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(pgSql, params);
  return result.rows;
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cnpj TEXT,
      regime TEXT NOT NULL,
      situacao TEXT DEFAULT 'Ativa',
      segmento TEXT,
      responsavel TEXT,
      email TEXT,
      honorario REAL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      uf TEXT
    )
  `);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarefas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cliente_id INTEGER,
      regime TEXT NOT NULL,
      vencimento DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pendente',
      responsavel TEXT,
      observacoes TEXT,
      competencia TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notificacoes (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      mensagem TEXT,
      tipo TEXT DEFAULT 'alerta',
      lida INTEGER DEFAULT 0,
      tarefa_id INTEGER,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_email (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email_escritorio TEXT,
      dias_antecedencia INTEGER DEFAULT 5,
      frequencia TEXT DEFAULT 'Semanal',
      alerta_atraso INTEGER DEFAULT 1,
      copiar_cliente INTEGER DEFAULT 1,
      ativo INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS financeiro (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL,
      mes_referencia TEXT NOT NULL,
      valor REAL NOT NULL,
      status TEXT DEFAULT 'Pendente',
      data_pagamento DATE,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descricao TEXT,
      data DATE NOT NULL,
      hora TEXT,
      tipo TEXT DEFAULT 'interno',
      cliente_id INTEGER,
      tarefa_id INTEGER,
      concluido INTEGER DEFAULT 0,
      prioridade TEXT DEFAULT 'normal',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS certificados_digitais (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL UNIQUE REFERENCES clientes(id) ON DELETE CASCADE,
      pfx_encrypted TEXT NOT NULL,
      senha_encrypted TEXT NOT NULL,
      ultimo_nsu TEXT DEFAULT '0',
      ultima_sincronizacao TIMESTAMP,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notas_fiscais (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      chave TEXT UNIQUE NOT NULL,
      nsu TEXT,
      tipo TEXT,
      cnpj_emitente TEXT,
      nome_emitente TEXT,
      valor NUMERIC,
      data_emissao TIMESTAMP,
      situacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // OPÇÕES ANUAIS (Simples Nacional + IBS/CBS)
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pre_cadastro INTEGER DEFAULT 0`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS opcoes_regime (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      ano INTEGER NOT NULL,
      simples_status TEXT NOT NULL DEFAULT 'nao_iniciada',
      pendencia TEXT,
      pendencia_orgao TEXT,
      ibs_cbs TEXT NOT NULL DEFAULT 'A definir',
      decisao TEXT NOT NULL DEFAULT 'A decidir',
      protocolo TEXT,
      incluido_em DATE NOT NULL DEFAULT CURRENT_DATE,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cliente_id, ano)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS opcoes_historico (
      id SERIAL PRIMARY KEY,
      opcao_id INTEGER NOT NULL REFERENCES opcoes_regime(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // NUMERAÇÃO DE CLIENTES (Nº fixo, em ordem de cadastro)
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS clientes_codigo_seq`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo INTEGER`);
  await pool.query(`SELECT setval('clientes_codigo_seq', (SELECT COALESCE(MAX(codigo),0) FROM clientes) + 1, false)`);
  const semCodigo = await pool.query(`SELECT id FROM clientes WHERE codigo IS NULL ORDER BY id`);
  for (const r of semCodigo.rows) await pool.query(`UPDATE clientes SET codigo = nextval('clientes_codigo_seq') WHERE id = $1`, [r.id]);
  await pool.query(`ALTER TABLE clientes ALTER COLUMN codigo SET DEFAULT nextval('clientes_codigo_seq')`);

  // COMPETÊNCIA RETROATIVA: a competência é o mês anterior ao vencimento (honorários continuam no mês atual).
  // Correção única das tarefas antigas que foram geradas com competência = mês do vencimento.
  await pool.query(`CREATE TABLE IF NOT EXISTS migracoes (nome TEXT PRIMARY KEY, feito_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  const jaMigrou = await pool.query(`SELECT 1 FROM migracoes WHERE nome='competencia_retroativa'`);
  if (!jaMigrou.rows.length) {
    const r = await pool.query(`UPDATE tarefas SET competencia = to_char(vencimento - INTERVAL '1 month', 'MM/YYYY')
                                WHERE vencimento IS NOT NULL AND competencia = to_char(vencimento, 'MM/YYYY')`);
    await pool.query(`INSERT INTO migracoes (nome) VALUES ('competencia_retroativa') ON CONFLICT DO NOTHING`);
    console.log(`Competência retroativa: ${r.rowCount} tarefa(s) ajustada(s)`);
  }

  // SENHA DO FINANCEIRO
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_financeiro (
      id INTEGER PRIMARY KEY DEFAULT 1,
      senha_hash TEXT,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const cfg = await get('SELECT id FROM config_email WHERE id=1');
  if (!cfg) await pool.query('INSERT INTO config_email (id) VALUES (1) ON CONFLICT DO NOTHING');

  const admin = await get('SELECT id FROM usuarios WHERE email=$1', ['admin@contafacil.com']);
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query('INSERT INTO usuarios (nome,email,senha) VALUES ($1,$2,$3)', ['Administrador', 'admin@contafacil.com', hash]);
  }

  console.log('Banco PostgreSQL inicializado');
}

module.exports = { pool, run, get, all, init };
