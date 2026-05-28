require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');

const { get, run, init } = require('./db/database');
const apiRouter = require('./routes/api');
const { enviarAlertaDiario } = require('./services/email');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'contafacil-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function autenticar(req, res, next) {
  if (req.session?.usuario) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ erro: 'Não autorizado' });
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session?.usuario) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await get('SELECT * FROM usuarios WHERE email=?', [email]);
    if (!usuario || !bcrypt.compareSync(senha, usuario.senha))
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    req.session.usuario = { id: usuario.id, nome: usuario.nome, email: usuario.email };
    res.json({ ok: true, nome: usuario.nome });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  res.json(req.session.usuario);
});

app.use('/api', autenticar, apiRouter);
app.get('/', autenticar, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('0 7 * * *', async () => {
  const cfg = await get('SELECT * FROM config_email WHERE id=1');
  if (cfg?.ativo) await enviarAlertaDiario();
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 0 * * *', async () => {
  const hoje = new Date().toISOString().split('T')[0];
  await run(`UPDATE tarefas SET status='Em atraso',atualizado_em=CURRENT_TIMESTAMP WHERE vencimento<? AND status IN ('Pendente','Em andamento')`, [hoje]);
}, { timezone: 'America/Sao_Paulo' });

init().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ContaFácil — Sistema de Obrigações     ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Acesse:  http://localhost:${PORT}            ║`);
    console.log(`║  Login:   admin@contafacil.com           ║`);
    console.log(`║  Senha:   admin123                       ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });
}).catch(err => { console.error('Erro ao iniciar:', err); process.exit(1); });
