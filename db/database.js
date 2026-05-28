const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'contafacil.db');
const db = new sqlite3.Database(DB_PATH);

function run(sql, params) {
  params = params || [];
  return new Promise(function(resolve, reject) {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params) {
  params = params || [];
  return new Promise(function(resolve, reject) {
    db.get(sql, params, function(err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params) {
  params = params || [];
  return new Promise(function(resolve, reject) {
    db.all(sql, params, function(err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function init() {
  await run('PRAGMA foreign_keys = ON');
  await run('CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha TEXT NOT NULL, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)');
  await run('CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cnpj TEXT, regime TEXT NOT NULL, segmento TEXT, responsavel TEXT, email TEXT, ativo INTEGER DEFAULT 1, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)');
  await run('CREATE TABLE IF NOT EXISTS tarefas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cliente_id INTEGER, regime TEXT NOT NULL, vencimento DATE NOT NULL, status TEXT NOT NULL DEFAULT "Pendente", responsavel TEXT, observacoes TEXT, competencia TEXT, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP, atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP)');
  await run('CREATE TABLE IF NOT EXISTS notificacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, mensagem TEXT, tipo TEXT DEFAULT "alerta", lida INTEGER DEFAULT 0, tarefa_id INTEGER, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)');
  await run('CREATE TABLE IF NOT EXISTS config_email (id INTEGER PRIMARY KEY DEFAULT 1, email_escritorio TEXT, dias_antecedencia INTEGER DEFAULT 5, frequencia TEXT DEFAULT "Semanal", alerta_atraso INTEGER DEFAULT 1, copiar_cliente INTEGER DEFAULT 1, ativo INTEGER DEFAULT 1)');

  var cfg = await get('SELECT id FROM config_email WHERE id=1');
  if (!cfg) await run('INSERT INTO config_email (id) VALUES (1)');

  var admin = await get('SELECT id FROM usuarios WHERE email=?', ['admin@contafacil.com']);
  if (!admin) {
    var hash = bcrypt.hashSync('admin123', 10);
    await run('INSERT INTO usuarios (nome,email,senha) VALUES (?,?,?)', ['Administrador','admin@contafacil.com',hash]);
  }

  var total = await get('SELECT COUNT(*) as c FROM clientes');
  if (total.c === 0) {
    await run('INSERT INTO clientes (nome,cnpj,regime,segmento,responsavel,email) VALUES (?,?,?,?,?,?)', ['Mercearia Sao Joao','12.345.678/0001-90','Simples Nacional','Comercio','Ana Lima','joao@mercearia.com']);
    await run('INSERT INTO clientes (nome,cnpj,regime,segmento,responsavel,email) VALUES (?,?,?,?,?,?)', ['TechSoft Sistemas Ltda','23.456.789/0001-01','Lucro Presumido','Tecnologia','Carlos Melo','
