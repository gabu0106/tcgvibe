const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { game, set_id, rarity, search, limit, offset, action } = req.query;

    // カード名で画像をマッチングして返す
    if (action === 'match') {
      const cardName = req.query.card_name;
      if (!cardName) return res.status(400).json({ error: 'card_name必須' });

      // 完全一致 → 部分一致の順で検索
      let url = `${SUPABASE_URL}/rest/v1/card_images?select=image_small,image_large,card_name_en,rarity,set_name&card_name_en=ilike.*${encodeURIComponent(cardName)}*&limit=1`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return res.status(200).json({ match: data[0] });
      }
      return res.status(200).json({ match: null });
    }

    // 一括マッチング: card_pricesとcard_imagesをカード名で結合
    if (action === 'match_prices') {
      const g = game || 'pokeca';
      // card_pricesを取得
      let priceUrl = `${SUPABASE_URL}/rest/v1/card_prices?select=id,card_name,buy_price,rarity,shop,pack_name,model_number&limit=5000`;
      if (g) priceUrl += `&game=eq.${g}`;
      const priceRes = await fetch(priceUrl, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const prices = await priceRes.json();

      // card_imagesを取得（同ゲーム）
      let imgUrl = `${SUPABASE_URL}/rest/v1/card_images?select=card_name_en,image_small,set_id&game=eq.${g}&limit=50000`;
      const imgRes = await fetch(imgUrl, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const images = await imgRes.json();

      // 画像マップを構築（カード名の英語→画像URL）
      const imageMap = {};
      if (Array.isArray(images)) {
        for (const img of images) {
          if (img.card_name_en && img.image_small) {
            const key = img.card_name_en.toLowerCase();
            if (!imageMap[key]) imageMap[key] = img.image_small;
          }
        }
      }

      // 価格データに画像URLを付与
      const matched = (Array.isArray(prices) ? prices : []).map(p => {
        const name = (p.card_name || '').toLowerCase().trim();
        // 完全一致 → 部分一致
        let image = imageMap[name] || null;
        if (!image) {
          for (const [key, url] of Object.entries(imageMap)) {
            if (key.includes(name) || name.includes(key)) {
              image = url;
              break;
            }
          }
        }
        return { ...p, image_url: image };
      });

      const matchedCount = matched.filter(m => m.image_url).length;
      return res.status(200).json({ prices: matched, total: matched.length, matched: matchedCount });
    }

    // セット一覧を取得
    if (action === 'sets') {
      let url = `${SUPABASE_URL}/rest/v1/card_sets?select=set_id,set_name,set_name_en,game,release_date,total_cards,logo_url,symbol_url&order=release_date.desc`;
      if (game) url += `&game=eq.${game}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const data = await response.json();
      return res.status(200).json({ sets: Array.isArray(data) ? data : [] });
    }

    // カード画像一覧（メイン）
    let url = `${SUPABASE_URL}/rest/v1/card_images?select=*&order=id.asc`;
    if (game) url += `&game=eq.${game}`;
    if (set_id) url += `&set_id=eq.${set_id}`;
    if (rarity) url += `&rarity=eq.${rarity}`;
    if (search) url += `&card_name_en=ilike.*${encodeURIComponent(search)}*`;
    url += `&limit=${parseInt(limit) || 100}`;
    if (offset) url += `&offset=${parseInt(offset)}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
    });
    const data = await response.json();
    return res.status(200).json({ cards: Array.isArray(data) ? data : [], count: Array.isArray(data) ? data.length : 0 });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
