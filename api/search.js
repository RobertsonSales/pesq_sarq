// api/search.js - VERSÃO CORRIGIDA
const normalizeText = (value = '') =>
  value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const onlyDigits = (value = '') => value.toString().replace(/\D/g, '');

const buildSearchableText = (result = {}) => {
  const title = result.title || '';
  const url = result.url || '';
  const text = result.text || '';
  const highlights = Array.isArray(result.highlights) ? result.highlights.join(' ') : '';
  const combined = `${title} ${url} ${text} ${highlights}`;
  return {
    normalized: normalizeText(combined),
    digits: onlyDigits(combined),
  };
};

// CORREÇÃO: Scoring mais flexível para aceitar resultados parciais
const scoreResult = (result, filters = {}) => {
  const searchable = buildSearchableText(result);
  const cpfDigits = onlyDigits(filters.cpf);
  const birthDate = normalizeText(filters.dataNasc || '');
  const birthDateDigits = onlyDigits(filters.dataNasc || '');
  const motherName = normalizeText(filters.nomeMae || '');
  const fullName = normalizeText(filters.nome || '');
  const location = normalizeText(filters.localizacao || '');

  // Extrai partes do nome para matching parcial
  const nameParts = fullName.split(' ').filter(p => p.length > 2);
  const motherParts = motherName.split(' ').filter(p => p.length > 2);

  const matches = {
    nome: fullName ? searchable.normalized.includes(fullName) : false,
    nomeParcial: nameParts.length > 0 ? nameParts.some(part => searchable.normalized.includes(part)) : false,
    cpf: cpfDigits ? searchable.digits.includes(cpfDigits) : false,
    cpfParcial: cpfDigits && cpfDigits.length >= 4 ? searchable.digits.includes(cpfDigits.slice(-4)) : false, // últimos 4 dígitos
    dataNasc: birthDate ? (searchable.normalized.includes(birthDate) || searchable.normalized.includes(birthDate.replace(/\//g, '-'))) : false,
    dataNascDigits: birthDateDigits ? searchable.digits.includes(birthDateDigits) : false,
    nomeMae: motherName ? searchable.normalized.includes(motherName) : false,
    nomeMaeParcial: motherParts.length > 0 ? motherParts.some(part => searchable.normalized.includes(part)) : false,
    localizacao: false,
  };

  if (location) {
    const locationParts = location
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    matches.localizacao = locationParts.length > 0 && locationParts.some((part) => searchable.normalized.includes(part));
  }

  let score = 0;
  if (matches.nome) score += 10;
  else if (matches.nomeParcial) score += 5; // nome parcial ainda vale
  
  if (matches.cpf) score += 15;
  else if (matches.cpfParcial) score += 3; // últimos dígitos do CPF
  
  if (matches.dataNasc || matches.dataNascDigits) score += 8;
  if (matches.nomeMae) score += 12;
  else if (matches.nomeMaeParcial) score += 4; // nome da mãe parcial
  if (matches.localizacao) score += 3;

  // CRÍTICO: Aceitar se tiver nome + qualquer outra coisa, ou score >= 5
  const accepted = Boolean(
    matches.nome || matches.nomeParcial || // aceita nome completo ou parcial
    matches.cpf || matches.cpfParcial ||
    score >= 5 // threshold mais baixo
  );

  return {
    accepted,
    score,
    matches,
  };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { query, filters = {} } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Campo "query" é obrigatório.' });
  }

  const EXA_API_KEY = process.env.EXA_API_KEY;

  if (!EXA_API_KEY) {
    console.error('Chave da API Exa não configurada no ambiente.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta: chave da API não encontrada.' });
  }

  try {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        query,
        numResults: 15, // Aumentado de 12 para 15
        useAutoprompt: true, // CORREÇÃO: Habilitar autoprompt para melhorar resultados
        contents: {
          highlights: { maxCharacters: 1200, numSentences: 3 }, // Aumentado
          text: { maxCharacters: 1500 }, // Adicionado limite de texto
        },
        type: 'neural',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro da API Exa: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const originalResults = Array.isArray(data.results) ? data.results : [];

    // Se não houver filtros, retorna tudo
    if (!filters.nome && !filters.cpf) {
      return res.status(200).json({
        ...data,
        originalCount: originalResults.length,
        filteredOut: 0,
        results: originalResults,
      });
    }

    const filteredResults = originalResults
      .map((result) => {
        const validation = scoreResult(result, filters);
        return {
          ...result,
          matchScore: validation.score,
          matchedSignals: validation.matches,
          accepted: validation.accepted,
        };
      })
      .filter((result) => result.accepted)
      .sort((a, b) => b.matchScore - a.matchScore);

    // Se filtros eliminaram tudo, retorna os top 5 originais com score baixo
    const finalResults = filteredResults.length > 0 
      ? filteredResults 
      : originalResults.slice(0, 5).map(r => ({...r, matchScore: 1, accepted: true, fallback: true}));

    return res.status(200).json({
      ...data,
      originalCount: originalResults.length,
      filteredOut: originalResults.length - finalResults.length,
      results: finalResults,
    });
  } catch (error) {
    console.error('Erro na função search:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
