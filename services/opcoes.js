// Regras de prazo da campanha anual de opções (Simples Nacional + IBS/CBS)
const { run, get, all } = require('../db/database');

const STATUS = {
  nao_iniciada: 'Não iniciada',
  solicitada: 'Aguardando análise',
  pendencia: 'Pendência aberta',
  pendencia_cliente: 'Pendência enviada ao cliente',
  deferida: 'Deferida',
  indeferida: 'Indeferida'
};
const STATUS_COM_PENDENCIA = ['pendencia', 'pendencia_cliente'];
const DIAS_PENDENCIA = 26;

function iso(d) { return d.toISOString().split('T')[0]; }
function soData(v) { return (v instanceof Date ? iso(v) : String(v)).split('T')[0]; }

// Datas-chave da campanha para o ano-calendário `ano` (ex.: 2027 → prazos em 2026)
function datasCampanha(ano) {
  const a = Number(ano) - 1;
  return {
    prazoOpcao: `${a}-09-30`,
    limitePendencia: `${a}-10-30`,
    decisao: `${a}-11-20`
  };
}

// Prazo de regularização: inclusão + 26 dias, nunca depois de 30/10
function prazoPendencia(incluidoEm, ano) {
  const d = new Date(soData(incluidoEm) + 'T12:00:00');
  d.setDate(d.getDate() + DIAS_PENDENCIA);
  const calc = iso(d);
  const lim = datasCampanha(ano).limitePendencia;
  return calc > lim ? lim : calc;
}

function diasAte(dataIso) {
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hoje.setHours(12, 0, 0, 0);
  return Math.round((new Date(dataIso + 'T12:00:00') - hoje) / 86400000);
}

function montarAlertas(linhas, ano) {
  const dc = datasCampanha(ano);
  const alertas = [];
  const semOpcao = linhas.filter(l => l.simples_status === 'nao_iniciada');
  const dOp = diasAte(dc.prazoOpcao);
  if (semOpcao.length && dOp >= 0)
    alertas.push({ nivel: dOp <= 5 ? 'critico' : 'atencao', data: dc.prazoOpcao, dias: dOp,
      texto: `${semOpcao.length} cliente(s) sem opção feita: ${semOpcao.map(l => l.cliente_nome).join(', ')}` });
  linhas.filter(l => STATUS_COM_PENDENCIA.includes(l.simples_status)).forEach(l => {
    const pz = prazoPendencia(l.incluido_em, ano), d = diasAte(pz);
    alertas.push({ nivel: d <= 5 ? 'critico' : 'atencao', data: pz, dias: d, opcao_id: l.id,
      texto: `${l.cliente_nome}: regularizar pendência${l.pendencia ? ' (' + l.pendencia + ')' : ''}` });
  });
  const regular = linhas.filter(l => l.ibs_cbs === 'Regular' && l.decisao === 'A decidir');
  const dDec = diasAte(dc.decisao);
  if (regular.length && dDec >= 0)
    alertas.push({ nivel: dDec <= 10 ? 'critico' : 'info', data: dc.decisao, dias: dDec,
      texto: `Decidir se ${regular.length} cliente(s) no Regular continuam no Regular ou cancelam a opção` });
  const semIbs = linhas.filter(l => l.ibs_cbs === 'A definir');
  if (semIbs.length)
    alertas.push({ nivel: 'atencao', data: dc.prazoOpcao, dias: dOp,
      texto: `${semIbs.length} cliente(s) sem escolha de IBS/CBS: ${semIbs.map(l => l.cliente_nome).join(', ')}` });
  return alertas.sort((a, b) => a.data.localeCompare(b.data));
}

async function listarCampanha(ano) {
  return all(`SELECT o.*, to_char(o.incluido_em,'YYYY-MM-DD') AS incluido_em, c.nome AS cliente_nome, c.cnpj, c.pre_cadastro
              FROM opcoes_regime o JOIN clientes c ON c.id = o.cliente_id
              WHERE o.ano = ? AND c.ativo = 1 ORDER BY c.nome`, [ano]);
}

// Roda todo dia às 7h: gera notificações quando faltam 5, 1 ou 0 dias (e 10 dias para a decisão de 20/11)
async function gerarNotificacoesOpcoes() {
  const hoje = new Date();
  const anos = [hoje.getFullYear() + 1, hoje.getFullYear()];
  for (const ano of anos) {
    const linhas = await listarCampanha(ano);
    if (!linhas.length) continue;
    for (const a of montarAlertas(linhas, ano)) {
      const marcos = a.texto.startsWith('Decidir') ? [10, 5, 1, 0] : [5, 1, 0];
      if (!marcos.includes(a.dias)) continue;
      const titulo = `Opções ${ano}: ${a.dias === 0 ? 'vence HOJE' : 'faltam ' + a.dias + ' dia(s)'}`;
      const ja = await get(`SELECT id FROM notificacoes WHERE titulo=? AND mensagem=? AND criado_em::date = CURRENT_DATE`, [titulo, a.texto]);
      if (!ja) await run(`INSERT INTO notificacoes (titulo, mensagem, tipo) VALUES (?,?,?) RETURNING id`, [titulo, a.texto, 'alerta']);
    }
  }
}

module.exports = { STATUS, STATUS_COM_PENDENCIA, datasCampanha, prazoPendencia, montarAlertas, listarCampanha, gerarNotificacoesOpcoes };
