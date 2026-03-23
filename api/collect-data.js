export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  const sources = [
    // ポケカ環境
    { game: 'pokeca', query: 'ポケモンカード スタンダード 使用可能 レギュレーション 2025 最新' },
    { game: 'pokeca', query: 'ポケモンカード スタンダード落ち 使用不可 カード 2025' },
    { game: 'pokeca', query: 'ポケモンカード 環境デッキ ランキング 2025 最強' },
    { game: 'pokeca', query: 'ポケモンカード 大会結果 優勝デッキ 最新 2025' },
    { game: 'pokeca', query: 'ポケモンカード 高騰カード 注目 今週 2025' },
    { game: 'pokeca', query: 'ポケモンカード 新弾 収録カード 強い 2025' },

    // ワンピース環境
    { game: 'onepiece', query: 'ワンピースカードゲーム 禁止カード 制限 最新 2025' },
    { game: 'onepiece', query: 'ワンピースカードゲーム 環境デッキ 強い ランキング 2025' },
    { game: 'onepiece', query: 'ワンピースカードゲーム 大会結果 優勝 最新 2025' },
    { game: 'onepiece', query: 'ワンピースカード 高騰 注目カード 2025' },
    { game: 'onepiece', query: 'ワンピースカードゲーム 新弾 強いカード 2025' },

    // 遊戯王
    { game: 'yugioh', query: '遊戯王 禁止カード 制限カード リスト 最新 2025' },
    { game: 'yugioh', query: '遊戯王 環境デッキ 強い ランキング 2025' },

    // MTG
    { game: 'mtg', query: 'MTG スタンダード 禁止カード 最新 2025' },
    { game: 'mtg', query: 'MTG 環境デッキ 強い 2025' },
  ];

  const results = [];

  for (const source of sources) {
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
          max_tokens: 1000,
          system: `TCG情報収集AIです。web_searchで検索し、以下のJSON形式のみで返してください（説明文不要）：
{
  "title": "情報タイトル（30文字以内）",
  "content": "詳細情報（300文字以内）。禁止・制限・スタンダード落ちの場合は具体的なカード名を必ず記載",
  "category": "環境/大会/価格/禁止制限/レギュレーション/新弾 のどれか",
  "source": "参考サイト名"
}`,
          messages: [{
            role: 'user',
            content: `「${source.query}」を検索して最新情報をまとめてください。特に禁止・制限・スタンダード落ち・レギュレーション変更などの公式情報は正確に記載してください。`
          }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) continue;

      const info = JSON.parse(jsonMatch[0]);

      // Supabaseに保存
      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/tcg_meta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
          'apikey': SUPABASE_SECRET_KEY,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          game: source.game,
          category: info.category || '環境',
          title: info.title,
          content: info.content,
          source: info.source || 'web',
        }),
      });

      if (saveRes.ok) {
        results.push({ game: source.game, title: info.title, category: info.category });
      }

    } catch (e) {
      console.error('収集エラー:', e);
    }
  }

  return res.status(200).json({
    success: true,
    collected: results.length,
    data: results,
  });
}
