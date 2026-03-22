export default async function handler(req, res) {
  // CORSヘッダー
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
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `あなたはTCGVIBE.AIの専属AIアドバイザーです。
トレーディングカードゲーム（TCG）の専門家として、以下のゲームに精通しています：
- ポケモンカードゲーム（ポケカ）
- 遊戯王オフィシャルカードゲーム
- マジック：ザ・ギャザリング（MTG）
- デュエル・マスターズ
- ヴァイスシュヴァルツ
- ワンピースカードゲーム

回答は日本語で、親しみやすくかつ専門的に。
デッキ構築の相談、カードの強さ評価、ルール裁定、大会対策など何でも答えてください。
価格情報は変動するため「最新情報はショップでご確認ください」と添えてください。
回答は簡潔に、要点をまとめて伝えてください。`,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Anthropic API error:', error);
      return res.status(response.status).json({ error: 'AI APIエラーが発生しました' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text ?? '';
    return res.status(200).json({ reply: text });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
