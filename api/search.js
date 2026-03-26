// api/search.js — ExaOSINT v3.3 (Abril 2026)
// Filtro mais equilibrado: aceita resultados com score alto ou combinações fortes

const normalizeText = (value = '') =>
  value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const onlyDigits = (value = '') => value.toString().replace(/\D/g, '');

const NAME_PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'di', 'du', 'e', 'a', 'o', 'van', 'von', 'del', 'la', 'le']);

const extractNameTokens = (fullName = '') =>
  normalizeText(fullName)
    .split(' ')
    .filter(t => t.length >= 3 && !NAME_PARTICLES.has(t));

const nameMatchResult = (searchableNormalized, fullName) => {
  if (!fullName) return { matched: false, strength: 'none' };
  const tokens = extractNameTokens(fullName);
  if (tokens.length === 0) return { matched: false, strength: 'none' };

  const present = tokens.filter(t => searchableNormalized.includes(t));
  const exactPhrase = searchableNormalized.includes(normalizeText(fullName));

  if (exactPhrase || present.length === tokens.length)
    return { matched: true, strength: 'strong' };

  if (tokens.length >= 2 && 
      searchableNormalized.includes(tokens[0]) && 
      searchableNormalized.includes(tokens[tokens.length - 1]))
    return { matched: true, strength: 'strong' };

  if (tokens.length >= 3 && present.length >= Math.ceil(tokens.length * 0.67))
    return { matched: true, strength: 'moderate' };

  return { matched: false, strength: 'none' };
};

const cpfMatchesText = (searchable, cpf) => {
  if (!cpf) return false;
  const d = onlyDigits(cpf);
  if (d.length < 11) return false;

  if (searchable.digits.includes(d)) return true;
  const fmt1 = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9,11)}`;
  if (searchable.normalized.includes(fmt1)) return true;
  const fmt2 = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)} ${d.slice(9,11)}`;
  if (searchable.normalized.includes(fmt2)) return true;
  if (d.length >= 9 && searchable.digits.includes(d.slice(0,9))) return true;
  return false;
};

