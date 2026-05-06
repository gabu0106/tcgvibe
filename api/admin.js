export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Admin key verification endpoint
  if (req.method === 'GET' && req.query.action === 'verify') {
    const valid = req.query.key === process.env.ADMIN_KEY;
    return res.status(200).json({ valid });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, game, author, authorX, questions } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText が必要です' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const trimmedText = rawText.slice(0, 2500);

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が未設定です' });
  }

  try {
    const systemInstruction = `あなたはTCGVIBE.AIの記事編集者です。プロの回答をQ&A三層構造の記事にしてください。

必ず以下の形式で出力してください：

TITLE: タイトル（35文字以内）
TAG: 環境解説
SUMMARY: 要約（120文字以内）
EMOJI: 絵文字1つ
HIGHLIGHTS: 見どころ1|見どころ2|見どころ3
CONTENT:
記事本文をここに書く。記号（##、**）は使わず話し言葉で。全ての質問と回答を必ずQ&A三層構造で含めること。

REVIEW:
AIによる総評をここに書く（200文字程度）。プロの回答全体を踏まえた分析・注目ポイント・読者へのメッセージを話し言葉で。`;

    const userContent = `ゲーム: ${game || 'ポケカ'}
執筆者: ${author || 'プロ'}${authorX ? `（X: ${authorX}）` : ''}
質問: ${questions || '環境について'}
回答: ${trimmedText}

上記の形式で記事を出力してください。全ての質問と回答を含めてください。`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          maxOutputTokens: 4000,
          temperature: 0.7,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini APIエラー:', response.status, errorText);
      return res.status(500).json({ error: 'AI APIエラーが発生しました' });
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return res.status(500).json({ error: 'AIの応答が空でした' });
    }

    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKLIST') {
      return res.status(500).json({ error: 'コンテンツが安全フィルターでブロックされました' });
    }

    const text = candidate.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    if (!text) {
      return res.status(500).json({ error: '応答テキストが取得できませんでした' });
    }

    const titleMatch = text.match(/TITLE:\s*(.+)/);
    const tagMatch = text.match(/TAG:\s*(.+)/);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/);
    const emojiMatch = text.match(/EMOJI:\s*(.+)/);
    const highlightsMatch = text.match(/HIGHLIGHTS:\s*(.+)/);
    const contentMatch = text.match(/CONTENT:\s*([\s\S]+?)(?=\nREVIEW:)/);
    const reviewMatch = text.match(/REVIEW:\s*([\s\S]+)$/);

    const article = {
      title: titleMatch ? titleMatch[1].trim() : 'TCGプロ解説記事',
      tag: tagMatch ? tagMatch[1].trim() : '環境解説',
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      emoji: emojiMatch ? emojiMatch[1].trim() : '🃏',
      highlights: highlightsMatch ? highlightsMatch[1].split('|').map(h => h.trim()) : [],
      content: contentMatch ? contentMatch[1].trim() : text,
      review: reviewMatch ? reviewMatch[1].trim() : '',
      author: author || '',
      authorX: authorX || '',
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
          author: article.author,
          author_x: article.authorX,
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
