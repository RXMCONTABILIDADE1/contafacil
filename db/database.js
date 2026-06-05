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
      ativo INTEGER DEFAULT 1
    )
  `);

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
