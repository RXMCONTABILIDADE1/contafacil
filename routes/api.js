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

router.get('/tarefas/:id', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({erro:'Tarefa não encontrada'});
    res.json(t);
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
    res.json({id: newId, mensagem:'Tarefa criada'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/tarefas/:id', async (req, res) => {
  try {
    const { nome, vencimento, status, responsavel, observacoes, competencia, regime } = req.body;
    await run('UPDATE tarefas SET nome=?,vencimento=?,status=?,responsavel=?,observacoes=?,competencia=?,regime=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?',
      [nome, vencimento, status, responsavel||'', observacoes||'', competencia||'', regime, req.params.id]);
    res.json({mensagem:'Tarefa atualizada'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/tarefas/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE tarefas SET status=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?', [status, req.params.id]);
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
    const { nome, cnpj, regime, segmento, responsavel, email, folha, honorario } = req.body;
    if (!nome || !regime) return res.status(400).json({erro:'Nome e regime obrigatórios'});
    const result = await run('INSERT INTO clientes (nome,cnpj,regime,segmento,responsavel,email,honorario) VALUES (?,?,?,?,?,?,?) RETURNING id',
      [nome, cnpj||'', regime, segmento||'', responsavel||'', email||'', honorario||0]);
    const clienteId = result.lastID || result.rows?.[0]?.id;

    const hoje = new Date();
    const mes = String(hoje.getMonth()+1).padStart(2,'0');
    const ano = hoje.getFullYear();
    const competencia = `${mes}/${ano}`;
    const obrigacoes = [];
    if(regime === 'MEI') obrigacoes.push({nome:'DAS-MEI', venc:`${ano}-${mes}-20`});
    if(regime === 'Simples Nacional') {
      obrigacoes.push({nome:'DAS — Guia Simples Nacional', venc:`${ano}-${mes}-20`});
      obrigacoes.push({nome:'PGDAS-D', venc:`${ano}-${mes}-20`});
    }
    if(regime === 'Lucro Presumido' || regime === 'Lucro Real') {
      obrigacoes.push({nome:'DCTF Mensal', venc:`${ano}-${mes}-15`});
      obrigacoes.push({nome:'DARF PIS/COFINS', venc:`${ano}-${mes}-25`});
      obrigacoes.push({nome:'IRPJ/CSLL — Estimativa', venc:`${ano}-${mes}-30`});
    }
    if(folha) {
      obrigacoes.push({nome:'e-Social', venc:`${ano}-${mes}-07`});
      obrigacoes.push({nome:'FGTS (GRF)', venc:`${ano}-${mes}-07`});
    }
    for(const ob of obrigacoes) {
      await run('INSERT INTO tarefas (nome,cliente_id,regime,vencimento,status,competencia) VALUES (?,?,?,?,?,?) RETURNING id',
        [ob.nome, clienteId, regime, ob.venc, 'Pendente', competencia]);
    }
    if(honorario && honorario > 0) {
      const mesRef = `${ano}-${mes}`;
      await run('INSERT INTO financeiro (cliente_id,mes_referencia,valor,status) VALUES (?,?,?,?) RETURNING id',
        [clienteId, mesRef, honorario, 'Pendente']);
    }
    res.json({id: clienteId, mensagem:'Cliente cadastrado', obrigacoes_criadas: obrigacoes.length});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/clientes/:id', async (req, res) => {
  try {
    const { nome, cnpj, regime, segmento, responsavel, email, honorario } = req.body;
    await run('UPDATE clientes SET nome=?,cnpj=?,regime=?,segmento=?,responsavel=?,email=?,honorario=? WHERE id=?',
      [nome, cnpj||'', regime, segmento||'', responsavel||'', email||'', honorario||0, req.params.id]);
    res.json({mensagem:'Cliente atualizado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/clientes/:id', async (req, res) => {
  try {
    await run('DELETE FROM tarefas WHERE cliente_id=?', [req.params.id]);
    await run('DELETE FROM financeiro WHERE cliente_id=?', [req.params.id]);
    await run('UPDATE clientes SET ativo=0 WHERE id=?', [req.params.id]);
    res.json({mensagem:'Cliente removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});, async (req, res) => {
  try {
    await run('UPDATE clientes SET ativo=0 WHERE id=?', [req.params.id]);
    res.json({mensagem:'Cliente removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// AGENDA
router.get('/agenda', async (req, res) => {
  try {
    const { data } = req.query;
    const hoje = new Date().toISOString().split('T')[0];
    const dataFiltro = data || hoje;

    // Buscar itens da agenda do dia
    const itens = await all(`
      SELECT a.*, c.nome as cliente_nome
      FROM agenda a
      LEFT JOIN clientes c ON a.cliente_id = c.id
      WHERE a.data = ?
      ORDER BY a.concluido ASC, a.prioridade DESC, a.hora ASC
    `, [dataFiltro]);

    // Buscar tarefas que vencem hoje e não estão na agenda
    const tarefasHoje = await all(`
      SELECT t.*, c.nome as cliente_nome
      FROM tarefas t
      LEFT JOIN clientes c ON t.cliente_id = c.id
      WHERE t.vencimento = ? AND t.status != 'Concluído'
      AND t.id NOT IN (SELECT tarefa_id FROM agenda WHERE tarefa_id IS NOT NULL AND data = ?)
    `, [dataFiltro, dataFiltro]);

    // Mover itens não concluídos de dias anteriores para hoje
    const atrasados = await all(`
      SELECT a.*, c.nome as cliente_nome
      FROM agenda a
      LEFT JOIN clientes c ON a.cliente_id = c.id
      WHERE a.data < ? AND a.concluido = 0
      ORDER BY a.data ASC, a.hora ASC
    `, [dataFiltro]);

    res.json({ itens, tarefasHoje, atrasados, data: dataFiltro });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/agenda', async (req, res) => {
  try {
    const { titulo, descricao, data, hora, tipo, cliente_id, prioridade } = req.body;
    if (!titulo || !data) return res.status(400).json({erro:'Título e data obrigatórios'});
    const result = await run('INSERT INTO agenda (titulo,descricao,data,hora,tipo,cliente_id,prioridade) VALUES (?,?,?,?,?,?,?) RETURNING id',
      [titulo, descricao||'', data, hora||'', tipo||'interno', cliente_id||null, prioridade||'normal']);
    res.json({id: result.lastID || result.rows?.[0]?.id, mensagem:'Item adicionado à agenda'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/agenda/:id/concluir', async (req, res) => {
  try {
    const { concluido } = req.body;
    await run('UPDATE agenda SET concluido=? WHERE id=?', [concluido?1:0, req.params.id]);
    res.json({mensagem: concluido ? 'Concluído!' : 'Reaberto'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.patch('/agenda/:id/adiar', async (req, res) => {
  try {
    const { data } = req.body;
    await run('UPDATE agenda SET data=? WHERE id=?', [data, req.params.id]);
    res.json({mensagem:'Item adiado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/agenda/:id', async (req, res) => {
  try {
    await run('DELETE FROM agenda WHERE id=?', [req.params.id]);
    res.json({mensagem:'Item removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// FINANCEIRO
router.get('/financeiro', async (req, res) => {
  try {
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const rows = await all(`
      SELECT c.id as cliente_id, c.nome, c.regime, c.honorario,
        f.id as fin_id, f.status as fin_status, f.valor as fin_valor, f.data_pagamento, f.observacao
      FROM clientes c
      LEFT JOIN financeiro f ON f.cliente_id=c.id AND f.mes_referencia=?
      WHERE c.ativo=1 AND c.honorario > 0
      ORDER BY c.nome`, [mes]);
    const total = rows.reduce((s,r) => s + (parseFloat(r.honorario)||0), 0);
    const recebido = rows.filter(r=>r.fin_status==='Pago').reduce((s,r) => s + (parseFloat(r.fin_valor||r.honorario)||0), 0);
    res.json({rows, total, recebido, pendente: total - recebido, mes});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/financeiro/pagar', async (req, res) => {
  try {
    const { cliente_id, mes_referencia, valor, observacao } = req.body;
    const existing = await get('SELECT id FROM financeiro WHERE cliente_id=? AND mes_referencia=?', [cliente_id, mes_referencia]);
    if(existing) {
      await run('UPDATE financeiro SET status=?,valor=?,data_pagamento=CURRENT_DATE,observacao=? WHERE id=?',
        ['Pago', valor, observacao||'', existing.id]);
    } else {
      await run('INSERT INTO financeiro (cliente_id,mes_referencia,valor,status,data_pagamento,observacao) VALUES (?,?,?,?,CURRENT_DATE,?) RETURNING id',
        [cliente_id, mes_referencia, valor, 'Pago', observacao||'']);
    }
    res.json({mensagem:'Pagamento registrado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/financeiro/cancelar', async (req, res) => {
  try {
    const { cliente_id, mes_referencia } = req.body;
    await run('UPDATE financeiro SET status=?,data_pagamento=NULL WHERE cliente_id=? AND mes_referencia=?',
      ['Pendente', cliente_id, mes_referencia]);
    res.json({mensagem:'Pagamento cancelado'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/financeiro/gerar-mes', async (req, res) => {
  try {
    const { mes_referencia } = req.body;
    const clientes = await all('SELECT id, honorario FROM clientes WHERE ativo=1 AND honorario > 0');
    let criados = 0;
    for(const c of clientes) {
      const existing = await get('SELECT id FROM financeiro WHERE cliente_id=? AND mes_referencia=?', [c.id, mes_referencia]);
      if(!existing) {
        await run('INSERT INTO financeiro (cliente_id,mes_referencia,valor,status) VALUES (?,?,?,?) RETURNING id',
          [c.id, mes_referencia, c.honorario, 'Pendente']);
        criados++;
      }
    }
    res.json({mensagem:`${criados} registros criados para ${mes_referencia}`});
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
// OBRIGAÇÕES RECORRENTES
router.post('/obrigacoes/gerar-mes', async (req, res) => {
  try {
    const { mes, ano } = req.body;
    const mesStr = String(mes).padStart(2,'0');
    const competencia = `${mesStr}/${ano}`;
    const clientes = await all('SELECT * FROM clientes WHERE ativo=1');
    let criadas = 0;
    let ignoradas = 0;

    for(const c of clientes) {
      const obrigacoes = [];

      if(c.regime === 'MEI') {
        obrigacoes.push({nome:'DAS-MEI', venc:`${ano}-${mesStr}-20`});
        obrigacoes.push({nome:'DASN-SIMEI', venc:`${ano}-${mesStr}-31`});
      }
      if(c.regime === 'Simples Nacional') {
        obrigacoes.push({nome:'DAS — Guia Simples Nacional', venc:`${ano}-${mesStr}-20`});
        obrigacoes.push({nome:'PGDAS-D', venc:`${ano}-${mesStr}-20`});
      }
      if(c.regime === 'Lucro Presumido' || c.regime === 'Lucro Real') {
        obrigacoes.push({nome:'DCTF Mensal', venc:`${ano}-${mesStr}-15`});
        obrigacoes.push({nome:'DARF PIS/COFINS', venc:`${ano}-${mesStr}-25`});
        obrigacoes.push({nome:'IRPJ/CSLL — Estimativa', venc:`${ano}-${mesStr}-30`});
        obrigacoes.push({nome:'SPED Contribuições', venc:`${ano}-${mesStr}-10`});
      }
      if(c.regime === 'Associação') {
        obrigacoes.push({nome:'DCTF Mensal', venc:`${ano}-${mesStr}-15`});
      }

      // Verificar folha de pagamento
      const temFolha = await get('SELECT id FROM tarefas WHERE cliente_id=? AND nome=? LIMIT 1', [c.id, 'e-Social']);
      if(temFolha) {
        obrigacoes.push({nome:'e-Social', venc:`${ano}-${mesStr}-07`});
        obrigacoes.push({nome:'FGTS (GRF)', venc:`${ano}-${mesStr}-07`});
        obrigacoes.push({nome:'Folha de Pagamento', venc:`${ano}-${mesStr}-05`});
      }

      for(const ob of obrigacoes) {
        // Verificar se já existe para esse cliente/mês/obrigação
        const existe = await get(
          'SELECT id FROM tarefas WHERE cliente_id=? AND nome=? AND competencia=?',
          [c.id, ob.nome, competencia]
        );
        if(!existe) {
          await run(
            'INSERT INTO tarefas (nome,cliente_id,regime,vencimento,status,competencia) VALUES (?,?,?,?,?,?) RETURNING id',
            [ob.nome, c.id, c.regime, ob.venc, 'Pendente', competencia]
          );
          criadas++;
        } else {
          ignoradas++;
        }
      }
    }

    res.json({
      mensagem: `✅ ${criadas} obrigações criadas para ${competencia}`
      criadas,
      ignoradas,
      clientes: clientes.length
    });
  } catch(e) { res.status(500).json({erro: e.message}); }
// LIMPAR DUPLICATAS
router.post('/tarefas/limpar-duplicatas', async (req, res) => {
  try {
    const duplicatas = await all(`
      SELECT MIN(id) as manter, cliente_id, nome, competencia, COUNT(*) as total
      FROM tarefas 
      GROUP BY cliente_id, nome, competencia
      HAVING COUNT(*) > 1
    `);
    let removidas = 0;
    for(const d of duplicatas) {
      const r = await run(
        'DELETE FROM tarefas WHERE cliente_id=? AND nome=? AND competencia=? AND id != ?',
        [d.cliente_id, d.nome, d.competencia, d.manter]
      );
      removidas += r.changes || 0;
    }
    res.json({mensagem: `✅ ${removidas} tarefas duplicadas removidas!`, removidas});
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
