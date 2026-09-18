// Integração com o Webservice NFeDistribuicaoDFe (Ambiente Nacional da SEFAZ)
// Busca as NF-e emitidas contra o CNPJ do cliente, usando o certificado A1 dele.
// Referência: Nota Técnica 2014.002. O serviço é nacional (cUFAutor=91) e cobre
// automaticamente qualquer estado emissor — não é preciso escolher UF.

const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');
const { run, get } = require('../db/database');

const ALGO = 'aes-256-gcm';

// tpAmb: 1 = Produção, 2 = Homologação. Controlado por variável de ambiente.
const AMBIENTE = process.env.SEFAZ_AMBIENTE === 'homologacao' ? '2' : '1';
const HOST_PRODUCAO = 'www1.nfe.fazenda.gov.br';
const HOST_HOMOLOGACAO = 'hom1.nfe.fazenda.gov.br';
const CAMINHO = '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';

// Código IBGE da UF — usado no cUFAutor (é a UF do CNPJ consultado, não um código "nacional")
const UF_PARA_CODIGO = {
  AC:'12', AL:'27', AP:'16', AM:'13', BA:'29', CE:'23', DF:'53', ES:'32', GO:'52',
  MA:'21', MT:'51', MS:'50', MG:'31', PA:'15', PB:'25', PR:'41', PE:'26', PI:'22',
  RJ:'33', RN:'24', RO:'11', RR:'14', RS:'43', SC:'42', SE:'28', SP:'35', TO:'17'
};

// --- Criptografia do certificado/senha em repouso (AES-256-GCM) ---

function chaveMestra() {
  const segredo = process.env.CERT_MASTER_KEY || process.env.SESSION_SECRET || 'contafacil-secret-2024';
  return crypto.createHash('sha256').update(segredo).digest();
}

function criptografar(valor) {
  const dado = Buffer.isBuffer(valor) ? valor : Buffer.from(String(valor), 'utf8');
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv(ALGO, chaveMestra(), iv);
  const cifrado = Buffer.concat([cifra.update(dado), cifra.final()]);
  const tag = cifra.getAuthTag();
  return Buffer.concat([iv, tag, cifrado]).toString('base64');
}

function descriptografar(base64) {
  const dado = Buffer.from(base64, 'base64');
  const iv = dado.subarray(0, 12);
  const tag = dado.subarray(12, 28);
  const cifrado = dado.subarray(28);
  const decifra = crypto.createDecipheriv(ALGO, chaveMestra(), iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(cifrado), decifra.final()]);
}

// --- Cadastro do certificado do cliente ---

async function salvarCertificado(clienteId, pfxBase64, senha) {
  if (!pfxBase64 || !senha) throw new Error('Certificado (.pfx) e senha são obrigatórios');
  const pfxBuffer = Buffer.from(pfxBase64, 'base64');

  // valida se o .pfx + senha realmente abrem, antes de gravar
  try {
    tls.createSecureContext({ pfx: pfxBuffer, passphrase: senha });
  } catch (e) {
    throw new Error('Não foi possível abrir o certificado com a senha informada: ' + e.message);
  }

  const pfxCifrado = criptografar(pfxBuffer);
  const senhaCifrada = criptografar(senha);

  const existente = await get('SELECT id FROM certificados_digitais WHERE cliente_id=?', [clienteId]);
  if (existente) {
    await run(
      'UPDATE certificados_digitais SET pfx_encrypted=?, senha_encrypted=?, ultimo_nsu=?, ultima_sincronizacao=NULL WHERE cliente_id=?',
      [pfxCifrado, senhaCifrada, '0', clienteId]
    );
  } else {
    await run(
      'INSERT INTO certificados_digitais (cliente_id, pfx_encrypted, senha_encrypted) VALUES (?,?,?)',
      [clienteId, pfxCifrado, senhaCifrada]
    );
  }
}

// --- Montagem e chamada do webservice ---

function extrairTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function montarXmlConsulta(cnpj, ultNsu, uf) {
  const nsuFormatado = String(ultNsu || '0').replace(/\D/g, '').padStart(15, '0');
  const cUFAutor = UF_PARA_CODIGO[String(uf || '').toUpperCase()];
  if (!cUFAutor) throw new Error('Cliente sem UF cadastrado (ou UF inválido) — necessário para consultar a SEFAZ. Edite o cliente e refaça a busca por CNPJ.');
  return `<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">` +
    `<tpAmb>${AMBIENTE}</tpAmb>` +
    `<cUFAutor>${cUFAutor}</cUFAutor>` +
    `<CNPJ>${String(cnpj).replace(/\D/g, '')}</CNPJ>` +
    `<distNSU><ultNSU>${nsuFormatado}</ultNSU></distNSU>` +
    `</distDFeInt>`;
}

