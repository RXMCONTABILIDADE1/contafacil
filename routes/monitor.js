// MONITOR FISCAL — situação cadastral + Simples/MEI de cada cliente, comparando com a consulta anterior.
// Fonte: base pública de CNPJ da Receita (OpenCNPJ; se falhar, usa as fontes reserva de services/cnpj.js).
// Limites (a tela avisa): só mostra o que JÁ aconteceu, com defasagem de até ~1 mês; não traz "Eventos Futuros".
// Campo vazio na base = "sem informação", NUNCA "não optante".

const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { consultarCnpj, cnpjValido } = require('../services/cnpj');

// ---------- tabelas (criadas sozinhas na primeira vez que o monitor é usado) ----------
let tabelasProntas = null;
function garantirTabelas() {
  if (!tabelasProntas) {
    tabelasProntas = (async () => {
      await run(`CREATE TABLE IF NOT EXISTS monitor_fiscal (
        cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
        cnpj TEXT,
        razao_social TEXT,
        situacao_cadastral TEXT,
        opcao_simples TEXT,
        data_opcao_simples TEXT,
        data_exclusao_simples TEXT,
        opcao_mei TEXT,
        data_exclusao_mei TEXT,
        fonte TEXT,
        consultado_em TIMESTAMP,
        erro TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS monitor_fiscal_mudancas (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        tipo TEXT,
        descricao TEXT,
        grave INTEGER DEFAULT 0,
        detectado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    })().catch(e => { tabelasProntas = null; throw e; });
  }
  return tabelasProntas;
}

// ---------- normalização dos dados ----------
const so14 = v => String(v || '').replace(/\D/g, '');

// 'S' / 'N' / '' (vazio = sem informação)
function sn(v) {
  if (v === true) return 'S';
  if (v === false) return 'N';
  const t = String(v ?? '').trim().toLowerCase();
  if (t === 's' || t === 'sim' || t === 'true') return 'S';
  if (t === 'n' || t === 'nao' || t === 'não' || t === 'false') return 'N';
  return '';
}

// 'AAAA-MM-DD' ou '' ('0000-00-00' e lixo viram vazio)
function dataOk(v) {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s !== '0000-00-00' ? s : '';
}

const dataBR = s => { const [y, m, d] = String(s || '').split('-'); return d ? `${d}/${m}/${y}` : '—'; };

async function getJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'ContaFacil/1.0' } });
    if (r.status === 404) { const e = new Error('nao_encontrado'); e.naoEncontrado = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Devolve os dados já normalizados, ou { erro }
async function buscarDados(cnpj) {
  try {
    const d = await getJson(`https://api.opencnpj.org/${cnpj}`);
    if (!d || !d.razao_social) throw new Error('resposta sem razão social');
    return {
      fonte: 'OpenCNPJ', completo: true,
      razao_social: d.razao_social,
      situacao_cadastral: String(d.situacao_cadastral || '').trim().toUpperCase(),
      opcao_simples: sn(d.opcao_simples),
      data_opcao_simples: dataOk(d.data_opcao_simples),
      data_exclusao_simples: dataOk(d.data_exclusao_simples),
      opcao_mei: sn(d.opcao_mei),
      data_exclusao_mei: dataOk(d.data_exclusao_mei)
    };
  } catch (_) {
    // reserva: serviço de CNPJ que já existe no sistema (outras fontes, sem as datas de exclusão)
    const r = await consultarCnpj(cnpj);
    if (r.erro) return { erro: r.erro };
    const d = r.dados;
    return {
      fonte: d.fonte || 'reserva', completo: false,
      razao_social: d.razao_social,
      situacao_cadastral: String(d.descricao_situacao_cadastral || '').trim().toUpperCase(),
      opcao_simples: sn(d.opcao_pelo_simples),
      data_opcao_simples: '', data_exclusao_simples: '',
      opcao_mei: sn(d.opcao_pelo_mei),
      data_exclusao_mei: ''
    };
  }
}

// Se a consulta nova veio sem um dado que a anterior tinha, mantém o anterior (evita "mudança" falsa)
function mesclar(ant, novo) {
  const m = { ...novo };
  if (!ant) return m;
  if (!m.situacao_cadastral) m.situacao_cadastral = ant.situacao_cadastral || '';
  if (!m.opcao_simples && ant.opcao_simples) m.opcao_simples = ant.opcao_simples;
  if (!m.opcao_mei && ant.opcao_mei) m.opcao_mei = ant.opcao_mei;
  if (!novo.completo) { // fonte reserva não traz datas: não apaga as que já existiam
    m.data_opcao_simples = ant.data_opcao_simples || '';
    m.data_exclusao_simples = ant.data_exclusao_simples || '';
    m.data_exclusao_mei = ant.data_exclusao_mei || '';
  }
  return m;
}

// Compara a consulta anterior com a nova. Sem anterior = linha de base (não há o que comparar).
function detectarMudancas(ant, n) {
  const out = [];
  if (!ant || !ant.situacao_cadastral) return out;

  if (n.situacao_cadastral && n.situacao_cadastral !== ant.situacao_cadastral) {
    out.push({ tipo: 'situacao', grave: n.situacao_cadastral !== 'ATIVA',
      descricao: `Situação cadastral mudou: ${ant.situacao_cadastral} → ${n.situacao_cadastral}` });
  }

  const exclSimples = n.data_exclusao_simples && n.data_exclusao_simples !== (ant.data_exclusao_simples || '') ? n.data_exclusao_simples : '';
  if (ant.opcao_simples === 'S' && n.opcao_simples === 'N') {
    out.push({ tipo: 'saiu_simples', grave: true,
      descricao: `Saiu do Simples Nacional${n.data_exclusao_simples ? ' (exclusão em ' + dataBR(n.data_exclusao_simples) + ')' : ''}` });
  } else if (ant.opcao_simples === 'N' && n.opcao_simples === 'S') {
    out.push({ tipo: 'entrou_simples', grave: false, descricao: 'Passou a ser optante pelo Simples Nacional' });
  } else if (exclSimples) {
    out.push({ tipo: 'exclusao_simples', grave: true, descricao: `Data de exclusão do Simples registrada: ${dataBR(exclSimples)}` });
  }

  if (ant.opcao_mei === 'S' && n.opcao_mei === 'N') {
    out.push({ tipo: 'saiu_mei', grave: true,
      descricao: `Saiu do MEI (desenquadrado)${n.data_exclusao_mei ? ' em ' + dataBR(n.data_exclusao_mei) : ''}` });
  } else if (ant.opcao_mei === 'N' && n.opcao_mei === 'S') {
    out.push({ tipo: 'entrou_mei', grave: false, descricao: 'Passou a ser MEI' });
  }
  return out;
}

async function registrarErro(clienteId, cnpj, erro) {
  await run(`INSERT INTO monitor_fiscal (cliente_id, cnpj, erro, consultado_em) VALUES (?,?,?,NULL)
    ON CONFLICT (cliente_id) DO UPDATE SET erro = EXCLUDED.erro`, [clienteId, cnpj, erro]);
  return { ok: false, erro };
}

async function consultarCliente(cli) {
  await garantirTabelas();
  const cnpj = so14(cli.cnpj);
  if (cnpj.length !== 14) return { ok: false, sem_cnpj: true, erro: 'Cliente sem CNPJ cadastrado.' };
  if (!cnpjValido(cnpj)) return registrarErro(cli.id, cnpj, 'CNPJ inválido: os dígitos finais não conferem.');

  const dados = await buscarDados(cnpj);
  if (dados.erro) return registrarErro(cli.id, cnpj, dados.erro);

  const ant = await get('SELECT * FROM monitor_fiscal WHERE cliente_id=?', [cli.id]);
  const novo = mesclar(ant, dados);
  const linhaDeBase = !ant || !ant.situacao_cadastral;
  const mudancas = detectarMudancas(ant, novo);

  await run(`INSERT INTO monitor_fiscal
      (cliente_id, cnpj, razao_social, situacao_cadastral, opcao_simples, data_opcao_simples, data_exclusao_simples,
       opcao_mei, data_exclusao_mei, fonte, consultado_em, erro)
    VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL)
    ON CONFLICT (cliente_id) DO UPDATE SET
      cnpj = EXCLUDED.cnpj, razao_social = EXCLUDED.razao_social, situacao_cadastral = EXCLUDED.situacao_cadastral,
      opcao_simples = EXCLUDED.opcao_simples, data_opcao_simples = EXCLUDED.data_opcao_simples,
      data_exclusao_simples = EXCLUDED.data_exclusao_simples, opcao_mei = EXCLUDED.opcao_mei,
      data_exclusao_mei = EXCLUDED.data_exclusao_mei, fonte = EXCLUDED.fonte,
      consultado_em = CURRENT_TIMESTAMP, erro = NULL`,
    [cli.id, cnpj, novo.razao_social, novo.situacao_cadastral, novo.opcao_simples, novo.data_opcao_simples,
     novo.data_exclusao_simples, novo.opcao_mei, novo.data_exclusao_mei, novo.fonte]);

  for (const m of mudancas) {
    await run(`INSERT INTO monitor_fiscal_mudancas (cliente_id, tipo, descricao, grave) VALUES (?,?,?,?)`,
      [cli.id, m.tipo, m.descricao, m.grave ? 1 : 0]);
    // aviso no sino (sem repetir o mesmo aviso no mesmo dia)
    const titulo = `Monitor fiscal — ${cli.nome}`;
    const ja = await get(`SELECT id FROM notificacoes WHERE titulo=? AND mensagem=? AND criado_em::date = CURRENT_DATE`, [titulo, m.descricao]);
    if (!ja) await run(`INSERT INTO notificacoes (titulo, mensagem, tipo) VALUES (?,?,?)`, [titulo, m.descricao, m.grave ? 'atraso' : 'info']);
  }
  return { ok: true, linha_de_base: linhaDeBase, mudancas, fonte: novo.fonte };
}

// ---------- rotas (montadas em /api/monitor-fiscal) ----------
router.get('/', async (req, res) => {
  try {
    await garantirTabelas();
    const clientes = await all(`SELECT c.id, c.codigo, c.nome, c.cnpj, c.regime, c.pre_cadastro,
        m.razao_social, m.situacao_cadastral, m.opcao_simples, m.data_opcao_simples, m.data_exclusao_simples,
        m.opcao_mei, m.data_exclusao_mei, m.fonte, m.consultado_em, m.erro
      FROM clientes c LEFT JOIN monitor_fiscal m ON m.cliente_id = c.id
      WHERE c.ativo = 1 ORDER BY c.nome`);
    const corte = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const mudancas = await all(`SELECT mm.id, mm.cliente_id, mm.tipo, mm.descricao, mm.grave, mm.detectado_em, c.nome AS cliente_nome
      FROM monitor_fiscal_mudancas mm JOIN clientes c ON c.id = mm.cliente_id
      WHERE mm.detectado_em > ? ORDER BY mm.detectado_em DESC LIMIT 100`, [corte]);
    res.json({ clientes, mudancas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/consultar/:id', async (req, res) => {
  try {
    const cli = await get('SELECT id, nome, cnpj FROM clientes WHERE id=? AND ativo=1', [req.params.id]);
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado' });
    res.json(await consultarCliente(cli));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router._interno = { sn, dataOk, mesclar, detectarMudancas };
module.exports = router;
