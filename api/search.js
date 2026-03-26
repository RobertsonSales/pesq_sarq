// api/search.js — ExaOSINT v2
// Reescrito para maior cobertura de resultados e menor falso-positivo de homônimos.
// Principais melhorias:
//   1. Matching de nome por tokens (não exige nome completo literalmente)
//   2. CPF testado em múltiplos formatos (com/sem máscara, parcial)
//   3. Data de nascimento testada em seis formatos diferentes
//   4. Critério de aceitação em camadas (strict → relaxed → fallback)
//   5. Fallback para top-3 por score quando nenhum resultado passa (evita painel vazio)
//   6. numResults ampliado para 15 e destaques enriquecidos

// ─── Utilitários de texto ────────────────────────────────────────────────────

/**
 * Normaliza texto: remove acentos, lowercase, espaços extras.
 */
const normalizeText = (value = '') =>
  value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Extrai apenas dígitos de uma string. */
const onlyDigits = (value = '') => value.toString().replace(/\D/g, '');

// ─── Matching de Nome ────────────────────────────────────────────────────────

/** Partículas gramaticais que não devem ser usadas como tokens de nome. */
const NAME_PARTICLES = new Set([
  'de', 'da', 'do', 'dos', 'das', 'di', 'du',
  'e', 'a', 'o', 'van', 'von', 'del', 'la', 'le',
]);

/**
 * Extrai tokens significativos de um nome completo.
 * Ignora partículas (de, da, do…) e tokens com menos de 3 caracteres.
 *
 * Ex: "Maria de Fátima Santos" → ["maria", "fatima", "santos"]
 */
const extractNameTokens = (fullName = '') =>
  normalizeText(fullName)
    .split(' ')
    .filter(t => t.length >= 3 && !NAME_PARTICLES.has(t));

/**
 * Avalia se o nome corresponde ao texto pesquisável.
 *
 * Estratégia em camadas:
 *   1. Todos os tokens presentes                 → match forte
 *   2. Primeiro token + último token presentes   → match forte
 *   3. ≥ 67% dos tokens presentes (nome longo)  → match moderado
 *
 * Retorna { matched: boolean, strength: 'strong' | 'moderate' | 'none' }
 */
const nameMatchResult = (searchableNormalized, fullName) => {
  if (!fullName) return { matched: false, strength: 'none' };

  const tokens = extractNameTokens(fullName);
  if (tokens.length === 0) return { matched: false, strength: 'none' };

  const present = tokens.filter(t => searchableNormalized.includes(t));

  // Todos os tokens presentes
  if (present.length === tokens.length)
    return { matched: true, strength: 'strong' };

  // Primeiro + último
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];
  if (
    tokens.length >= 2 &&
    searchableNormalized.includes(firstToken) &&
    searchableNormalized.includes(lastToken)
  ) return { matched: true, strength: 'strong' };

  // Maioria (nomes com 3+ partes)
  if (tokens.length >= 3 && present.length >= Math.ceil(tokens.length * 0.67))
    return { matched: true, strength: 'moderate' };

  return { matched: false, strength: 'none' };
};

// ─── Matching de CPF ─────────────────────────────────────────────────────────

/**
 * Testa o CPF em múltiplos formatos dentro do texto pesquisável.
 *   - Somente dígitos: 12345678901
 *   - Formatado:       123.456.789-01
 *   - Sem hífen:       123.456.789 01
 *   - Parcial (9d):    123456789 (truncado em alguns sites)
 */
