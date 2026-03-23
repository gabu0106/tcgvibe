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
  const trimmedText = rawText.slice(0, 2500);

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
        system: `あなたはTCGの記事編集者です。プロの回答をQ&A三層構造の記事にしてください。

必ず以下の形式で出力してください：

TITLE: ここにタイトル（35文字以内）
TAG: 環境解説
SUMMARY: ここに要約（120文字以内）
EMOJI: 🃏
HIGHLIGHTS: 見どころ1|見どころ2|見どころ3
CONTENT:
ここに記事本文を書く。記号（##、**）は使わず話し言葉で。Q&A三層構造で。`,
        messages: [{
          role: 'user',
          content: `ゲーム: ${game || 'ポケカ'}
執筆者: ${author || 'プロ'}
質問: ${questions || '環境について'}
回答: ${trimmedText}

上記の形式で記事を出力してください。`
        }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(500).json({ error: 'AI error: ' + (errData.error?.message || 'unknown') });
    }

    const data = await response.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('Response:', text.substring(0, 200));

    // テキスト形式をパース
    const titleMatch = text.match(/TITLE:\s*(.+)/);
    const tagMatch = text.match(/TAG:\s*(.+)/);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/);
    const emojiMatch = text.match(/EMOJI:\s*(.+)/);
    const highlightsMatch = text.match(/HIGHLIGHTS:\s*(.+)/);
    const contentMatch = text.match(/CONTENT:\s*([\s\S]+)$/);

    const article = {
      title: titleMatch ? titleMatch[1].trim() : 'TCGプロ解説記事',
      tag: tagMatch ? tagMatch[1].trim() : '環境解説',
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      emoji: emojiMatch ? emojiMatch[1].trim() : '🃏',
      highlights: highlightsMatch ? highlightsMatch[1].split('|').map(h => h.trim()) : [],
      content: contentMatch ? contentMatch[1].trim() : text,
    };

    // Supabaseに保存
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/tcg_articles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
          'apikey': SUPABASE_SECRET_KEY,
          'Prefer': 'return=minimal',
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
    } catch(e) {
      console.error('Supabase error:', e);
    }

    return res.status(200).json({ success: true, article });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
