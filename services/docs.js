// Utilidades de documentos (usadas pelo painel e pelo portal do cliente).
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB por arquivo

const TIPOS = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const ABRE_NO_NAVEGADOR = new Set(['pdf', 'png', 'jpg', 'jpeg']);

function extensao(nome) {
  const m = /\.([a-z0-9]+)$/i.exec(String(nome || ''));
  return m ? m[1].toLowerCase() : '';
}

function limparNome(nome) {
  const limpo = String(nome || 'arquivo')
    .replace(/[\\/\r\n"]/g, '_')
    .replace(/[^\w.\- ()\u00C0-\u00FF]/g, '_')
    .trim()
    .slice(0, 120);
  return limpo || 'arquivo';
}

// Confere se o conteúdo bate com o tipo declarado (evita arquivo disfarçado).
function assinaturaOk(ext, buf) {
  if (ext === 'pdf') return buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (ext === 'png') return buf.slice(0, 4).toString('hex') === '89504e47';
  if (ext === 'jpg' || ext === 'jpeg') return buf.slice(0, 2).toString('hex') === 'ffd8';
  if (ext === 'xlsx' || ext === 'docx') return buf.slice(0, 2).toString('latin1') === 'PK';
  return true;
}

function enviarArquivo(res, doc, { ver = false } = {}) {
  const ext = extensao(doc.nome);
  const tipo = TIPOS[ext] || 'application/octet-stream';
  const inline = ver && ABRE_NO_NAVEGADOR.has(ext);
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Length', doc.conteudo.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${limparNome(doc.nome)}"; filename*=UTF-8''${encodeURIComponent(doc.nome)}`);
  res.end(doc.conteudo);
}

module.exports = { MAX_BYTES, TIPOS, extensao, limparNome, assinaturaOk, enviarArquivo };
