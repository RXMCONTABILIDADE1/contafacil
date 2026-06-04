const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { enviarTesteEmail } = require('../services/email');

const OBRIGACOES_SN = [
  {nome:'DAS — Guia Simples Nacional', dia:20},
  {nome:'PGDAS-D', dia:20},
  {nome:'e-Social', dia:7},
  {nome:'EFD-REINF', dia:15},
  {nome:'DCTFWeb', dia:15},
  {nome:'CAGED', dia:7},
  {nome:'Folha de Pagamento', dia:5},
  {nome:'FGTS', dia:7},
];
const OBRIGACOES_LP = [
  {nome:'DCTF Mensal', dia:15},
  {nome:'IRPJ/CSLL — Estimativa', dia:28},
  {nome:'SPED Contribuicoes', dia:10},
  {nome:'SPED Fiscal', dia:20},
  {nome:'EFD-REINF', dia:15},
  {nome:'DCTFWeb', dia:15},
  {nome:'e-Social', dia:7},
  {nome:'CAGED', dia:7},
  {nome:'Folha de Pagamento', dia:5},
  {nome:'FGTS', dia:7},
  {nome:'DARF PIS/COFINS', dia:25},
];

async function gerarObrigacoes(cliente_id, regime, responsavel) {
  var hoje = new Date();
  var ano = hoje.getFullYear();
  var mes = hoje.getMonth();
  var comp = String(mes+1).padStart(2,'0')+'/'+ano;
  var lista = regime === 'Simples Nacional' ? OBRIGACOES_SN : OBRIGACOES_LP;
  for (var o of lista) {
    var venc = new Date(ano, mes, o.dia);
    if (venc < hoje) venc = new Date(ano, mes+1, o.dia);
    var vencStr = venc.toISOString().split('T')[0];
    var status = venc < hoje ? 'Em atraso' : 'Pendente';
    var existe = await get('SELECT id FROM tarefas WHERE cliente_id=? AND nome=? AND competencia=?', [cliente_id, o.nome, comp]);
    if (!existe) {
      await run('INSERT INTO tarefas (nome,cliente_id,regime,vencimento,status,responsavel,competencia) VALUES (?,?,?,?,?,?,?)',
        [o.nome, cliente_id, regime, vencStr, status, responsavel||'', comp]);
      var dias = Math.ceil((venc - hoje) / 86400000);
      if (dias <= 7) {
        var c = await get('SELECT nome FROM clientes WHERE id=?', [cliente_id]);
        var tipo = dias <= 2 ? 'atraso' : 'alerta';
        await run('INSERT INTO notificacoes (titulo,mensagem,tipo) VALUES (?,?,?)',
          [o.nome+' vence em '+dias+' dia(s) — '+(c&&c.nome||''), regime+' · Vencimento: '+vencStr, tipo]);
      }
    }
  }
}

