// api/search.js
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

const scoreResult = (result, filters = {}) => {
  const searchable = buildSearchableText(result);
  const cpfDigits = onlyDigits(filters.cpf);
  const birthDate = normalizeText(filters.dataNasc || '');
  const birthDateDigits = onlyDigits(filters.dataNasc || '');
  const motherName = normalizeText(filters.nomeMae || '');
  const fullName = normalizeText(filters.nome || '');
  const location = normalizeText(filters.localizacao || '');

  const matches = {
    nome: fullName ? searchable.normalized.includes(fullName) : false,
    cpf: cpfDigits ? searchable.digits.includes(cpfDigits) : false,
    dataNasc: birthDate ? (searchable.normalized.includes(birthDate) || (birthDateDigits ? searchable.digits.includes(birthDateDigits) : false)) : false,
    nomeMae: motherName ? searchable.normalized.includes(motherName) : false,
    localizacao: false,
  };

  if (location) {
    const locationParts = location
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    matches.localizacao = locationParts.length > 0 && locationParts.every((part) => searchable.normalized.includes(part));
  }

  let score = 0;
  if (matches.nome) score += 4;
  if (matches.cpf) score += 10;
  if (matches.dataNasc) score += 5;
  if (matches.nomeMae) score += 6;
  if (matches.localizacao) score += 2;

  const accepted = Boolean(
    matches.cpf ||
      (matches.nome && matches.nomeMae) ||
      (matches.nome && matches.dataNasc) ||
      (matches.nome && matches.dataNasc && matches.localizacao) ||
      score >= 10
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
        numResults: 12,
        useAutoprompt: false,
        contents: {
          highlights: { maxCharacters: 900 },
          text: true,
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

    return res.status(200).json({
      ...data,
      originalCount: originalResults.length,
      filteredOut: Math.max(originalResults.length - filteredResults.length, 0),
      results: filteredResults,
    });
  } catch (error) {
    console.error('Erro na função search:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
