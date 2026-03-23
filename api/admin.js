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
        system: 'あなたはTCGの記事編集者です。プロプレイヤーの回答をQ&A形式の記事にしてください。各質問にQ/プロの回答/TCGVIBE AI的にはの三層で答えること。記号は使わず話し言葉で。必ずJSON形式のみで返すこと。コードブロックやバッククォートは絶対に使わないこと: {"title":"タイトル","tag":"環境解説","summary":"要約","content":"本文","emoji":"emoji文字","highlights":["1","2","3"]}',
        messages: [{
          role: 'user',
          content: 'ゲーム:' + (game || 'ポケカ') + ' 執筆者:' + (author || 'プロ') + ' 質問:' + (questions || '環境について') + ' 回答:' + trimmedText + ' JSONのみ返してください。コードブロックは使わないでください。'
        }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error('Anthropic error:', JSON.stringify(errData));
      return res.status(500).json({ error: 'AI error: ' + (errData.error?.message || 'unknown') });
    }

    const data = await response.json();
    const rawResponse = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    
    // バッククォートとコードブロックを除去
    const text = rawResponse
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    console.log('Response:', text.substring(0, 300));

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1) {
      console.error('No JSON in:', text.substring(0, 500));
      return res.status(500).json({ error: 'JSON not found' });
    }

    const jsonStr = text.substring(start, end + 1);
    let article;
    try {
      article = JSON.parse(jsonStr);
    } catch(e) {
      console.error('Parse error:', e.message, jsonStr.substring(0, 200));
      return res.status(500).json({ error: 'JSON parse failed' });
    }

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
        content: article.content || '',
        emoji: article.emoji || '',
        highlights: article.highlights || [],
      },
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
