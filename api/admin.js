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

  try {
    // STEP1: 公式情報・ルールを事前調査
    const researchResponse = await fetch('https://api.anthropic.com/v1/messages', {
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
        system: `TCGの公式情報リサーチャーです。
テキストに登場するカード・ルール・大会情報をweb_searchで全て調査してください。
以下のJSON形式のみで返してください：
{
  "cards": [{"name": "カード名", "effect": "正確な効果", "price": "現在価格"}],
  "rules": ["正確なルール"],
  "tournaments": [{"name": "大会名", "date": "開催日", "result": "結果"}],
  "meta": "現在の環境情報"
}`,
        messages: [{
          role: 'user',
          content: `以下のテキストに登場する全情報を調査してください：\n\n${rawText}`
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    let researchData = {};
    if (researchResponse.ok) {
      const rd = await researchResponse.json();
      const rt = rd.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const rm = rt.match(/\{[\s\S]*\}/);
      if (rm) { try { researchData = JSON.parse(rm[0]); } catch(e) {} }
    }

    // STEP2: Q&A形式＋AI解説で記事生成
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
        max_tokens: 5000,
        system: `あなたはTCGVIBE.AIのベテラン編集者です。
プロの回答をQ&A形式＋AI解説の三層構造で記事にしてください。

【記事の構成】
各質問ごとに以下の三層で書く：
1. Q（質問）
2. プロの回答（原文をそのまま自然に整理）
3. AIの解説（プロの回答を初心者にも伝わるように解説。カードの効果・ルールを正確に補足）

【絶対に守るルール】
・##、**、---、<cite>などの記号は一切使わない
・自然な話し言葉（〜だよ、〜だね、〜かな）
・カードの効果・ルールは調査済みの正確な情報のみ
・AIの解説は「TCGVIBE AI的には〜」という書き出しで始める
・段落間は空行を入れて読みやすくする
・不確かな情報は書かない

以下のJSON形式のみで返してください：
{
  "title": "タイトル（35文字以内）",
  "tag": "環境解説/デッキ紹介/大会レポート/価格情報/初心者向け のどれか",
  "summary": "要約（120文字以内）",
  "content": "記事本文（Q&A三層構造で全情報を記事化）",
  "emoji": "絵文字1つ",
  "highlights": ["見どころ1", "見どころ2", "見どころ3"]
}`,
        messages: [{
          role: 'user',
          content: `【質問リスト】
${questions || `① 今の環境で一番強いデッキは？
② そのデッキの回し方は？
③ 対策カードは？
④ 初心者におすすめのデッキは？
⑤ 注目・高騰カードは？
⑥ 大会で勝つために大事なことは？
⑦ 直近の大会レポート`}

【プロプレイヤーの回答】
ゲーム：${game || 'ポケモンカード'}
執筆者：${author || 'プロプレイヤー'}

${rawText}

【事前調査済みの正確な公式情報】
${JSON.stringify(researchData, null, 2)}

上記を使ってQ&A三層構造の記事を書いてください。`
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
