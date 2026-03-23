export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, game, author } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText が必要です' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

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
        max_tokens: 2000,
        system: `あなたはTCGVIBE.AIの編集者です。
プロプレイヤーの回答テキストを、読みやすい記事に整形してください。

以下のJSON形式のみで返してください（説明文不要）：
{
  "title": "記事タイトル（30文字以内、魅力的に）",
  "tag": "環境解説/デッキ紹介/大会レポート/価格情報/初心者向け のどれか",
  "summary": "記事の要約（100文字以内）",
  "content": "整形した記事本文（マークダウンなし、自然な文体で500〜800文字）",
  "emoji": "記事に合う絵文字1つ"
}`,
        messages: [{
          role: 'user',
          content: `以下のプロプレイヤーの回答を記事に整形してください。\nゲーム：${game || 'ポケモンカード'}\n執筆者：${author || 'プロプレイヤー'}\n\n回答テキスト：\n${rawText}`
        }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error('Anthropic error:', errData);
      throw new Error('AI error');
    }

    const data = await response.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON parse error');

    const article = JSON.parse(jsonMatch[0]);

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/tcg_articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'apikey': SUPABASE_SECRET_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        game: game || 'pokeca',
        tag: article.tag,
        title: article.title,
        summary: article.summary,
        content: article.content,
        emoji: article.emoji,
      }),
    });

    const saved = await saveRes.json();

    return res.status(200).json({
      success: true,
      article: { ...article, id: saved[0]?.id },
    });

  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: '記事生成エラーが発生しました' });
  }
}