function chamarSefaz(pfxBuffer, senha, xmlConsulta) {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<nfeDadosMsg>${xmlConsulta}</nfeDadosMsg>` +
    `</nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;

  const host = AMBIENTE === '1' ? HOST_PRODUCAO : HOST_HOMOLOGACAO;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: CAMINHO,
      method: 'POST',
      pfx: pfxBuffer,
      passphrase: senha,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(envelope)
      },
      timeout: 30000
    }, (resposta) => {
      const partes = [];
      resposta.on('data', c => partes.push(c));
      resposta.on('end', () => resolve({ status: resposta.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao consultar a SEFAZ (30s)')));
    req.on('error', (e) => {
      if (e.code === 'EPROTO' || /decrypt|password|mac verify failed/i.test(e.message)) {
        return reject(new Error('Senha do certificado incorreta ou certificado corrompido'));
      }
      reject(e);
    });
    req.write(envelope);
    req.end();
  });
}

// --- Sincronização das notas de um cliente ---

async function sincronizarNotas(cliente) {
  if (!cliente?.cnpj) throw new Error('Cliente sem CNPJ cadastrado');

  const cert = await get('SELECT * FROM certificados_digitais WHERE cliente_id=?', [cliente.id]);
  if (!cert) throw new Error('Nenhum certificado digital vinculado a este cliente ainda');

  const pfxBuffer = descriptografar(cert.pfx_encrypted);
  const senha = descriptografar(cert.senha_encrypted).toString('utf8');

  const xmlConsulta = montarXmlConsulta(cliente.cnpj, cert.ultimo_nsu, cliente.uf);
  const { status, corpo } = await chamarSefaz(pfxBuffer, senha, xmlConsulta);

  if (status !== 200) {
    const falha = extrairTag(corpo, 'faultstring') || `HTTP ${status}`;
    throw new Error('Falha na comunicação com a SEFAZ: ' + falha);
  }

  const cStat = extrairTag(corpo, 'cStat');
  const xMotivo = extrairTag(corpo, 'xMotivo');

  // 137 = nenhum documento novo · 138 = documento(s) localizado(s) — ambos são sucesso
  if (cStat && !['137', '138'].includes(cStat)) {
    throw new Error(`SEFAZ retornou ${cStat}: ${xMotivo || 'erro desconhecido'} | XML enviado: ${xmlConsulta} | Resposta bruta: ${corpo.substring(0, 800)}`);
  }

  const ultNSU = extrairTag(corpo, 'ultNSU') || cert.ultimo_nsu;
  const maxNSU = extrairTag(corpo, 'maxNSU');
  const docZips = [...corpo.matchAll(/<docZip[^>]*NSU="(\d+)"[^>]*>([^<]+)<\/docZip>/g)];

  let novas = 0;
  for (const [, nsuDoc, base64] of docZips) {
    let xmlDoc;
    try {
      xmlDoc = zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
    } catch {
      continue; // docZip corrompido/ilegível, ignora e segue
    }

    const chave = extrairTag(xmlDoc, 'chNFe');
    if (!chave) continue; // por ora só processamos resNFe (resEvento não tem chNFe)

    const jaExiste = await get('SELECT id FROM notas_fiscais WHERE chave=?', [chave]);
    if (jaExiste) continue;

    const tipo = xmlDoc.includes('<resNFe') ? 'resNFe' : 'resEvento';
    const cnpjEmit = extrairTag(xmlDoc, 'CNPJ');
    const nomeEmit = extrairTag(xmlDoc, 'xNome');
    const valor = parseFloat(extrairTag(xmlDoc, 'vNF') || '0');
    const dataEmissao = extrairTag(xmlDoc, 'dhEmi');
    const situacao = extrairTag(xmlDoc, 'cSitConf');

    await run(
      `INSERT INTO notas_fiscais (cliente_id, chave, nsu, tipo, cnpj_emitente, nome_emitente, valor, data_emissao, situacao)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [cliente.id, chave, nsuDoc, tipo, cnpjEmit, nomeEmit, valor, dataEmissao, situacao]
    );
    novas++;
  }

  await run(
    'UPDATE certificados_digitais SET ultimo_nsu=?, ultima_sincronizacao=CURRENT_TIMESTAMP WHERE cliente_id=?',
    [ultNSU, cliente.id]
  );

  const resumo = await get(
    "SELECT COUNT(*)::int as total, COALESCE(SUM(valor),0) as valor_total FROM notas_fiscais WHERE cliente_id=?",
    [cliente.id]
  );

  return {
    mensagem: novas > 0
      ? `${novas} nota(s) nova(s) encontrada(s)`
      : `Nenhuma nota nova — SEFAZ: cStat ${cStat} (${xMotivo}) | docs no lote: ${docZips.length} | ultNSU: ${ultNSU} | maxNSU: ${maxNSU}`,
    notasNovas: novas,
    totalNotas: resumo.total,
    valorTotal: Number(resumo.valor_total)
  };
}

module.exports = { salvarCertificado, sincronizarNotas };
