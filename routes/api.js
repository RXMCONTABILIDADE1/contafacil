// routes/api.js — Todas as rotas da API REST
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { enviarTesteEmail } = require('../services/email');

// ─── TAREFAS ───────────────────────────────────────────────────────────────

router.get('/tarefas', (req, res) => {
  const { regime, status, cliente_id } = req.query;
  let sql = `
    SELECT t.*, c.nome as cliente_nome, c.regime as cliente_regime
    FROM tarefas t
    LEFT JOIN clientes c ON t.cliente_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (regime && regime !== 'todos') { sql += ' AND t.regime = ?'; params.push(regime); }
  if (status && status !== 'todos') { sql += ' AND t.status = ?'; params.push(status); }
  if (cliente_id) { sql += ' AND t.cliente_id = ?'; params.push(cliente_id); }
  sql += ' ORDER BY t.vencimento ASC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/tarefas/urgentes', (req, res) => {
  const hoje = new Date();
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + 7);
  const tarefas = db.prepare(`
    SELECT t.*, c.nome as cliente_nome
    FROM tarefas t
    LEFT JOIN clientes c ON t.cliente_id = c.id
    WHERE t.status != 'Concluído'
      AND (t.vencimento <= ? OR t.status = 'Em atraso')
    ORDER BY t.vencimento ASC
    LIMIT 20
  `).all(limite.toISOString().split('T')[0]);
  res.json(tarefas);
});

router.post('/tarefas', (req, res) => {
  const { nome, cliente_id, regime, vencimento, status, responsavel, observacoes, competencia } = req.body;
  if (!nome || !cliente_id || !vencimento) return res.status(400).json({ erro: 'Campos obrigatórios: nome, cliente_id, vencimento' });

  const hoje = new Date().toISOString().split('T')[0];
  const statusFinal = status || (vencimento < hoje ? 'Em atraso' : 'Pendente');

  const result = db.prepare(`
    INSERT INTO tarefas (nome, cliente_id, regime, vencimento, status, responsavel, observacoes, competencia)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nome, cliente_id, regime || 'Simples Nacional', vencimento, statusFinal, responsavel || '', observacoes || '', competencia || '');

  // Cria notificação automática
  const diasAteVencer = Math.ceil((new Date(vencimento) - new Date()) / 86400000);
  if (diasAteVencer <= 7 && statusFinal !== 'Concluído') {
    const cliente = db.prepare('SELECT nome FROM clientes WHERE id = ?').get(cliente_id);
    db.prepare('INSERT INTO notificacoes (titulo, mensagem, tipo, tarefa_id) VALUES (?, ?, ?, ?)').run(
      `${nome} vence em ${diasAteVencer} dias — ${cliente?.nome}`,
      `${regime} · Vencimento: ${new Date(vencimento).toLocaleDateString('pt-BR')}`,
      statusFinal === 'Em atraso' ? 'atraso' : 'alerta',
      result.lastInsertRowid
    );
  }

  res.json({ id: result.lastInsertRowid, mensagem: 'Tarefa criada com sucesso' });
});

router.put('/tarefas/:id', (req, res) => {
  const { nome, cliente_id, regime, vencimento, status, responsavel, observacoes } = req.body;
  const { id } = req.params;
  db.prepare(`
    UPDATE tarefas SET nome=?, cliente_id=?, regime=?, vencimento=?, status=?,
    responsavel=?, observacoes=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?
  `).run(nome, cliente_id, regime, vencimento, status, responsavel, observacoes, id);
  res.json({ mensagem: 'Tarefa atualizada' });
});

router.patch('/tarefas/:id/status', (req, res) => {
  const { status } = req.body;
  const validos = ['Pendente', 'Em andamento', 'Concluído', 'Em atraso'];
  if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
  db.prepare('UPDATE tarefas SET status=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').run(status, req.params.id);
  if (status === 'Concluído') {
    const t = db.prepare('SELECT t.nome, c.nome as cn FROM tarefas t JOIN clientes c ON t.cliente_id=c.id WHERE t.id=?').get(req.params.id);
    if (t) db.prepare('INSERT INTO notificacoes (titulo, tipo, tarefa_id) VALUES (?, ?, ?)').run(`${t.nome} concluído — ${t.cn}`, 'ok', req.params.id);
  }
  res.json({ mensagem: 'Status atualizado' });
});

router.delete('/tarefas/:id', (req, res) => {
  db.prepare('DELETE FROM tarefas WHERE id=?').run(req.params.id);
  res.json({ mensagem: 'Tarefa removida' });
});

// ─── CLIENTES ─────────────────────────────────────────────────────────────