const MESES_PT = ['', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const dateMatchesText = (searchable, dataNasc) => {
  if (!dataNasc) return false;
  const norm = normalizeText(dataNasc);
  if (searchable.normalized.includes(norm)) return true;

  const digits = onlyDigits(dataNasc);
  if (digits.length === 8 && searchable.digits.includes(digits)) return true;

  const m = dataNasc.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (!m) return false;

  const [, rawDd, rawMm, rawYy] = m;
  const dd = rawDd.padStart(2, '0');
  const mm = rawMm.padStart(2, '0');
  const yyyy = rawYy.length === 2 ? `19${rawYy}` : rawYy;

  const candidates = [
    `${dd}/${mm}/${yyyy}`, `${dd}/${mm}/${yyyy.slice(-2)}`,
    `${yyyy}-${mm}-${dd}`, `${dd}.${mm}.${yyyy}`,
    `${parseInt(rawDd)}/${parseInt(rawMm)}/${yyyy}`
  ];

  if (candidates.some(c => searchable.normalized.includes(normalizeText(c)))) return true;

  const mIdx = parseInt(rawMm, 10);
  if (mIdx >= 1 && mIdx <= 12) {
    const mes = MESES_PT[mIdx];
    const extensos = [
      `${parseInt(rawDd)} de ${mes} de ${yyyy}`,
      `${parseInt(rawDd)} de ${mes} ${yyyy}`,
      `${parseInt(rawDd)} ${mes} ${yyyy}`
    ];
    if (extensos.some(e => searchable.normalized.includes(normalizeText(e)))) return true;
  }
  return false;
};

const buildSearchableText = (result = {}) => {
  const combined = `${result.title || ''} ${result.url || ''} ${result.text || ''} ${(result.highlights || []).join(' ')}`;
  return {
    normalized: normalizeText(combined),
    digits: onlyDigits(combined)
  };
};

const scoreResult = (result, filters = {}) => {
  const searchable = buildSearchableText(result);
  const fullNameNorm = normalizeText(filters.nome || '');
  const exactNamePhrase = searchable.normalized.includes(fullNameNorm);

  const nomeResult = nameMatchResult(searchable.normalized, filters.nome || '');
  const nomeMatchStrong = nomeResult.strength === 'strong' || exactNamePhrase;

  const cpfMatch = cpfMatchesText(searchable, filters.cpf || '');
  const dateMatch = dateMatchesText(searchable, filters.dataNasc || '');

  const motherResult = filters.nomeMae ? nameMatchResult(searchable.normalized, filters.nomeMae) : { matched: false };
  const motherMatch = motherResult.matched;

  let locationMatch = false;
  if (filters.localizacao) {
    const parts = normalizeText(filters.localizacao).split(',').map(p => p.trim()).filter(Boolean);
    locationMatch = parts.length > 0 && parts.every(p => searchable.normalized.includes(p));
  }

  let score = 0;
  if (nomeResult.matched) score += nomeResult.strength === 'strong' ? 5 : 4;
  if (cpfMatch) score += 10;
  if (dateMatch) score += 5;
  if (motherMatch) score += 6;
  if (locationMatch) score += 3;
  if (exactNamePhrase) score += 4;

  const hasStrongSignal = cpfMatch || motherMatch || (dateMatch && nomeMatchStrong);

  // Critério principal (rígido mas realista)
  let accepted = Boolean(
    cpfMatch ||                                      // CPF sempre aceita
    motherMatch ||                                   // Nome da mãe é muito discriminante
    (nomeMatchStrong && dateMatch) ||                // Nome forte + data
    (nomeMatchStrong && hasStrongSignal) ||          // Nome + qualquer sinal forte
    (exactNamePhrase && (locationMatch || dateMatch)) // Frase exata + local ou data
  );

  // Novidade: se o score for muito alto (>=12), aceita independentemente das regras acima
  if (score >= 12) accepted = true;

  const matches = {
    nome: nomeResult.matched,
    cpf: cpfMatch,
    dataNasc: dateMatch,
    nomeMae: motherMatch,
    localizacao: locationMatch,
    exactName: exactNamePhrase
  };

  return { accepted, score, matches };
};

// ==================== HANDLER ====================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const { query, filters = {} } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({ error: 'Query inválida.' });
  }

  const EXA_API_KEY = process.env.EXA_API_KEY;
  if (!EXA_API_KEY) return res.status(500).json({ error: 'Chave Exa.AI não configurada.' });

  try {
    const exaPayload = {
      query,
      numResults: 20,
      useAutoprompt: false,
      type: 'neural',
      contents: {
        highlights: { maxCharacters: 900, numSentences: 3, highlightsPerUrl: 2 },
        text: { maxCharacters: 4000 }
      }
    };

    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY },
      body: JSON.stringify(exaPayload)
    });

    if (!response.ok) throw new Error(`Exa API ${response.status}`);

    const data = await response.json();
    const originalResults = Array.isArray(data.results) ? data.results : [];

    const scored = originalResults.map(result => {
      const validation = scoreResult(result, filters);
      return {
        ...result,
        matchScore: validation.score,
        matchedSignals: validation.matches,
        accepted: validation.accepted,
        lowConfidence: false
      };
    });

    const accepted = scored.filter(r => r.accepted).sort((a, b) => b.matchScore - a.matchScore);

    // Fallback mais permissivo: score >= 6 (antes era 7)
    const finalResults = accepted.length > 0
      ? accepted
      : scored
          .filter(r => r.matchScore >= 6)
          .slice(0, 6)
          .map(r => ({ ...r, lowConfidence: true }));

    return res.status(200).json({
      ...data,
      originalCount: originalResults.length,
      filteredOut: Math.max(originalResults.length - accepted.length, 0),
      usedFallback: accepted.length === 0 && finalResults.length > 0,
      results: finalResults
    });

  } catch (error) {
    console.error('[ExaOSINT] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
