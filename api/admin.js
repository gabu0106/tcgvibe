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
        system: `あなたはTCGVIBE.AIの編集者です。
プロプレイヤーの回答をQ&A三層構造の記事にしてください。

各質問ごとに：
Q（質問）
プロの回答（原文を自然に整理）
TCGVIBE AI的には〜（初心者にも伝わる解説）

ルール：
・記号（##、**、---）は使わない
・箇条書きは「・」のみ
・話し言葉で書く

必ず以下のJSON形式のみで返してください。前後に余分なテキストや\`\`\`は絶対につけないこと。contentの中の改行は\\nで表現すること：
{"title":"タイトル","tag":"環境解説","summary":"要約","content":"記事本文（改行は\\nで）","emoji":"🃏","highlights":["見どころ1","見どころ2","見どころ3"]}`,
        messages: [{
          role: 'user',
          content: `ゲーム：${game || 'ポケモンカード'}
執筆者：${author || 'プロプレイヤー'}
質問：${questions || '環境・デッキ・大会について'}

回答：
${trimmedText}

JSONのみ返してください。`
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
    console.log('AI response length:', text.length);

    // JSONを安全に抽出
    let article;
    try {
      // まずそのままパースを試みる
      const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
      
      // { から最後の } までを抽出
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      
      if (start === -1 || end === -1) throw new Error('No JSON brackets');
      
      const jsonStr = cleaned.substring(start, end + 1);
      article = JSON.parse(jsonStr);
    } catch(e) {
      console.error('JSON parse failed:', e.message);
      throw new Error('JSON parse error');
    }

    // Supabaseに保存
    let savedId = null;
    try {
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
          tag: article.tag || '環境解説',
          title: article.title || '',
          summary: article.summary || '',
          content: article.content || '',
          emoji: article.emoji || '🃏',
        }),
      });
      const saved = await saveRes.json();
      savedId = saved[0]?.id;
    } catch(e) {
      console.error('Supabase save error:', e);
    }

    return res.status(200).json({
      success: true,
      article: {
        title: article.title || '',
        tag: article.tag || '環境解説',
        summary: article.summary || '',
        content: (article.content || '').replace(/\\n/g, '\n'),
        emoji: article.emoji || '🃏',
        highlights: article.highlights || [],
        id: savedId,
      },
    });

  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: '記事生成エラーが発生しました: ' + err.message });
  }
}
