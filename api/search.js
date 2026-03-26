// api/search.js
export default async function handler(req, res) {
  // Apenas método POST é aceito
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Campo "query" é obrigatório.' });
  }

  // Recupera a chave da API da variável de ambiente configurada no Vercel
  const EXA_API_KEY = process.env.EXA_API_KEY;

  if (!EXA_API_KEY) {
    console.error('Chave da API Exa não configurada no ambiente.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta: chave da API não encontrada.' });
  }

  try {
    // Configuração otimizada: mais resultados, autoprompt ativado
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        query: query,
        numResults: 8,                   // mais resultados para filtrar
        useAutoprompt: true,             // permite que a Exa refine a query automaticamente
        contents: {
          highlights: { maxCharacters: 900 },
          text: true                     // opcional, para obter trechos mais completos
        },
        type: "neural"
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro da API Exa: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro na função search:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
