const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { enviarTesteEmail } = require('../services/email');
const sefaz = require('../services/sefaz');
const opc = require('../services/opcoes');
const bcrypt = require('bcryptjs');

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
    const { nome, cnpj, regime, segmento, responsavel, email, folha, honorario, uf } = req.body;
    if (!nome || !regime) return res.status(400).json({erro:'Nome e regime obrigatórios'});
    const result = await run('INSERT INTO clientes (nome,cnpj,regime,segmento,responsavel,email,honorario,uf) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      [nome, cnpj||'', regime, segmento||'', responsavel||'', email||'', honorario||0, uf||'']);
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
    const { nome, cnpj, regime, segmento, responsavel, email, honorario, uf } = req.body;
    await run('UPDATE clientes SET nome=?,cnpj=?,regime=?,segmento=?,responsavel=?,email=?,honorario=?,uf=? WHERE id=?',
      [nome, cnpj||'', regime, segmento||'', responsavel||'', email||'', honorario||0, uf||'', req.params.id]);
    // Salvar pelo cadastro completo tira a marca de pré-cadastro quando o CNPJ foi informado
    if ((cnpj||'').replace(/\D/g,'').length === 14) await run('UPDATE clientes SET pre_cadastro=0 WHERE id=?', [req.params.id]);
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

// SENHA DO FINANCEIRO — desbloqueio vale 15 min e renova a cada uso
const FIN_MINUTOS = 15;
async function senhaFinHash() { return (await get('SELECT senha_hash FROM config_financeiro WHERE id=1'))?.senha_hash || null; }
function finLiberado(req) { return (req.session.finAte || 0) > Date.now(); }
function liberarFin(req) { req.session.finAte = Date.now() + FIN_MINUTOS * 60000; }

router.use('/financeiro', (req, res, next) => {
  if (!finLiberado(req)) return res.status(403).json({ erro: 'Financeiro bloqueado. Digite a senha.', bloqueado: true });
  liberarFin(req); next();
});

router.get('/fin-senha/status', async (req, res) => {
  try { res.json({ definida: !!(await senhaFinHash()), liberado: finLiberado(req) }); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/fin-senha/entrar', async (req, res) => {
  try {
    const hash = await senhaFinHash();
    if (!hash) return res.status(400).json({ erro: 'Crie a senha do financeiro primeiro.' });
    if (!bcrypt.compareSync(String(req.body.senha || ''), hash)) return res.status(400).json({ erro: 'Senha incorreta.' });
    liberarFin(req); res.json({ ok: true });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// Cria a senha (primeiro acesso) ou troca: exige a senha atual do financeiro OU a senha de login
router.post('/fin-senha/definir', async (req, res) => {
  try {
    const nova = String(req.body.nova || '');
    if (nova.length < 4) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 4 caracteres.' });
    const hash = await senhaFinHash();
    if (hash) {
      const atualOk = req.body.atual && bcrypt.compareSync(String(req.body.atual), hash);
      const u = await get('SELECT senha FROM usuarios WHERE id=?', [req.session.usuario.id]);
      const loginOk = req.body.senha_login && u && bcrypt.compareSync(String(req.body.senha_login), u.senha);
      if (!atualOk && !loginOk) return res.status(400).json({ erro: 'Senha atual (ou senha de login) incorreta.' });
    }
    await run(`INSERT INTO config_financeiro (id, senha_hash, atualizado_em) VALUES (1, ?, CURRENT_TIMESTAMP)
               ON CONFLICT (id) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, atualizado_em = CURRENT_TIMESTAMP`, [bcrypt.hashSync(nova, 10)]);
    liberarFin(req); res.json({ ok: true, mensagem: hash ? 'Senha do financeiro alterada' : 'Senha do financeiro criada' });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/fin-senha/bloquear', (req, res) => { req.session.finAte = 0; res.json({ ok: true }); });

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
    const clientes = await all('SELECT * FROM clientes WHERE ativo=1 AND COALESCE(pre_cadastro,0)=0');
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
      mensagem: `✅ ${criadas} obrigações criadas para ${competencia}`,
      criadas,
      ignoradas,
      clientes: clientes.length
    });
  } catch(e) { res.status(500).json({erro: e.message}); }
});
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

// NOTAS FISCAIS (SEFAZ - Distribuição DFe)
router.post('/clientes/:id/certificado', async (req, res) => {
  try {
    const { pfxBase64, senha } = req.body;
    const cliente = await get('SELECT id, cnpj FROM clientes WHERE id=?', [req.params.id]);
    if (!cliente) return res.status(404).json({erro:'Cliente não encontrado'});
    if (!cliente.cnpj) return res.status(400).json({erro:'Cadastre o CNPJ do cliente antes de vincular o certificado'});
    await sefaz.salvarCertificado(cliente.id, pfxBase64, senha);
    res.json({mensagem:'Certificado vinculado com sucesso'});
  } catch(e) { res.status(400).json({erro: e.message}); }
});

router.get('/clientes/:id/certificado', async (req, res) => {
  try {
    const cert = await get('SELECT id, ultimo_nsu, ultima_sincronizacao, criado_em FROM certificados_digitais WHERE cliente_id=?', [req.params.id]);
    res.json(cert || null);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.delete('/clientes/:id/certificado', async (req, res) => {
  try {
    await run('DELETE FROM certificados_digitais WHERE cliente_id=?', [req.params.id]);
    res.json({mensagem:'Certificado removido'});
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/clientes/:id/notas/sincronizar', async (req, res) => {
  try {
    const cliente = await get('SELECT id, nome, cnpj, uf FROM clientes WHERE id=?', [req.params.id]);
    if (!cliente) return res.status(404).json({erro:'Cliente não encontrado'});
    const resultado = await sefaz.sincronizarNotas(cliente);
    res.json(resultado);
  } catch(e) { res.status(400).json({erro: e.message}); }
});

router.get('/clientes/:id/notas', async (req, res) => {
  try {
    const notas = await all('SELECT * FROM notas_fiscais WHERE cliente_id=? ORDER BY data_emissao DESC', [req.params.id]);
    const total = notas.reduce((s,n)=> s + Number(n.valor||0), 0);
    res.json({ quantidade: notas.length, total, notas });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// OPÇÕES ANUAIS — Simples Nacional + IBS/CBS
const OPC_CAMPOS = {
  simples_status: v => opc.STATUS[v] || v,
  ibs_cbs: v => v, decisao: v => v,
  pendencia: v => v || '(sem pendência)', pendencia_orgao: v => v || '—',
  protocolo: v => v || '—', incluido_em: v => String(v).split('T')[0]
};
const OPC_ROTULO = { simples_status:'Opção Simples', ibs_cbs:'IBS/CBS', decisao:'Decisão 20/11', pendencia:'Pendência', pendencia_orgao:'Órgão', protocolo:'Protocolo', incluido_em:'Data de inclusão' };

async function histOpcao(opcaoId, descricao) {
  await run('INSERT INTO opcoes_historico (opcao_id, descricao) VALUES (?,?) RETURNING id', [opcaoId, descricao]);
}

// Localiza o cliente pelo id, CNPJ ou nome exato; se não existir, cria pré-cadastro
async function clienteParaOpcao({ cliente_id, nome, cnpj, regime, uf, email }) {
  if (cliente_id) return { id: Number(cliente_id), criado: false };
  const cnpjNum = (cnpj||'').replace(/\D/g,'');
  if (cnpjNum.length === 14) {
    const c = await get(`SELECT id FROM clientes WHERE ativo=1 AND regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=?`, [cnpjNum]);
    if (c) return { id: c.id, criado: false };
  }
  const porNome = await get(`SELECT id FROM clientes WHERE ativo=1 AND lower(trim(nome))=lower(trim(?))`, [nome]);
  if (porNome) return { id: porNome.id, criado: false };
  // Apelido que aparece dentro de um único nome cadastrado (ex.: "Kauex" → "KAUEX COMERCIO LTDA")
  const termo = String(nome).trim();
  if (termo.length >= 3) {
    const parecidos = await all(`SELECT id FROM clientes WHERE ativo=1 AND nome ILIKE ? LIMIT 2`, ['%' + termo.replace(/[%_]/g, '') + '%']);
    if (parecidos.length === 1) return { id: parecidos[0].id, criado: false };
  }
  const r = await run(`INSERT INTO clientes (nome,cnpj,regime,email,uf,pre_cadastro) VALUES (?,?,?,?,?,1) RETURNING id`,
    [nome.trim(), cnpj||'', regime||'Simples Nacional', email||'', uf||'']);
  return { id: r.lastID, criado: true };
}

async function incluirNaCampanha(ano, dados) {
  const cli = await clienteParaOpcao(dados);
  const existe = await get('SELECT id FROM opcoes_regime WHERE cliente_id=? AND ano=?', [cli.id, ano]);
  if (existe) return { id: existe.id, ja_existia: true, pre_cadastro_criado: false };
  const r = await run(`INSERT INTO opcoes_regime (cliente_id, ano, simples_status, ibs_cbs, pendencia) VALUES (?,?,?,?,?) RETURNING id`,
    [cli.id, ano, dados.simples_status || 'nao_iniciada', dados.ibs_cbs || 'A definir', dados.pendencia || null]);
  await histOpcao(r.lastID, cli.criado ? 'Incluído na campanha (pré-cadastro criado em Clientes)' : 'Incluído na campanha');
  return { id: r.lastID, ja_existia: false, pre_cadastro_criado: cli.criado };
}

router.get('/opcoes', async (req, res) => {
  try {
    const ano = Number(req.query.ano) || new Date().getFullYear() + 1;
    const linhas = (await opc.listarCampanha(ano)).map(l => ({
      ...l, prazo_pendencia: opc.STATUS_COM_PENDENCIA.includes(l.simples_status) ? opc.prazoPendencia(l.incluido_em, ano) : null
    }));
    res.json({ ano, datas: opc.datasCampanha(ano), status: opc.STATUS, linhas, alertas: opc.montarAlertas(linhas, ano) });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.post('/opcoes', async (req, res) => {
  try {
    const ano = Number(req.body.ano) || new Date().getFullYear() + 1;
    if (!req.body.cliente_id && !(req.body.nome||'').trim()) return res.status(400).json({erro:'Informe o nome do cliente'});
    const r = await incluirNaCampanha(ano, req.body);
    if (r.ja_existia) return res.status(409).json({erro:'Esse cliente já está na campanha', id: r.id});
    res.json(r);
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// Vários nomes de uma vez (um por linha) com a mesma situação inicial
router.post('/opcoes/lote', async (req, res) => {
  try {
    const ano = Number(req.body.ano) || new Date().getFullYear() + 1;
    const nomes = (req.body.nomes||[]).map(n => String(n).trim()).filter(Boolean);
    let incluidos = 0, pre = 0, repetidos = 0;
    for (const nome of nomes) {
      const r = await incluirNaCampanha(ano, { nome, simples_status: req.body.simples_status, ibs_cbs: req.body.ibs_cbs });
      if (r.ja_existia) repetidos++; else incluidos++;
      if (r.pre_cadastro_criado) pre++;
    }
    res.json({ incluidos, pre_cadastros: pre, repetidos });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// Traz todos os clientes do Simples Nacional que ainda não estão na campanha
router.post('/opcoes/importar-simples', async (req, res) => {
  try {
    const ano = Number(req.body.ano) || new Date().getFullYear() + 1;
    const cls = await all(`SELECT id FROM clientes WHERE ativo=1 AND regime='Simples Nacional'
      AND id NOT IN (SELECT cliente_id FROM opcoes_regime WHERE ano=?)`, [ano]);
    for (const c of cls) await incluirNaCampanha(ano, { cliente_id: c.id });
    res.json({ incluidos: cls.length });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

router.get('/opcoes/:id/historico', async (req, res) => {
  try { res.json(await all('SELECT * FROM opcoes_historico WHERE opcao_id=? ORDER BY criado_em DESC', [req.params.id])); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

router.put('/opcoes/:id', async (req, res) => {
  try {
    const atual = await get(`SELECT o.*, to_char(o.incluido_em,'YYYY-MM-DD') AS incluido_em, c.nome AS cliente_nome, c.cnpj FROM opcoes_regime o JOIN clientes c ON c.id=o.cliente_id WHERE o.id=?`, [req.params.id]);
    if (!atual) return res.status(404).json({erro:'Registro não encontrado'});
    const b = req.body, mud = [];
    for (const k of Object.keys(OPC_CAMPOS)) {
      if (b[k] === undefined) continue;
      const antes = atual[k] ?? '';
      const depois = b[k] ?? '';
      if (String(antes) !== String(depois)) mud.push(`${OPC_ROTULO[k]}: ${OPC_CAMPOS[k](antes)} → ${OPC_CAMPOS[k](depois)}`);
    }
    await run(`UPDATE opcoes_regime SET simples_status=?, pendencia=?, pendencia_orgao=?, ibs_cbs=?, decisao=?, protocolo=?, incluido_em=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`,
      [b.simples_status ?? atual.simples_status, b.pendencia ?? atual.pendencia, b.pendencia_orgao ?? atual.pendencia_orgao,
       b.ibs_cbs ?? atual.ibs_cbs, b.decisao ?? atual.decisao, b.protocolo ?? atual.protocolo, b.incluido_em || atual.incluido_em, req.params.id]);
    // Nome e CNPJ ficam no cadastro do cliente
    if ((b.nome && b.nome.trim() !== atual.cliente_nome) || (b.cnpj !== undefined && b.cnpj !== (atual.cnpj||''))) {
      await run('UPDATE clientes SET nome=?, cnpj=? WHERE id=?', [(b.nome||atual.cliente_nome).trim(), b.cnpj ?? atual.cnpj, atual.cliente_id]);
      if (b.nome && b.nome.trim() !== atual.cliente_nome) mud.push(`Nome: ${atual.cliente_nome} → ${b.nome.trim()}`);
      if (b.cnpj !== undefined && b.cnpj !== (atual.cnpj||'')) mud.push('CNPJ: ' + (b.cnpj || '(removido)'));
    }
    for (const m of mud) await histOpcao(req.params.id, m);
    res.json({ mensagem:'Alterações salvas', alteracoes: mud.length });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// Tira da campanha (o cliente continua cadastrado)
router.delete('/opcoes/:id', async (req, res) => {
  try { await run('DELETE FROM opcoes_regime WHERE id=?', [req.params.id]); res.json({mensagem:'Removido da campanha'}); }
  catch(e) { res.status(500).json({erro: e.message}); }
});

module.exports = router;
