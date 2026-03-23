export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, game, author, questions } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText が必要です' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  // 3000文字でカット
  const trimmedText = rawText.slice(0, 3000);

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
        max_tokens: 3000,
        system: `あなたはTCGVIBE.AIのベテラン編集者です。
プロプレイヤーの回答をQ&A三層構造の記事に仕上げてください。

【記事の構成】
各質問ごとに：
Q（質問）
プロの回答（原文を自然に整理）
TCGVIBE AI的には〜（初心者にも伝わる解説・補足）

【絶対に守るルール】
・##、**、---などの記号は一切使わない
・箇条書きは「・」のみ
・自然な話し言葉（〜だよ、〜だね）
・段落間は空行を入れる
・不確かな情報は書かない

以下のJSON形式のみで返してください：
{
  "title": "タイトル（35文字以内）",
  "tag": "環境解説/デッキ紹介/大会レポート/価格情報/初心者向け のどれか",
  "summary": "要約（120文字以内）",
  "content": "記事本文（Q&A三層構造）",
  "emoji": "絵文字1つ",
  "highlights": ["見どころ1", "見どころ2", "見どころ3"]
}`,
        messages: [{
          role: 'user',
          content: `【質問リスト】
${questions || '① 今の環境で一番強いデッキは？\n② そのデッキの回し方は？\n③ 対策カードは？\n④ 初心者におすすめのデッキは？\n⑤ 注目・高騰カードは？\n⑥ 大会で勝つために大事なことは？'}

【プロプレイヤーの回答】
ゲーム：${game || 'ポケモンカード'}
執筆者：${author || 'プロプレイヤー'}

${trimmedText}

上記をQ&A三層構造の記事にしてください。`
        }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error('Anthropic error:', JSON.stringify(errData));
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
