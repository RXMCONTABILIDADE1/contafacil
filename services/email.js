// services/email.js — Serviço de envio de e-mails via Nodemailer
const nodemailer = require('nodemailer');
const { db } = require('../db/database');

function criarTransporte() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function templateAlerta(tarefas, titulo) {
  const linhas = tarefas.map(t => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${t.nome}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${t.cliente_nome}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${t.regime}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${t.status === 'Em atraso' ? '#A32D2D' : '#854F0B'};font-weight:bold">${new Date(t.vencimento).toLocaleDateString('pt-BR')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee"><span style="background:${t.status === 'Em atraso' ? '#FCEBEB' : '#FAEEDA'};color:${t.status === 'Em atraso' ? '#A32D2D' : '#854F0B'};padding:2px 8px;border-radius:20px;font-size:12px">${t.status}</span></td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">
    <div style="background:#1D9E75;padding:20px 24px">
      <h1 style="color:#fff;margin:0;font-size:20px">ContaFácil — Alerta de Obrigações</h1>
      <p style="color:#9FE1CB;margin:4px 0 0;font-size:13px">${titulo}</p>
    </div>
    <div style="padding:24px">
      <p style="color:#333;margin-bottom:16px">Prezados,</p>
      <p style="color:#333;margin-bottom:20px">As seguintes obrigações requerem atenção imediata:</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f0faf6">
            <th style="padding:8px 12px;text-align:left;color:#0F6E56;font-weight:600">Obrigação</th>
            <th style="padding:8px 12px;text-align:left;color:#0F6E56;font-weight:600">Cliente</th>
            <th style="padding:8px 12px;text-align:left;color:#0F6E56;font-weight:600">Regime</th>
            <th style="padding:8px 12px;text-align:left;color:#0F6E56;font-weight:600">Vencimento</th>
            <th style="padding:8px 12px;text-align:left;color:#0F6E56;font-weight:600">Status</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="color:#666;font-size:12px;margin-top:24px;padding-top:16px;border-top:1px solid #eee">
        Este e-mail foi enviado automaticamente pelo sistema ContaFácil.<br>
        Acesse o sistema para atualizar os status das obrigações.
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function enviarAlertaDiario() {
  const cfg = db.prepare('SELECT * FROM config_email WHERE id = 1').get();
  if (!cfg || !cfg.ativo || !process.env.SMTP_USER) return;

  const hoje = new Date();
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + cfg.dias_antecedencia);
  const hojeStr = hoje.toISOString().split('T')[0];
  const limiteStr = limite.toISOString().split('T')[0];

  const tarefasUrgentes = db.prepare(`
    SELECT t.*, c.nome as cliente_nome, c.email as cliente_email
    FROM tarefas t
    JOIN clientes c ON t.cliente_id = c.id
    WHERE t.status != 'Concluído'
      AND (t.vencimento <= ? OR t.status = 'Em atraso')
    ORDER BY t.vencimento ASC
  `).all(limiteStr);

  if (!tarefasUrgentes.length) return;

  const transporte = criarTransporte();
  const destinatarios = [cfg.email_escritorio || process.env.EMAIL_ESCRITORIO].filter(Boolean);

  try {
    await transporte.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: destinatarios.join(', '),
      subject: `[ContaFácil] ${tarefasUrgentes.filter(t => t.status === 'Em atraso').length} obrigações em atraso · ${hoje.toLocaleDateString('pt-BR')}`,
      html: templateAlerta(tarefasUrgentes, `Relatório gerado em ${hoje.toLocaleDateString('pt-BR')} às ${hoje.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`),
    });
    console.log(`📧 E-mail de alerta enviado para: ${destinatarios.join(', ')}`);

    // Registra notificação no banco
    db.prepare('INSERT INTO notificacoes (titulo, mensagem, tipo) VALUES (?, ?, ?)').run(
      `Relatório diário enviado — ${tarefasUrgentes.length} obrigações pendentes`,
      `E-mail enviado para ${destinatarios.join(', ')}`,
      'info'
    );
  } catch (err) {
    console.error('❌ Erro ao enviar e-mail:', err.message);
  }
}

async function enviarTesteEmail(destino) {
  if (!process.env.SMTP_USER) throw new Error('SMTP não configurado no arquivo .env');
  const transporte = criarTransporte();
  await transporte.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: destino,
    subject: '[ContaFácil] Teste de configuração de e-mail',
    html: `<div style="font-family:Arial,sans-serif;padding:24px;max-width:500px">
      <h2 style="color:#1D9E75">ContaFácil — Teste de E-mail</h2>
      <p>Se você recebeu este e-mail, a configuração SMTP está funcionando corretamente!</p>
      <p style="color:#666;font-size:12px">Enviado em ${new Date().toLocaleString('pt-BR')}</p>
    </div>`,
  });
}

module.exports = { enviarAlertaDiario, enviarTesteEmail, templateAlerta };
