const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { enviarTesteEmail } = require('../services/email');

// TAREFAS
router.get('/tarefas', async (req, res) => {
  try {
    const { regime, status } = req.query;
    let sql = `SELECT t.*, c.nome as cliente_nome FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id WHERE 1=1`;
    const params = [];
    if (regime && regime !== 'todos') { sql += ' AND t.regime=?'; params.push(regime); }
    if (status && status !== 'todos') { sql += ' AND t.status=?'; params.push(status); }
    sql += ' ORDER BY t.vencimento ASC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/tarefas/urgentes', async (req, res) => {
  try {
    const limite = new Date(); limite.setDate(limite.getDate()+7);
    const rows = await all(`SELECT t.*, c.nome as cliente_nome FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id WHERE t.status!='Concluído' AND (t.vencimento<=? OR t.status='Em atraso') ORDER BY t.vencimento ASC LIMIT 20`, [limite.toISOString().split('T')[0]]);
    res.json(rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/tarefas', async (req, res) => {
  try {
    const { nome, cliente_id, regime, vencimento, status, responsavel, observacoes, competencia } = req.body;
    if (!nome || !cliente_id || !vencimento) return res.status(400).json({erro:'Campos obrigatórios faltando'});
    const hoje = new Date().toISOString().split('T')[0];
    const statusFinal = status || (vencimento < hoje ? 'Em atraso' : 'Pendente');
    const result = await run('INSERT INTO tarefas (nome,cliente_id,regime,vencimento,status,responsavel,observacoes,competencia) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      [nome, cliente_id, regime||'Simples Nacional', vencimento, statusFinal, responsavel||'', observacoes||'', competencia||'']);
    const newId = result.lastID || result.rows?.[0]?.id;
    const diasAteVencer = Math.ceil((new Date(vencimento) - new Date()) / 86400000);
    if (diasAteVencer <= 7 && statusFinal !== 'Concluído') {
      const cliente = await get('SELECT nome FROM clientes WHERE id=?', [cliente_id]);
      await run('INSERT INTO notificacoes (titulo,mensagem,tipo,tarefa_id) VALUES (?,?,?,?)',
        [`${nome} vence em ${diasAteVencer} dias — ${cliente?.nome}`, `${regime}`, statusFinal==='Em atraso'?'atraso':'alerta', newId]);
    }
    res.json({id: newId, mensagem:'Tarefa criada'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/tarefas/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE tarefas SET status=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?', [status, req.params.id]);
    if (status === 'Concluído') {
      const t = await get('SELECT t.nome,c.nome as cn FROM tarefas t JOIN clientes c ON t.cliente_id=c.id WHERE t.id=?', [req.params.id]);
      if (t) await run('INSERT INTO notificacoes (titulo,tipo,tarefa_id) VALUES (?,?,?)', [`${t.nome} concluído — ${t.cn}`, 'ok', req.params.id]);
    }
    res.json({mensagem:'Status atualizado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/tarefas/:id', async (req, res) => {
  try {
    await run('DELETE FROM tarefas WHERE id=?', [req.params.id]);
    res.json({mensagem:'Tarefa removida'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// CLIENTES
router.get('/clientes', async (req, res) => {
  try {
    const rows = await all(`SELECT c.*,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Em atraso') as qtd_atraso,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Pendente') as qtd_pendente,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Concluído') as qtd_concluido,
      (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id) as qtd_total
      FROM clientes c WHERE c.ativo=1 ORDER BY c.nome`);
    res.json(rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/clientes', async (req, res) => {
  try {
    const { nome, cnpj, regime, segmento, responsavel, email } = req.body;
    if (!nome || !regime) return res.status(400).json({erro:'Nome e regime obrigatórios'});
    const result = await run('INSERT INTO clientes (nome,cnpj,regime,segmento,responsavel,email) VALUES (?,?,?,?,?,?) RETURNING id',
      [nome, cnpj||'', regime, segmento||'', responsavel||'', email||'']);
    res.json({id: result.lastID, mensagem:'Cliente cadastrado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/clientes/:id', async (req, res) => {
  try {
    await run('UPDATE clientes SET ativo=0 WHERE id=?', [req.params.id]);
    res.json({mensagem:'Cliente removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// NOTIFICAÇÕES
router.get('/notificacoes', async (req, res) => {
  try {
    const notificacoes = await all('SELECT * FROM notificacoes ORDER BY criado_em DESC LIMIT 50');
    const r = await get('SELECT COUNT(*) as c FROM notificacoes WHERE lida=0');
    res.json({notificacoes, nao_lidas: r.c});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/notificacoes/:id/ler', async (req, res) => {
  try {
    await run('UPDATE notificacoes SET lida=1 WHERE id=?', [req.params.id]);
    res.json({mensagem:'Lida'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/notificacoes/ler-todas', async (req, res) => {
  try {
    await run('UPDATE notificacoes SET lida=1');
    res.json({mensagem:'Todas lidas'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// CONFIG EMAIL
router.get('/config-email', async (req, res) => {
  try { res.json(await get('SELECT * FROM config_email WHERE id=1')); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/config-email', async (req, res) => {
  try {
    const { email_escritorio, dias_antecedencia, frequencia, alerta_atraso, copiar_cliente, ativo } = req.body;
    await run('UPDATE config_email SET email_escritorio=?,dias_antecedencia=?,frequencia=?,alerta_atraso=?,copiar_cliente=?,ativo=? WHERE id=1',
      [email_escritorio, dias_antecedencia||5, frequencia||'Semanal', alerta_atraso?1:0, copiar_cliente?1:0, ativo?1:0]);
    res.json({mensagem:'Configuração salva'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/config-email/testar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({erro:'Informe o e-mail'});
    await enviarTesteEmail(email);
    res.json({mensagem:`E-mail de teste enviado para ${email}`});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// DASHBOARD
router.get('/dashboard', async (req, res) => {
  try {
    const [total,atraso,pendente,concluido,andamento,clientes_sn,clientes_lp,nao_lidas] = await Promise.all([
      get("SELECT COUNT(*) as c FROM tarefas"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Em atraso'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Pendente'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Concluído'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Em andamento'"),
      get("SELECT COUNT(*) as c FROM clientes WHERE regime='Simples Nacional' AND ativo=1"),
      get("SELECT COUNT(*) as c FROM clientes WHERE regime='Lucro Presumido' AND ativo=1"),
      get("SELECT COUNT(*) as c FROM notificacoes WHERE lida=0"),
    ]);
    res.json({total:total.c,atraso:atraso.c,pendente:pendente.c,concluido:concluido.c,andamento:andamento.c,clientes_sn:clientes_sn.c,clientes_lp:clientes_lp.c,nao_lidas:nao_lidas.c});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// EXPORTAR CSV
router.get('/exportar/csv', async (req, res) => {
  try {
    const tarefas = await all(`SELECT t.id,t.nome,c.nome as cliente,t.regime,t.vencimento,t.status,t.responsavel,t.competencia,t.observacoes FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id ORDER BY t.vencimento ASC`);
    const header = 'ID,Obrigação,Cliente,Regime,Vencimento,Status,Responsável,Competência,Observações\n';
    const rows = tarefas.map(t => [t.id,`"${t.nome}"`,`"${t.cliente||''}"`,t.regime,t.vencimento,t.status,t.responsavel||'',t.competencia||'',`"${t.observacoes||''}"`].join(',')).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="obrigacoes.csv"');
    res.send('\uFEFF'+header+rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

module.exports = router;
