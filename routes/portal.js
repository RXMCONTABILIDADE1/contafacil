// PORTAL DO CLIENTE — acesso por link pessoal (sem login).
// O link tem 48 caracteres aleatórios e funciona como senha: quem tem o link vê as obrigações e os documentos
// daquele cliente. Por isso o escritório pode desativar ou renovar o link a qualquer momento.
const express = require('express');
const path = require('path');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { enviarArquivo } = require('../services/docs');

const TOKEN_RE = /^[a-f0-9]{48}$/;
const idOk = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const ua = req => String(req.headers['user-agent'] || '').slice(0, 300);

// Cabeçalhos de privacidade: não indexar, não guardar em cache, não vazar o link por referência.
router.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Limite simples por IP (90 pedidos por minuto) contra tentativas em massa.
const janela = new Map();
router.use((req, res, next) => {
  const ip = req.ip || 'desconhecido';
  const agora = Date.now();
  let e = janela.get(ip);
  if (!e || agora - e.t > 60000) { e = { t: agora, n: 0 }; janela.set(ip, e); }
  if (++e.n > 90) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto.' });
  next();
});
const limpeza = setInterval(() => { const a = Date.now(); for (const [k, v] of janela) if (a - v.t > 120000) janela.delete(k); }, 300000);
if (limpeza.unref) limpeza.unref();

async function clientePorToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return get('SELECT id, nome FROM clientes WHERE portal_token=? AND ativo=1', [token]);
}
const naoEncontrado = res => res.status(404).json({ erro: 'Link inválido ou desativado. Peça um novo link ao escritório.' });

router.get('/api/:token/dados', async (req, res) => {
  try {
    const cli = await clientePorToken(req.params.token);
    if (!cli) return naoEncontrado(res);
    const tarefas = await all(`SELECT nome, competencia, to_char(vencimento,'YYYY-MM-DD') AS vencimento, status
      FROM tarefas
      WHERE cliente_id=? AND vencimento >= CURRENT_DATE - INTERVAL '90 days' AND vencimento <= CURRENT_DATE + INTERVAL '60 days'
      ORDER BY vencimento DESC LIMIT 100`, [cli.id]);
    const documentos = await all(`SELECT id, nome, descricao, competencia, tamanho, publicado_em, visualizado_em, confirmado_em
      FROM documentos WHERE cliente_id=? ORDER BY publicado_em DESC, id DESC LIMIT 100`, [cli.id]);
    const cfg = await get('SELECT email_escritorio FROM config_email WHERE id=1');
    res.json({ cliente: { nome: cli.nome }, tarefas, documentos, contato: cfg?.email_escritorio || '' });
  } catch (e) { res.status(500).json({ erro: 'Não foi possível carregar. Tente novamente.' }); }
});

router.get('/api/:token/documentos/:id', async (req, res) => {
  try {
    const cli = await clientePorToken(req.params.token);
    if (!cli) return naoEncontrado(res);
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Documento inválido' });
    const doc = await get('SELECT id, nome, conteudo FROM documentos WHERE id=? AND cliente_id=?', [id, cli.id]);
    if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
    await run('UPDATE documentos SET visualizado_em = COALESCE(visualizado_em, CURRENT_TIMESTAMP) WHERE id=?', [id]);
    await run('INSERT INTO documentos_log (documento_id, acao, ip, user_agent) VALUES (?,?,?,?)', [id, 'baixado', req.ip, ua(req)]);
    enviarArquivo(res, doc, { ver: req.query.ver === '1' });
  } catch (e) { res.status(500).json({ erro: 'Não foi possível abrir o documento.' }); }
});

router.post('/api/:token/documentos/:id/confirmar', async (req, res) => {
  try {
    const cli = await clientePorToken(req.params.token);
    if (!cli) return naoEncontrado(res);
    const id = idOk(req.params.id); if (!id) return res.status(400).json({ erro: 'Documento inválido' });
    const doc = await get('SELECT id, nome, confirmado_em FROM documentos WHERE id=? AND cliente_id=?', [id, cli.id]);
    if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
    if (doc.confirmado_em) return res.json({ ok: true, ja_confirmado: true, confirmado_em: doc.confirmado_em });

    const r = await run(`UPDATE documentos SET confirmado_em=CURRENT_TIMESTAMP, confirmado_ip=?, confirmado_ua=?,
        visualizado_em = COALESCE(visualizado_em, CURRENT_TIMESTAMP)
      WHERE id=? AND confirmado_em IS NULL RETURNING confirmado_em`, [req.ip, ua(req), id]);
    await run('INSERT INTO documentos_log (documento_id, acao, ip, user_agent) VALUES (?,?,?,?)', [id, 'confirmado', req.ip, ua(req)]);
    await run('INSERT INTO notificacoes (titulo, mensagem, tipo) VALUES (?,?,?)',
      [`${cli.nome} confirmou o recebimento`, `Documento: ${doc.nome}`, 'ok']);
    res.json({ ok: true, confirmado_em: r.rows[0]?.confirmado_em });
  } catch (e) { res.status(500).json({ erro: 'Não foi possível confirmar. Tente novamente.' }); }
});

// A página do portal (o conteúdo vem das rotas acima, que validam o link)
router.get('/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'portal.html'));
});

module.exports = router;
