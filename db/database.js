// db/database.js — Configuração e inicialização do banco SQLite
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'contafacil.db');
const db = new Database(DB_PATH);

// Ativa foreign keys e WAL para melhor performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cnpj TEXT,
      regime TEXT NOT NULL CHECK(regime IN ('Simples Nacional','Lucro Presumido')),
      segmento TEXT,
      responsavel TEXT,
      email TEXT,
      ativo INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tarefas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
      regime TEXT NOT NULL,
      vencimento DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pendente'
        CHECK(status IN ('Pendente','Em andamento','Concluído','Em atraso')),
      responsavel TEXT,
      observacoes TEXT,
      competencia TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notificacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      mensagem TEXT,
      tipo TEXT DEFAULT 'alerta' CHECK(tipo IN ('alerta','atraso','ok','info')),
      lida INTEGER DEFAULT 0,
      tarefa_id INTEGER REFERENCES tarefas(id) ON DELETE SET NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS config_email (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email_escritorio TEXT,
      dias_antecedencia INTEGER DEFAULT 5,
      frequencia TEXT DEFAULT 'Semanal',
      alerta_atraso INTEGER DEFAULT 1,
      copiar_cliente INTEGER DEFAULT 1,
      ativo INTEGER DEFAULT 1
    );

    INSERT OR IGNORE INTO config_email (id) VALUES (1);
  `);

  // Cria usuário admin padrão se não existir
  const existeAdmin = db.prepare('SELECT id FROM usuarios WHERE email = ?').get('admin@contafacil.com');
  if (!existeAdmin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)').run('Administrador', 'admin@contafacil.com', hash);
  }

  // Dados de demonstração
  const temClientes = db.prepare('SELECT COUNT(*) as c FROM clientes').get().c;
  if (temClientes === 0) {
    const insertCliente = db.prepare('INSERT INTO clientes (nome, cnpj, regime, segmento, responsavel, email) VALUES (?, ?, ?, ?, ?, ?)');
    const clientes = [
      ['Mercearia São João', '12.345.678/0001-90', 'Simples Nacional', 'Comércio', 'Ana Lima', 'joao@mercearia.com'],
      ['TechSoft Sistemas Ltda', '23.456.789/0001-01', 'Lucro Presumido', 'Tecnologia', 'Carlos Melo', 'ti@techsoft.com'],
      ['Pizzaria Bella Napoli', '34.567.890/0001-12', 'Simples Nacional', 'Alimentação', 'Ana Lima', 'bella@napoli.com'],
      ['Consultoria Vision S.A.', '45.678.901/0001-23', 'Lucro Presumido', 'Serviços', 'Rafael Souza', 'contato@vision.com'],
      ['Auto Peças Central', '56.789.012/0001-34', 'Simples Nacional', 'Comércio', 'Carlos Melo', 'central@autopecas.com'],
    ];
    clientes.forEach(c => insertCliente.run(...c));

    const hoje = new Date();
    const mes = hoje.getMonth();
    const ano = hoje.getFullYear();
    const dt = (d, m = mes, a = ano) => {
      const data = new Date(a, m, d);
      return data.toISOString().split('T')[0];
    };

    const insertTarefa = db.prepare('INSERT INTO tarefas (nome, cliente_id, regime, vencimento, status, responsavel, competencia) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const comp = `${String(mes + 1).padStart(2, '0')}/${ano}`;
    const tarefas = [
      ['DAS — Guia Simples Nacional', 1, 'Simples Nacional', dt(20), 'Pendente', 'Ana Lima', comp],
      ['DAS — Guia Simples Nacional', 3, 'Simples Nacional', dt(20), 'Concluído', 'Ana Lima', comp],
      ['DCTFWeb', 2, 'Lucro Presumido', dt(15), 'Em atraso', 'Carlos Melo', comp],
      ['EFD-REINF', 4, 'Lucro Presumido', dt(15), 'Em andamento', 'Rafael Souza', comp],
      ['e-Social', 5, 'Simples Nacional', dt(7), 'Concluído', 'Carlos Melo', comp],
      ['PGDAS-D', 1, 'Simples Nacional', dt(20), 'Pendente', 'Ana Lima', comp],
      ['SPED Contribuições', 2, 'Lucro Presumido', dt(10, mes + 1), 'Pendente', 'Carlos Melo', comp],
      ['Folha de Pagamento', 3, 'Simples Nacional', dt(5), 'Concluído', 'Ana Lima', comp],
      ['DCTF Mensal', 2, 'Lucro Presumido', dt(15), 'Em atraso', 'Carlos Melo', comp],
    ];
    tarefas.forEach(t => insertTarefa.run(...t));
  }

  console.log('✅ Banco de dados inicializado:', DB_PATH);
}

module.exports = { db, init };
