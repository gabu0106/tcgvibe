// ワンピースカード公式サイトの画像をプロキシして返す
// ブラウザからの直接参照がhotlink protectionでブロックされる場合の対策

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  // 許可するドメインを制限（セキュリティ）
  const allowed = ['www.onepiece-cardgame.com', 'onepiece-cardgame.com'];
  try {
    const parsed = new URL(url);
    if (!allowed.includes(parsed.hostname)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const imgRes = await fetch(url, {
      headers: {
        'Referer': 'https://www.onepiece-cardgame.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!imgRes.ok) return res.status(imgRes.status).end();

    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
