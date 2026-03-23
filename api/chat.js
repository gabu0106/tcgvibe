export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages が必要です' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `あなたはTCGVIBE.AIの専属AIアドバイザーです。
トレーディングカードゲーム（TCG）の専門家として以下のゲームに精通しています：
ポケモンカードゲーム、遊戯王、マジック：ザ・ギャザリング、デュエル・マスターズ、ヴァイスシュヴァルツ、ワンピースカードゲーム。

【重要】最新の環境情報・カード価格・大会結果などは必ずweb_searchツールで検索してから回答してください。
特に「今の環境」「最新」「現在」「最近」などのキーワードが含まれる質問は必ず検索すること。

回答は日本語で、親しみやすくかつ専門的に。
デッキ構築・カード評価・ルール裁定・大会対策・価格相場など何でも答えてください。
価格情報は変動するため検索結果を参考にしつつ「最新情報はショップでご確認ください」と添えること。
回答は簡潔に要点をまとめて伝えてください。`,
        messages: messages,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          }
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Anthropic API error:', error);
      return res.status(response.status).json({ error: 'AI APIエラーが発生しました' });
    }

    const data = await response.json();
    const text = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return res.status(200).json({ reply: text });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
