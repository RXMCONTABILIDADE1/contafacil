require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');

const { get, run, init } = require('./db/database');
const apiRouter = require('./routes/api');
const { enviarAlertaDiario } = require('./services/email');
const { gerarNotificacoesOpcoes } = require('./services/opcoes');
const { gerarNotificacoesRetificacao } = require('./services/retificacoes');

// Monitor Fiscal (arquivo novo). Se por algum motivo faltar, o resto do sistema segue funcionando.
let monitorRouter = null;
try { monitorRouter = require('./routes/monitor'); } catch (e) { console.error('Monitor Fiscal indisponível:', e.message); }

// ---- SESSÕES NO BANCO (início) ----
// Antes as sessões ficavam na memória do servidor: a cada reinício (deploy ou "soneca" do servidor)
// todo mundo era deslogado. Agora ficam na tabela `sessoes` e a validade renova a cada uso.
const SESSAO_DIAS = 7;
class PgSessionStore extends session.Store {
  constructor() {
    super();
    this.pronto = null;
    const t = setInterval(() => this.limpar().catch(() => {}), 60 * 60 * 1000);
    if (t.unref) t.unref();
  }
  ensure() {
    if (!this.pronto) {
      this.pronto = run(`CREATE TABLE IF NOT EXISTS sessoes (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expira TIMESTAMPTZ NOT NULL)`)
        .catch(e => { this.pronto = null; throw e; });
    }
    return this.pronto;
  }
  expira(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    const d = e ? new Date(e) : null;
    return d && !isNaN(d) ? d : new Date(Date.now() + SESSAO_DIAS * 86400000);
  }
  get(sid, cb) {
    this.ensure().then(() => get('SELECT sess, expira FROM sessoes WHERE sid=?', [sid]))
      .then(r => cb(null, r && new Date(r.expira) > new Date() ? JSON.parse(r.sess) : null)).catch(cb);
  }
  set(sid, sess, cb) {
    this.ensure().then(() => run(`INSERT INTO sessoes (sid, sess, expira) VALUES (?,?,?)
        ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expira = EXCLUDED.expira`, [sid, JSON.stringify(sess), this.expira(sess)]))
      .then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  touch(sid, sess, cb) {
    this.ensure().then(() => run('UPDATE sessoes SET expira=? WHERE sid=?', [this.expira(sess), sid]))
      .then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  destroy(sid, cb) {
    this.ensure().then(() => run('DELETE FROM sessoes WHERE sid=?', [sid]))
      .then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  limpar() { return this.ensure().then(() => run('DELETE FROM sessoes WHERE expira < ?', [new Date()])); }
}
// ---- SESSÕES NO BANCO (fim) ----

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new PgSessionStore(),
  secret: process.env.SESSION_SECRET || 'contafacil-secret-2024',
  resave: false,
  saveUninitialized: false,
  rolling: true, // renova a validade a cada uso: só desloga depois de SESSAO_DIAS sem abrir o sistema
  cookie: { maxAge: SESSAO_DIAS * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
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

if (monitorRouter) app.use('/api/monitor-fiscal', autenticar, monitorRouter);
app.use('/api', autenticar, apiRouter);
app.get('/', autenticar, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('0 7 * * *', async () => {
  const cfg = await get('SELECT * FROM config_email WHERE id=1');
  if (cfg?.ativo) await enviarAlertaDiario();
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('5 7 * * *', async () => {
  try { await gerarNotificacoesOpcoes(); } catch (e) { console.error('Alertas opções:', e.message); }
  try { await gerarNotificacoesRetificacao(); } catch (e) { console.error('Alertas retificação:', e.message); }
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
