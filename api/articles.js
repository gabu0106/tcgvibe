export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  try {
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tcg_articles?order=published_at.desc&limit=6`,
      {
        headers: {
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        },
      }
    );

    if (!dbRes.ok) throw new Error('DB error');

    const articles = await dbRes.json();

    if (!articles || articles.length === 0) {
      return res.status(200).json({
        articles: [
          { title: 'ポケカ最新環境まとめ', tag: '環境解説', summary: '現在の環境トップデッキを解説します', emoji: '🃏', date: new Date().toLocaleDateString('ja-JP') },
          { title: '今週の注目高騰カード', tag: '価格情報', summary: '今週値上がりが予想されるカードを紹介', emoji: '📈', date: new Date().toLocaleDateString('ja-JP') },
          { title: '最新大会結果レポート', tag: '大会レポート', summary: '直近の大会優勝デッキを分析', emoji: '🏆', date: new Date().toLocaleDateString('ja-JP') },
        ]
      });
    }

    return res.status(200).json({
      articles: articles.map(a => ({
        id: a.id,
        title: a.title,
        tag: a.tag,
        summary: a.summary,
        emoji: a.emoji || '🃏',
        date: new Date(a.published_at).toLocaleDateString('ja-JP'),
        content: a.content,
      }))
    });

  } catch (err) {
    console.error('Articles error:', err);
    return res.status(200).json({
      articles: [
        { title: 'ポケカ最新環境まとめ', tag: '環境解説', summary: '現在の環境トップデータを解説します', emoji: '🃏', date: new Date().toLocaleDateString('ja-JP') },
        { title: '今週の注目高騰カード', tag: '価格情報', summary: '今週値上がりが予想されるカードを紹介', emoji: '📈', date: new Date().toLocaleDateString('ja-JP') },
        { title: '最新大会結果レポート', tag: '大会レポート', summary: '直近の大会優勝デッキを分析', emoji: '🏆', date: new Date().toLocaleDateString('ja-JP') },
      ]
    });
  }
}
