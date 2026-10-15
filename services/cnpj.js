// Consulta de CNPJ com várias fontes públicas: se uma falhar ou demorar, tenta a próxima.
// Devolve sempre no mesmo formato (o da BrasilAPI), com o campo `fonte` dizendo de onde veio.

const CACHE = new Map();           // cnpj -> { quando, dados }
const CACHE_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base, pesos) => {
    const s = base.split('').reduce((t, d, i) => t + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(c.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return c.endsWith(`${d1}${d2}`);
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'ContaFacil/1.0' } });
    if (r.status === 404) { const e = new Error('nao_encontrado'); e.naoEncontrado = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const simNao = v => v === true || /^(s|sim|true)$/i.test(String(v ?? '').trim()) ? true
  : (v === false || /^(n|nao|não|false)$/i.test(String(v ?? '').trim()) ? false : null);

// Ordem: as mais estáveis primeiro
const FONTES = [
  {
    nome: 'OpenCNPJ',
    url: c => `https://api.opencnpj.org/${c}`,
    norm: d => {
      const tel = Array.isArray(d.telefones) && d.telefones[0] ? `${d.telefones[0].ddd || ''}${d.telefones[0].numero || ''}` : '';
      const cnaeP = Array.isArray(d.cnaes) ? d.cnaes.find(x => x.is_principal) : null;
      return {
        cnpj: d.cnpj, razao_social: d.razao_social, nome_fantasia: d.nome_fantasia,
        descricao_situacao_cadastral: d.situacao_cadastral, municipio: d.municipio, uf: d.uf,
        cnae_fiscal_descricao: cnaeP?.descricao || '', natureza_juridica: d.natureza_juridica,
        porte: d.porte_empresa, email: d.email, ddd_telefone_1: tel,
        opcao_pelo_simples: simNao(d.opcao_simples), opcao_pelo_mei: simNao(d.opcao_mei)
      };
    }
  },
  {
    nome: 'BrasilAPI',
    url: c => `https://brasilapi.com.br/api/cnpj/v1/${c}`,
    norm: d => d
  },
  {
    nome: 'CNPJ.ws',
    url: c => `https://publica.cnpj.ws/cnpj/${c}`,
    norm: d => {
      const e = d.estabelecimento || {};
      return {
        cnpj: e.cnpj, razao_social: d.razao_social, nome_fantasia: e.nome_fantasia,
        descricao_situacao_cadastral: e.situacao_cadastral, municipio: e.cidade?.nome, uf: e.estado?.sigla,
        cnae_fiscal_descricao: e.atividade_principal?.descricao || '', natureza_juridica: d.natureza_juridica?.descricao,
        porte: d.porte?.descricao, email: e.email, ddd_telefone_1: `${e.ddd1 || ''}${e.telefone1 || ''}`,
        opcao_pelo_simples: d.simples ? simNao(d.simples.simples) : null,
        opcao_pelo_mei: d.simples ? simNao(d.simples.mei) : null
      };
    }
  },
  {
    nome: 'Minha Receita',
    url: c => `https://minhareceita.org/${c}`,
    norm: d => d
  }
];

async function consultarCnpj(cnpjBruto) {
  const c = String(cnpjBruto || '').replace(/\D/g, '');
  if (c.length !== 14) return { erro: 'Digite os 14 números do CNPJ.', status: 400 };
  if (!cnpjValido(c)) return { erro: 'Esse CNPJ não existe: os dígitos finais não conferem. Confira se foi digitado certo.', status: 400 };

  const cache = CACHE.get(c);
  if (cache && Date.now() - cache.quando < CACHE_MS) return { dados: cache.dados };

  let naoEncontrados = 0;
  const falhas = [];
  for (const f of FONTES) {
    try {
      const bruto = await getJson(f.url(c));
      const d = f.norm(bruto);
      if (!d || !d.razao_social) throw new Error('resposta sem razão social');
      const dados = { ...d, cnpj: c, fonte: f.nome };
      CACHE.set(c, { quando: Date.now(), dados });
      return { dados };
    } catch (e) {
      if (e.naoEncontrado) naoEncontrados++;
      falhas.push(`${f.nome}: ${e.name === 'AbortError' ? 'demorou demais' : e.message}`);
    }
  }
  if (naoEncontrados >= 2) return { erro: 'CNPJ não encontrado na base da Receita. Se a empresa foi aberta há poucos dias, pode ainda não aparecer.', status: 404 };
  return { erro: 'As consultas de CNPJ estão fora do ar agora. Tente de novo em instantes.', status: 503, falhas };
}

module.exports = { consultarCnpj, cnpjValido };
