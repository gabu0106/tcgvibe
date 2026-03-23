export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  // GET: 設定を取得
  if (req.method === 'GET') {
    try {
      const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?select=key,value`, {
        headers: {
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        },
      });
      const rows = await dbRes.json();
      const settings = {};
      rows.forEach(r => { settings[r.key] = r.value; });
      return res.status(200).json({ settings });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: 設定を更新（管理者のみ）
  if (req.method === 'POST') {
    const { adminKey, key, value } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: '認証エラー' });
    }
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/site_settings?key=eq.${key}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
          'apikey': SUPABASE_SECRET_KEY,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
      });
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }
}
