let articlesCache = null;
let cacheTime = null;
const CACHE_DURATION = 1000 * 60 * 60 * 3;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (articlesCache && cacheTime && (Date.now() - cacheTime) < CACHE_DURATION) {
    return res.status(200).json({ articles: articlesCache });
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
        max_tokens: 2000,
        system: `あなたはTCGVIBE.AIの記事ライターです。
web_searchツールで最新のTCG情報を検索し、3本の記事を作成してください。

必ず以下のJSON配列のみを返してください（説明文不要）：
[
  {
    "title": "タイトル（25文字以内）",
    "tag": "大会レポート",
    "summary": "要約（80文字以内）",
    "emoji": "🏆",
    "date": "今日の日付（例：2025年3月23日）"
  },
  {
    "title": "タイトル",
    "tag": "環境解説",
    "summary": "要約",
    "emoji": "🃏",
    "date": "今日の日付"
  },
  {
    "title": "タイトル",
    "tag": "価格情報",
    "summary": "要約",
    "emoji": "📈",
    "date": "今日の日付"
  }
]`,
        messages: [{
          role: 'user',
          content: '今日の最新TCG情報（ポケカ・遊戯王・MTG）を検索して3本の記事を作成してください。'
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    if (!response.ok) throw new Error('API error');

    const data = await response.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('JSON parse error');

    const articles = JSON.parse(jsonMatch[0]);
    articlesCache = articles;
    cacheTime = Date.now();

    return res.status(200).json({ articles });

  } catch (err) {
    console.error('Articles error:', err);
    return res.status(200).json({
      articles: [
        { title: 'ポケカ最新環境まとめ', tag: '環境解説', summary: '現在の環境トップデッキを解説します', emoji: '🃏', date: new Date().toLocaleDateString('ja-JP') },
        { title: '今週の注目高騰カード', tag: '価格情報', summary: '今週値上がりが予想されるカードを紹介', emoji: '📈', date: new Date().toLocaleDateString('ja-JP') },
        { title: '最新大会結果レポート', tag: '大会レポート', summary: '直近の大会優勝デッキを分析', emoji: '🏆', date: new Date().toLocaleDateString('ja-JP') },
      ]
    });
  }
}
