export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  // DELETE
  if (req.method === 'DELETE') {
    const { id } = req.query;
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: '認証エラー' });
    }
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/tcg_articles?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
          'apikey': SUPABASE_SECRET_KEY,
        },
      });
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET
  try {
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tcg_articles?order=published_at.desc&limit=20&select=id,game,tag,title,summary,content,emoji,author,author_x,published_at`,
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
      return res.status(200).json({ articles: [] });
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
        author: a.author || '',
        authorX: a.author_x || '',
      }))
    });

  } catch (err) {
    console.error('Articles error:', err);
    return res.status(200).json({ articles: [] });
  }
}
