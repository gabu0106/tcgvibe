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
        system: 'あなたはTCGの記事編集者です。プロの回答をQ&A三層構造の記事にしてください。コードブロックやバッククォートは使わず、必ず以下の形式のJSONのみを返してください。contentの改行は\\nを使うこと: {"title":"タイトル","tag":"環境解説","summary":"要約","content":"本文（改行は\\nで）","emoji":"絵文字","highlights":["1","2","3"]}',
        messages: [{
          role: 'user',
          content: 'ゲーム:' + (game || 'ポケカ') + '\n執筆者:' + (author || 'プロ') + '\n質問:' + (questions || '環境について') + '\n回答:\n' + trimmedText + '\n\nJSONのみ返してください。'
        }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(500).json({ error: 'AI error: ' + (errData.error?.message || 'unknown') });
    }

    const data = await response.json();
    const rawResponse = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // コードブロック除去
    const text = rawResponse.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    console.log('Response first 200:', text.substring(0, 200));

    // JSON部分を抽出して安全にパース
    let article;
    try {
      // まずそのままパースを試みる
      article = JSON.parse(text);
    } catch(e1) {
      try {
        // { から } までを抽出してパース
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('no brackets');
        article = JSON.parse(text.substring(start, end + 1));
      } catch(e2) {
        // 改行を含むJSONを修復してパース
        try {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('no brackets');
          // contentフィールドの実際の改行を\\nに変換
          const jsonStr = text.substring(start, end + 1)
            .replace(/("content"\s*:\s*")([\s\S]*?)("(?:\s*,|\s*\}))/g, (match, p1, p2, p3) => {
              return p1 + p2.replace(/\n/g, '\\n').replace(/\r/g, '') + p3;
            });
          article = JSON.parse(jsonStr);
        } catch(e3) {
          console.error('All parse attempts failed:', text.substring(0, 300));
          return res.status(500).json({ error: 'JSON parse failed' });
        }
      }
    }

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
          tag: article.tag || '環境解説',
          title: article.title || '',
          summary: article.summary || '',
          content: article.content || '',
          emoji: article.emoji || '',
        }),
      });
    } catch(e) {
      console.error('Supabase error:', e);
    }

    return res.status(200).json({
      success: true,
      article: {
        title: article.title || '',
        tag: article.tag || '環境解説',
        summary: article.summary || '',
        content: (article.content || '').replace(/\\n/g, '\n'),
        emoji: article.emoji || '',
        highlights: article.highlights || [],
      },
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
