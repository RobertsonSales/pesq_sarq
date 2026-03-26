// api/search.js
export default async function handler(req, res) {
  // Permite apenas método POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  // Extrai a query do corpo da requisição
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Campo "query" é obrigatório.' });
  }

  // Recupera a chave da API da variável de ambiente
  const EXA_API_KEY = process.env.EXA_API_KEY;

  if (!EXA_API_KEY) {
    console.error('Chave da API Exa não configurada.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  try {
    // Faz a chamada para a API Exa
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        query: query,
        numResults: 6,
        contents: { highlights: { maxCharacters: 900 } },
        type: 'neural',
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
