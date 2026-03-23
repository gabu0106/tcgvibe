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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  let tcgContext = '';
  try {
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tcg_meta?order=collected_at.desc&limit=20`,
      {
        headers: {
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        },
      }
    );
    if (dbRes.ok) {
      const dbData = await dbRes.json();
      if (dbData.length > 0) {
        tcgContext = '\n\n【最新TCG情報データベース】\n' +
          dbData.map(d => `[${d.game}][${d.category}] ${d.title}: ${d.content}`).join('\n');
      }
    }
  } catch (e) {
    console.error('DB取得エラー:', e);
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
ポケモンカード、遊戯王、MTG、デュエルマスターズ、ヴァイスシュヴァルツ、ワンピースカードの専門家です。

【重要】以下のデータベース情報を最優先で参照して回答してください。
データベースにない情報はweb_searchで検索してください。${tcgContext}

【回答スタイル】
・友達に話しかけるような自然な日本語で話すこと
・##や**や---などのマークダウン記号は絶対に使わない
・箇条書きは「・」のみ使う
・「〜だよ」「〜だね」「〜かな」など話し言葉で答える
・専門知識は持ちつつも堅くなりすぎない
・価格情報には「最新情報はショップでご確認ください」を添える
・回答は長すぎず、テンポよく答える`,
        messages: messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
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
