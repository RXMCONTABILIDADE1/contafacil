// server.js — Servidor principal ContaFácil
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');

const { db, init } = require('./db/database');
const apiRouter = require('./routes/api');
const { enviarAlertaDiario } = require('./services/email');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializa banco de dados
init();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'contafacil-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// Middleware de autenticação
function autenticar(req, res, next) {
  if (req.session?.usuario) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ erro: 'Não autorizado' });
  res.redirect('/login');
}

// ─── ROTAS DE AUTENTICAÇÃO ────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.usuario) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { email, senha } = req.body;
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
  }
  req.session.usuario = { id: usuario.id, nome: usuario.nome, email: usuario.email };
  res.json({ ok: true, nome: usuario.nome });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  res.json(req.session.usuario);
});

// ─── API ──────────────────────────────────────────────────────────────────
app.use('/api', autenticar, apiRouter);

// ─── FRONTEND (SPA) ───────────────────────────────────────────────────────
app.get('/', autenticar, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── CRON: ALERTAS AUTOMÁTICOS ───────────────────────────────────────────
// Executa todo dia às 7h da manhã
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Cron: verificando obrigações para alertas...');
  const cfg = db.prepare('SELECT * FROM config_email WHERE id=1').get();
  if (cfg?.ativo) await enviarAlertaDiario();
}, { timezone: 'America/Sao_Paulo' });

// Atualiza status de tarefas vencidas automaticamente (todo dia à meia-noite)
cron.schedule('0 0 * * *', () => {
  const hoje = new Date().toISOString().split('T')[0];
  const result = db.prepare(`
    UPDATE tarefas SET status='Em atraso', atualizado_em=CURRENT_TIMESTAMP
    WHERE vencimento < ? AND status IN ('Pendente','Em andamento')
  `).run(hoje);
  if (result.changes > 0) {
    console.log(`🔄 ${result.changes} tarefas marcadas como em atraso`);
    db.prepare('INSERT INTO notificacoes (titulo, tipo) VALUES (?, ?)').run(
      `${result.changes} tarefas foram marcadas como em atraso automaticamente`, 'atraso'
    );
  }
}, { timezone: 'America/Sao_Paulo' });

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ContaFácil — Sistema de Obrigações     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Rodando em: http://localhost:${PORT}         ║`);
  console.log(`║  Login:      admin@contafacil.com        ║`);
  console.log(`║  Senha:      admin123                    ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