router.get('/clientes', (req, res) => {
  const clientes = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Em atraso') as qtd_atraso,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Pendente') as qtd_pendente,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Concluído') as qtd_concluido,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id) as qtd_total
    FROM clientes c WHERE c.ativo=1 ORDER BY c.nome
  `).all();
  res.json(clientes);
});

router.post('/clientes', (req, res) => {
  const { nome, cnpj, regime, segmento, responsavel, email } = req.body;
  if (!nome || !regime) return res.status(400).json({ erro: 'Nome e regime são obrigatórios' });
  const result = db.prepare('INSERT INTO clientes (nome, cnpj, regime, segmento, responsavel, email) VALUES (?,?,?,?,?,?)').run(nome, cnpj || '', regime, segmento || '', responsavel || '', email || '');
  res.json({ id: result.lastInsertRowid, mensagem: 'Cliente cadastrado' });
});

router.put('/clientes/:id', (req, res) => {
  const { nome, cnpj, regime, segmento, responsavel, email } = req.body;
  db.prepare('UPDATE clientes SET nome=?,cnpj=?,regime=?,segmento=?,responsavel=?,email=? WHERE id=?').run(nome, cnpj, regime, segmento, responsavel, email, req.params.id);
  res.json({ mensagem: 'Cliente atualizado' });
});

router.delete('/clientes/:id', (req, res) => {
  db.prepare('UPDATE clientes SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ mensagem: 'Cliente removido' });
});

// ─── NOTIFICAÇÕES ─────────────────────────────────────────────────────────

router.get('/notificacoes', (req, res) => {
  const notifs = db.prepare('SELECT * FROM notificacoes ORDER BY criado_em DESC LIMIT 50').all();
  const naoLidas = db.prepare('SELECT COUNT(*) as c FROM notificacoes WHERE lida=0').get().c;
  res.json({ notificacoes: notifs, nao_lidas: naoLidas });
});

router.patch('/notificacoes/:id/ler', (req, res) => {
  db.prepare('UPDATE notificacoes SET lida=1 WHERE id=?').run(req.params.id);
  res.json({ mensagem: 'Marcada como lida' });
});

router.post('/notificacoes/ler-todas', (req, res) => {
  db.prepare('UPDATE notificacoes SET lida=1').run();
  res.json({ mensagem: 'Todas marcadas como lidas' });
});

// ─── CONFIGURAÇÃO DE E-MAIL ───────────────────────────────────────────────

router.get('/config-email', (req, res) => {
  res.json(db.prepare('SELECT * FROM config_email WHERE id=1').get());
});

router.put('/config-email', (req, res) => {
  const { email_escritorio, dias_antecedencia, frequencia, alerta_atraso, copiar_cliente, ativo } = req.body;
  db.prepare(`UPDATE config_email SET email_escritorio=?,dias_antecedencia=?,frequencia=?,alerta_atraso=?,copiar_cliente=?,ativo=? WHERE id=1`)
    .run(email_escritorio, dias_antecedencia || 5, frequencia || 'Semanal', alerta_atraso ? 1 : 0, copiar_cliente ? 1 : 0, ativo ? 1 : 0);
  res.json({ mensagem: 'Configuração salva' });
});

router.post('/config-email/testar', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'Informe o e-mail para teste' });
  try {
    await enviarTesteEmail(email);
    res.json({ mensagem: `E-mail de teste enviado para ${email}` });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── DASHBOARD / MÉTRICAS ─────────────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM tarefas').get().c;
  const atraso = db.prepare("SELECT COUNT(*) as c FROM tarefas WHERE status='Em atraso'").get().c;
  const pendente = db.prepare("SELECT COUNT(*) as c FROM tarefas WHERE status='Pendente'").get().c;
  const concluido = db.prepare("SELECT COUNT(*) as c FROM tarefas WHERE status='Concluído'").get().c;
  const andamento = db.prepare("SELECT COUNT(*) as c FROM tarefas WHERE status='Em andamento'").get().c;
  const clientes_sn = db.prepare("SELECT COUNT(*) as c FROM clientes WHERE regime='Simples Nacional' AND ativo=1").get().c;
  const clientes_lp = db.prepare("SELECT COUNT(*) as c FROM clientes WHERE regime='Lucro Presumido' AND ativo=1").get().c;
  const nao_lidas = db.prepare('SELECT COUNT(*) as c FROM notificacoes WHERE lida=0').get().c;

  res.json({ total, atraso, pendente, concluido, andamento, clientes_sn, clientes_lp, nao_lidas });
});

// ─── EXPORTAÇÃO CSV ───────────────────────────────────────────────────────

router.get('/exportar/csv', (req, res) => {
  const tarefas = db.prepare(`
    SELECT t.id, t.nome, c.nome as cliente, t.regime, t.vencimento, t.status, t.responsavel, t.competencia, t.observacoes, t.criado_em
    FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id
    ORDER BY t.vencimento ASC
  `).all();

  const header = 'ID,Obrigação,Cliente,Regime,Vencimento,Status,Responsável,Competência,Observações,Criado em\n';
  const rows = tarefas.map(t =>
    [t.id, `"${t.nome}"`, `"${t.cliente}"`, t.regime,
     new Date(t.vencimento).toLocaleDateString('pt-BR'),
     t.status, t.responsavel, t.competencia, `"${t.observacoes || ''}"`,
     new Date(t.criado_em).toLocaleDateString('pt-BR')
    ].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="obrigacoes.csv"');
  res.send('\uFEFF' + header + rows);
});

module.exports = router;