const cpfMatchesText = (searchable, cpf) => {
  if (!cpf) return false;

  const d = onlyDigits(cpf);
  if (d.length < 11) return false;

  // 1. Somente dígitos contíguos
  if (searchable.digits.includes(d)) return true;

  // 2. Formato padrão: 000.000.000-00
  const fmt1 = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
  if (searchable.normalized.includes(fmt1)) return true;

  // 3. Sem hífen: 000.000.000 00
  const fmt2 = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)} ${d.slice(9, 11)}`;
  if (searchable.normalized.includes(fmt2)) return true;

  // 4. Somente os primeiros 9 dígitos (CPF truncado em alguns bancos de dados)
  if (d.length >= 9 && searchable.digits.includes(d.slice(0, 9))) return true;

  return false;
};

// ─── Matching de Data ─────────────────────────────────────────────────────────

const MESES_PT = [
  '', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

/**
 * Tenta casar a data de nascimento em pelo menos um dos formatos:
 *   DD/MM/YYYY · DD/MM/YY · YYYY-MM-DD · DD.MM.YYYY
 *   "D de mês de YYYY" · "D mês YYYY" · somente 8 dígitos contíguos
 */
const dateMatchesText = (searchable, dataNasc) => {
  if (!dataNasc) return false;

  // Tentativa direta normalizada
  const norm = normalizeText(dataNasc);
  if (searchable.normalized.includes(norm)) return true;

  // Somente dígitos (DDMMYYYY)
  const digits = onlyDigits(dataNasc);
  if (digits.length === 8 && searchable.digits.includes(digits)) return true;

  // Parse DD/MM/YYYY (ou separadores alternativos)
  const m = dataNasc.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (!m) return false;

  const [, rawDd, rawMm, rawYy] = m;
  const dd = rawDd.padStart(2, '0');
  const mm = rawMm.padStart(2, '0');
  const yyyy = rawYy.length === 2 ? `19${rawYy}` : rawYy;
  const dInt = parseInt(rawDd, 10);
  const mIdx = parseInt(rawMm, 10);

  const candidates = [
    `${dd}/${mm}/${yyyy}`,
    `${dd}/${mm}/${yyyy.slice(-2)}`,
    `${yyyy}-${mm}-${dd}`,
    `${dd}.${mm}.${yyyy}`,
    `${dInt}/${mIdx}/${yyyy}`,
    `${dd} ${mm} ${yyyy}`,
  ];

  if (candidates.some(c => searchable.normalized.includes(normalizeText(c)))) return true;

  // Formatos por extenso: "1 de janeiro de 2000" / "1 janeiro 2000"
  if (mIdx >= 1 && mIdx <= 12) {
    const mes = MESES_PT[mIdx];
    const extensos = [
      `${dInt} de ${mes} de ${yyyy}`,
      `${dInt} de ${mes} ${yyyy}`,
      `${dInt} ${mes} ${yyyy}`,
    ];
    if (extensos.some(e => searchable.normalized.includes(normalizeText(e)))) return true;
  }

  return false;
};

// ─── Construção do Texto Pesquisável ─────────────────────────────────────────

const buildSearchableText = (result = {}) => {
  const title = result.title || '';
  const url = result.url || '';
  const text = result.text || '';
  const highlights = Array.isArray(result.highlights)
    ? result.highlights.join(' ')
    : '';
  const combined = `${title} ${url} ${text} ${highlights}`;
  return {
    normalized: normalizeText(combined),
    digits: onlyDigits(combined),
  };
};

// ─── Scoring & Aceitação ─────────────────────────────────────────────────────

/**
 * Pontuação por sinal identificador encontrado no resultado.
 *
 *  CPF        +10  (identificador único — auto-aceite)
 *  Nome Mãe   + 6  (muito discriminante)
 *  Data Nasc  + 5
 *  Nome        + 4 (ou +5 se 3+ tokens)
 *  Localização + 2
 *
 * Critérios de ACEITAÇÃO (por camadas, do mais rígido ao mais permissivo):
 *   L1 – CPF encontrado                                  → aceito (definitive)
 *   L2 – Nome forte + ≥ 1 sinal secundário              → aceito (high confidence)
 *   L3 – Nome forte + nome é específico (≥ 3 tokens)    → aceito (specific name)
 *   L4 – Score ≥ 11 (ex: nome+nomeMae ou nome+data+loc) → aceito (aggregate)
 *   L5 – Fallback no handler: top-3 com lowConfidence   → exibido com aviso
 */
const scoreResult = (result, filters = {}) => {
  const searchable = buildSearchableText(result);

  // Nome
  const nomeResult = nameMatchResult(searchable.normalized, filters.nome || '');
  const nomeMatch = nomeResult.matched;
  const nomeTokens = extractNameTokens(filters.nome || '');
  const nomeIsSpecific = nomeTokens.length >= 3; // ≥ 3 partes → nome relativamente único

  // CPF
  const cpfMatch = cpfMatchesText(searchable, filters.cpf || '');

  // Data de nascimento
  const dateMatch = dateMatchesText(searchable, filters.dataNasc || '');

  // Nome da mãe
  const motherResult = filters.nomeMae
    ? nameMatchResult(searchable.normalized, filters.nomeMae)
    : { matched: false };
  const motherMatch = motherResult.matched;

  // Localização (todas as partes devem estar presentes)
  let locationMatch = false;
  if (filters.localizacao) {
    const parts = normalizeText(filters.localizacao)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    locationMatch = parts.length > 0 && parts.every(p => searchable.normalized.includes(p));
  }

  const matches = {
    nome: nomeMatch,
    cpf: cpfMatch,
    dataNasc: dateMatch,
    nomeMae: motherMatch,
    localizacao: locationMatch,
  };

  // Pontuação
  let score = 0;
  if (nomeMatch) score += nomeIsSpecific ? 5 : 4;
  if (cpfMatch) score += 10;
  if (dateMatch) score += 5;
  if (motherMatch) score += 6;
  if (locationMatch) score += 2;

  const hasSecondarySignal = dateMatch || motherMatch || locationMatch;

  // Camadas de aceitação
  const accepted = Boolean(
    cpfMatch ||                                     // L1 – CPF definitivo
    (nomeMatch && hasSecondarySignal) ||            // L2 – nome + sinal secundário
    (nomeMatch && nomeIsSpecific) ||                // L3 – nome específico (3+ partes)
    score >= 11                                     // L4 – pontuação agregada alta
  );

  return { accepted, score, matches };
};

// ─── Handler Principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { query, filters = {} } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({
      error: 'Campo "query" é obrigatório e deve ter ao menos 3 caracteres.',
    });
  }

  const EXA_API_KEY = process.env.EXA_API_KEY;
  if (!EXA_API_KEY) {
    console.error('[ExaOSINT] EXA_API_KEY não configurada no ambiente Vercel.');
    return res.status(500).json({
      error: 'Configuração incompleta: chave da API não encontrada no servidor.',
    });
  }

  try {
    const exaPayload = {
      query,
      numResults: 15,          // ampliado de 12 → 15 para mais candidatos
      useAutoprompt: false,
      type: 'neural',
      contents: {
        highlights: {
          maxCharacters: 900,
          numSentences: 3,
          highlightsPerUrl: 2,  // 2 trechos por URL → mais contexto para scoring
        },
        text: { maxCharacters: 2000 },
      },
    };

    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify(exaPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const originalResults = Array.isArray(data.results) ? data.results : [];

    // Aplica scoring em todos os resultados
    const scored = originalResults.map(result => {
      const validation = scoreResult(result, filters);
      return {
        ...result,
        matchScore: validation.score,
        matchedSignals: validation.matches,
        accepted: validation.accepted,
        lowConfidence: false,
      };
    });

    // Resultados aceitos pelos critérios principais, ordenados por score
    const accepted = scored
      .filter(r => r.accepted)
      .sort((a, b) => b.matchScore - a.matchScore);

    // Fallback: se nenhum passou, retorna top-3 com aviso de baixa confiança
    // Isso evita que o painel apareça completamente vazio quando há dados relevantes.
    const finalResults =
      accepted.length > 0
        ? accepted
        : scored
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 3)
            .map(r => ({ ...r, lowConfidence: true }));

    return res.status(200).json({
      ...data,
      originalCount: originalResults.length,
      filteredOut: Math.max(originalResults.length - accepted.length, 0),
      usedFallback: accepted.length === 0 && finalResults.length > 0,
      results: finalResults,
    });

  } catch (error) {
    console.error('[ExaOSINT] Erro no handler search:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