router.get('/tarefas', async (req, res) => {
  try {
    const { regime, status, cliente_id } = req.query;
    let sql = 'SELECT t.*, c.nome as cliente_nome FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id WHERE 1=1';
    const params = [];
    if (regime && regime !== 'todos') { sql += ' AND t.regime=?'; params.push(regime); }
    if (status && status !== 'todos') { sql += ' AND t.status=?'; params.push(status); }
    if (cliente_id) { sql += ' AND t.cliente_id=?'; params.push(cliente_id); }
    sql += ' ORDER BY t.vencimento ASC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/tarefas/urgentes', async (req, res) => {
  try {
    var hoje = new Date();
    var limite = new Date(hoje); limite.setDate(limite.getDate()+7);
    await run("UPDATE tarefas SET status='Em atraso' WHERE vencimento<? AND status IN ('Pendente','Em andamento')", [hoje.toISOString().split('T')[0]]);
    const rows = await all("SELECT t.*, c.nome as cliente_nome FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id WHERE t.status!='Concluído' AND (t.vencimento<=? OR t.status='Em atraso') ORDER BY t.vencimento ASC LIMIT 20", [limite.toISOString().split('T')[0]]);
    res.json(rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/tarefas', async (req, res) => {
  try {
    const { nome, cliente_id, regime, vencimento, status, responsavel, observacoes, competencia } = req.body;
    if (!nome || !cliente_id || !vencimento) return res.status(400).json({erro:'Campos obrigatorios faltando'});
    const hoje = new Date().toISOString().split('T')[0];
    const statusFinal = status || (vencimento < hoje ? 'Em atraso' : 'Pendente');
    const result = await run('INSERT INTO tarefas (nome,cliente_id,regime,vencimento,status,responsavel,observacoes,competencia) VALUES (?,?,?,?,?,?,?,?)',
      [nome, cliente_id, regime||'Simples Nacional', vencimento, statusFinal, responsavel||'', observacoes||'', competencia||'']);
    const dias = Math.ceil((new Date(vencimento) - new Date()) / 86400000);
    if (dias <= 7 && statusFinal !== 'Concluído') {
      const cliente = await get('SELECT nome FROM clientes WHERE id=?', [cliente_id]);
      var tipo = dias <= 2 ? 'atraso' : 'alerta';
      await run('INSERT INTO notificacoes (titulo,mensagem,tipo,tarefa_id) VALUES (?,?,?,?)',
        [nome+' vence em '+dias+' dia(s) — '+(cliente&&cliente.nome||''), regime||'', tipo, result.lastID]);
    }
    res.json({id: result.lastID, mensagem:'Tarefa criada'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/tarefas/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE tarefas SET status=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?', [status, req.params.id]);
    if (status === 'Concluído') {
      const t = await get('SELECT t.nome,c.nome as cn FROM tarefas t JOIN clientes c ON t.cliente_id=c.id WHERE t.id=?', [req.params.id]);
      if (t) await run('INSERT INTO notificacoes (titulo,tipo,tarefa_id) VALUES (?,?,?)', [t.nome+' concluido — '+t.cn, 'ok', req.params.id]);
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

router.get('/clientes', async (req, res) => {
  try {
    const rows = await all("SELECT c.*, (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Em atraso') as qtd_atraso, (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Pendente') as qtd_pendente, (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id AND status='Concluído') as qtd_concluido, (SELECT COUNT(*) FROM tarefas WHERE cliente_id=c.id) as qtd_total FROM clientes c WHERE c.ativo=1 ORDER BY c.nome");
    res.json(rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/clientes', async (req, res) => {
  try {
    const { nome, cnpj, regime, situacao, segmento, responsavel, email, honorario } = req.body;
    if (!nome || !regime) return res.status(400).json({erro:'Nome e regime obrigatorios'});
    const result = await run('INSERT INTO clientes (nome,cnpj,regime,situacao,segmento,responsavel,email,honorario) VALUES (?,?,?,?,?,?,?,?)',
      [nome, cnpj||'', regime, situacao||'Ativa', segmento||'', responsavel||'', email||'', honorario||0]);
    await gerarObrigacoes(result.lastID, regime, responsavel);
    if (honorario && parseFloat(honorario) > 0) {
      var hoje = new Date();
      var venc = new Date(hoje.getFullYear(), hoje.getMonth(), 28);
      if (venc < hoje) venc = new Date(hoje.getFullYear(), hoje.getMonth()+1, 28);
      await run('INSERT INTO honorarios (cliente_id,valor,vencimento,competencia,status) VALUES (?,?,?,?,?)',
        [result.lastID, parseFloat(honorario), venc.toISOString().split('T')[0], String(hoje.getMonth()+1).padStart(2,'0')+'/'+hoje.getFullYear(), 'Pendente']);
    }
    res.json({id: result.lastID, mensagem:'Cliente cadastrado com obrigacoes geradas'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/clientes/:id', async (req, res) => {
  try {
    const { nome, cnpj, regime, situacao, segmento, responsavel, email, honorario } = req.body;
    await run('UPDATE clientes SET nome=?,cnpj=?,regime=?,situacao=?,segmento=?,responsavel=?,email=?,honorario=? WHERE id=?',
      [nome, cnpj||'', regime, situacao||'Ativa', segmento||'', responsavel||'', email||'', honorario||0, req.params.id]);
    res.json({mensagem:'Cliente atualizado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/clientes/:id', async (req, res) => {
  try {
    await run('UPDATE clientes SET ativo=0 WHERE id=?', [req.params.id]);
    res.json({mensagem:'Cliente removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/honorarios', async (req, res) => {
  try {
    const rows = await all('SELECT h.*,c.nome as cliente_nome,c.regime FROM honorarios h LEFT JOIN clientes c ON h.cliente_id=c.id ORDER BY h.vencimento ASC');
    const total = rows.reduce(function(s,h){return s+parseFloat(h.valor||0);},0);
    const pago = rows.filter(function(h){return h.status==='Pago';}).reduce(function(s,h){return s+parseFloat(h.valor||0);},0);
    const pendente = rows.filter(function(h){return h.status==='Pendente';}).reduce(function(s,h){return s+parseFloat(h.valor||0);},0);
    const atraso = rows.filter(function(h){return h.status==='Em atraso';}).reduce(function(s,h){return s+parseFloat(h.valor||0);},0);
    res.json({honorarios:rows, total, pago, pendente, atraso});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/honorarios', async (req, res) => {
  try {
    const { cliente_id, valor, vencimento, competencia, status, observacoes } = req.body;
    const result = await run('INSERT INTO honorarios (cliente_id,valor,vencimento,competencia,status,observacoes) VALUES (?,?,?,?,?,?)',
      [cliente_id, valor||0, vencimento, competencia||'', status||'Pendente', observacoes||'']);
    res.json({id: result.lastID, mensagem:'Honorario lancado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/honorarios/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE honorarios SET status=? WHERE id=?', [status, req.params.id]);
    res.json({mensagem:'Status atualizado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/honorarios/:id', async (req, res) => {
  try {
    await run('DELETE FROM honorarios WHERE id=?', [req.params.id]);
    res.json({mensagem:'Removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/notificacoes', async (req, res) => {
  try {
    var hoje = new Date().toISOString().split('T')[0];
    var limite2 = new Date(); limite2.setDate(limite2.getDate()+2);
    var limite7 = new Date(); limite7.setDate(limite7.getDate()+7);
    var urgentes = await all("SELECT t.*,c.nome as cn FROM tarefas t JOIN clientes c ON t.cliente_id=c.id WHERE t.status NOT IN ('Concluído') AND t.vencimento<=?", [limite2.toISOString().split('T')[0]]);
    for (var t of urgentes) {
      var existe = await get('SELECT id FROM notificacoes WHERE tarefa_id=? AND tipo=?', [t.id, 'atraso']);
      if (!existe) await run('INSERT INTO notificacoes (titulo,mensagem,tipo,tarefa_id) VALUES (?,?,?,?)', ['URGENTE: '+t.nome+' — '+t.cn, 'Vence em 2 dias ou menos!', 'atraso', t.id]);
    }
    const notificacoes = await all('SELECT * FROM notificacoes ORDER BY criado_em DESC LIMIT 50');
    const r = await get('SELECT COUNT(*) as c FROM notificacoes WHERE lida=0');
    res.json({notificacoes, nao_lidas: r.c});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/notificacoes/:id/ler', async (req, res) => {
  try { await run('UPDATE notificacoes SET lida=1 WHERE id=?', [req.params.id]); res.json({mensagem:'Lida'}); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/notificacoes/ler-todas', async (req, res) => {
  try { await run('UPDATE notificacoes SET lida=1'); res.json({mensagem:'Todas lidas'}); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/config-email', async (req, res) => {
  try { res.json(await get('SELECT * FROM config_email WHERE id=1')); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/config-email', async (req, res) => {
  try {
    const { email_escritorio, dias_antecedencia, frequencia, alerta_atraso, copiar_cliente, ativo } = req.body;
    await run('UPDATE config_email SET email_escritorio=?,dias_antecedencia=?,frequencia=?,alerta_atraso=?,copiar_cliente=?,ativo=? WHERE id=1',
      [email_escritorio, dias_antecedencia||5, frequencia||'Semanal', alerta_atraso?1:0, copiar_cliente?1:0, ativo?1:0]);
    res.json({mensagem:'Configuracao salva'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/config-email/testar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({erro:'Informe o e-mail'});
    await enviarTesteEmail(email);
    res.json({mensagem:'E-mail de teste enviado para '+email});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/dashboard', async (req, res) => {
  try {
    const [total,atraso,pendente,concluido,andamento,clientes_sn,clientes_lp,nao_lidas,fin] = await Promise.all([
      get('SELECT COUNT(*) as c FROM tarefas'),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Em atraso'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Pendente'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Concluído'"),
      get("SELECT COUNT(*) as c FROM tarefas WHERE status='Em andamento'"),
      get("SELECT COUNT(*) as c FROM clientes WHERE regime='Simples Nacional' AND ativo=1"),
      get("SELECT COUNT(*) as c FROM clientes WHERE regime='Lucro Presumido' AND ativo=1"),
      get('SELECT COUNT(*) as c FROM notificacoes WHERE lida=0'),
      get("SELECT COALESCE(SUM(CASE WHEN status='Pendente' THEN valor ELSE 0 END),0) as pend, COALESCE(SUM(CASE WHEN status='Em atraso' THEN valor ELSE 0 END),0) as atr FROM honorarios"),
    ]);
    res.json({total:total.c,atraso:atraso.c,pendente:pendente.c,concluido:concluido.c,andamento:andamento.c,clientes_sn:clientes_sn.c,clientes_lp:clientes_lp.c,nao_lidas:nao_lidas.c,fin_pendente:fin.pend,fin_atraso:fin.atr});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/exportar/csv', async (req, res) => {
  try {
    const tarefas = await all('SELECT t.id,t.nome,c.nome as cliente,t.regime,t.vencimento,t.status,t.responsavel,t.competencia,t.observacoes FROM tarefas t LEFT JOIN clientes c ON t.cliente_id=c.id ORDER BY t.vencimento ASC');
    const header = 'ID,Obrigacao,Cliente,Regime,Vencimento,Status,Responsavel,Competencia,Observacoes\n';
    const rows = tarefas.map(function(t){return [t.id,'"'+t.nome+'"','"'+(t.cliente||'')+'"',t.regime,t.vencimento,t.status,t.responsavel||'',t.competencia||'','"'+(t.observacoes||'')+'"'].join(',');}).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="obrigacoes.csv"');
    res.send('\uFEFF'+header+rows);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

module.exports = router;
