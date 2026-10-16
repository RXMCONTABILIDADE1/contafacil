// Retificações: obrigação entregue no prazo que ainda precisa ser retificada.
// A tarefa fica como Concluída (entregue) e ganha ret_status = 'Pendente' até ser marcada como 'Retificada'.
const { run, get, all } = require('../db/database');

async function listarRetificacoes(status) {
  const filtro = status === 'todas' ? `t.ret_status IS NOT NULL` : `t.ret_status = ?`;
  const params = status === 'todas' ? [] : [status || 'Pendente'];
  return all(`SELECT t.id, t.nome, t.competencia, to_char(t.vencimento,'YYYY-MM-DD') AS vencimento, t.cliente_id,
                     t.ret_status, t.ret_motivo, to_char(t.ret_prazo,'YYYY-MM-DD') AS ret_prazo,
                     to_char(t.entrega_em,'YYYY-MM-DD') AS entrega_em, t.entrega_recibo,
                     to_char(t.ret_feita_em,'YYYY-MM-DD') AS ret_feita_em, t.ret_recibo,
                     c.nome AS cliente_nome, c.codigo AS cliente_codigo
              FROM tarefas t LEFT JOIN clientes c ON c.id = t.cliente_id
              WHERE ${filtro} AND (c.ativo = 1 OR c.id IS NULL)
              ORDER BY t.ret_status, t.ret_prazo NULLS LAST, c.nome`, params);
}

// Roda todo dia às 7h: avisa quando o prazo de retificação está a 5, 1 ou 0 dias, ou venceu ontem
async function gerarNotificacoesRetificacao() {
  const pend = await all(`SELECT t.nome, t.competencia, c.nome AS cliente_nome,
                                 (t.ret_prazo - (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS dias
                          FROM tarefas t LEFT JOIN clientes c ON c.id = t.cliente_id
                          WHERE t.ret_status = 'Pendente' AND t.ret_prazo IS NOT NULL`);
  for (const p of pend) {
    const d = Number(p.dias);
    if (![5, 1, 0, -1].includes(d)) continue;
    const titulo = d < 0 ? 'Retificação: prazo vencido' : `Retificação: ${d === 0 ? 'vence HOJE' : 'faltam ' + d + ' dia(s)'}`;
    const msg = `${p.cliente_nome || 'Cliente'} — ${p.nome}${p.competencia ? ' (comp. ' + p.competencia + ')' : ''}`;
    const ja = await get(`SELECT id FROM notificacoes WHERE titulo=? AND mensagem=? AND criado_em::date = CURRENT_DATE`, [titulo, msg]);
    if (!ja) await run(`INSERT INTO notificacoes (titulo, mensagem, tipo) VALUES (?,?,?) RETURNING id`, [titulo, msg, 'alerta']);
  }
}

module.exports = { listarRetificacoes, gerarNotificacoesRetificacao };
