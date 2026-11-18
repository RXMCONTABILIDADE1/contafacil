// DOCUMENTOS E PORTAL DO CLIENTE — lado do escritório (exige login).
// O cliente acessa por um link pessoal (ver routes/portal.js).
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { MAX_BYTES, TIPOS, extensao, limparNome, assinaturaOk, enviarArquivo } = require('../services/docs');

const idOk = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const ua = req => String(req.headers['user-agent'] || '').slice(0, 300);

async function clienteAtivo(id) {
  return get('SELECT id, nome, whatsapp, portal_token FROM clientes WHERE id=? AND ativo=1', [id]);
}

// ---------- Documentos ----------
router.get('/clientes/:id/documentos', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Cliente inválido' });
    const rows = await all(`SELECT id, tarefa_id, nome, descricao, competencia, tamanho, publicado_em,
        visualizado_em, confirmado_em
      FROM documentos WHERE cliente_id=? ORDER BY publicado_em DESC, id DESC`, [id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/clientes/:id/documentos', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Cliente inválido' });
    const cli = await clienteAtivo(id);
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado' });

    const { nome, descricao, competencia, tarefa_id, conteudo_base64 } = req.body || {};
    const nomeArq = limparNome(nome);
    const ext = extensao(nomeArq);
    if (!TIPOS[ext]) return res.status(400).json({ erro: 'Tipo de arquivo não permitido. Use: ' + Object.keys(TIPOS).join(', ') });
    if (!conteudo_base64 || typeof conteudo_base64 !== 'string') return res.status(400).json({ erro: 'Arquivo vazio' });

    const buf = Buffer.from(conteudo_base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ erro: 'Arquivo vazio' });
    if (buf.length > MAX_BYTES) return res.status(400).json({ erro: 'Arquivo maior que 5 MB' });
    if (!assinaturaOk(ext, buf)) return res.status(400).json({ erro: `O conteúdo não corresponde a um arquivo .${ext}` });

    let tarefa = null;
    if (tarefa_id) {
      const t = await get('SELECT id FROM tarefas WHERE id=? AND cliente_id=?', [idOk(tarefa_id) || 0, id]);
      if (!t) return res.status(400).json({ erro: 'Tarefa não pertence a este cliente' });
      tarefa = t.id;
    }

    const r = await run(`INSERT INTO documentos (cliente_id, tarefa_id, nome, descricao, competencia, mime, tamanho, conteudo)
      VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      [id, tarefa, nomeArq, String(descricao || '').slice(0, 200), String(competencia || '').slice(0, 20), TIPOS[ext], buf.length, buf]);
    const docId = r.lastID;
    await run('INSERT INTO documentos_log (documento_id, acao, ip, user_agent) VALUES (?,?,?,?)', [docId, 'enviado', req.ip, ua(req)]);
    res.json({ id: docId, mensagem: 'Documento enviado' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/documentos/:id/arquivo', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Documento inválido' });
    const doc = await get('SELECT nome, conteudo FROM documentos WHERE id=?', [id]);
    if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
    enviarArquivo(res, doc, { ver: req.query.ver === '1' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/documentos/:id/protocolo', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Documento inválido' });
    const doc = await get(`SELECT d.id, d.nome, d.descricao, d.competencia, d.tamanho, d.publicado_em,
        d.visualizado_em, d.confirmado_em, d.confirmado_ip, d.confirmado_ua, c.nome AS cliente_nome, c.cnpj AS cliente_cnpj
      FROM documentos d JOIN clientes c ON c.id = d.cliente_id WHERE d.id=?`, [id]);
    if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
    const log = await all('SELECT acao, ip, criado_em FROM documentos_log WHERE documento_id=? ORDER BY id', [id]);
    res.json({ documento: doc, log });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/documentos/:id', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Documento inválido' });
    await run('DELETE FROM documentos WHERE id=?', [id]);
    res.json({ mensagem: 'Documento removido' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- Link do portal ----------
router.get('/clientes/:id/portal', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Cliente inválido' });
    const cli = await clienteAtivo(id);
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado' });
    res.json({ token: cli.portal_token || null, whatsapp: cli.whatsapp || '' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/clientes/:id/portal/gerar', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Cliente inválido' });
    const cli = await clienteAtivo(id);
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado' });
    if (cli.portal_token && !req.body?.renovar) return res.json({ token: cli.portal_token });
    const token = crypto.randomBytes(24).toString('hex'); // 48 caracteres, impossível de adivinhar
    await run('UPDATE clientes SET portal_token=? WHERE id=?', [token, id]);
    res.json({ token });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/clientes/:id/portal', async (req, res) => {
  try {
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Cliente inválido' });
    await run('UPDATE clientes SET portal_token=NULL WHERE id=?', [id]);
    res.json({ mensagem: 'Link do portal desativado' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// CENTRAL DE ALERTAS (documentos)
router.get('/alertas/documentos', async (req, res) => {
  try {
    const nao_vistos = await all(`SELECT d.id, d.nome, d.publicado_em, c.id AS cliente_id, c.nome AS cliente_nome
      FROM documentos d JOIN clientes c ON c.id=d.cliente_id AND c.ativo=1
      WHERE d.visualizado_em IS NULL ORDER BY d.publicado_em ASC LIMIT 15`);
    const sem_confirmar = await all(`SELECT d.id, d.nome, d.publicado_em, d.visualizado_em, c.id AS cliente_id, c.nome AS cliente_nome
      FROM documentos d JOIN clientes c ON c.id=d.cliente_id AND c.ativo=1
      WHERE d.visualizado_em IS NOT NULL AND d.confirmado_em IS NULL ORDER BY d.publicado_em ASC LIMIT 15`);
    const confirmados = await all(`SELECT d.id, d.nome, d.confirmado_em, c.nome AS cliente_nome
      FROM documentos d JOIN clientes c ON c.id=d.cliente_id AND c.ativo=1
      WHERE d.confirmado_em IS NOT NULL ORDER BY d.confirmado_em DESC LIMIT 5`);
    res.json({ nao_vistos, sem_confirmar, confirmados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
