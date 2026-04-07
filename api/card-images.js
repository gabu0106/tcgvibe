const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

async function supabaseGet(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
  });
  return await res.json();
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, game, pack, search, limit } = req.query;
    const g = game || 'pokeca';

    // パック一覧: card_prices から shop=カードラッシュ の distinct pack_name を集計
    if (action === 'packs') {
      // card_pricesを全件取得してJSで集計（Supabase RESTにGROUP BYはない）
      const allCards = [];
      let offset = 0;
      while (true) {
        const page = await supabaseGet(`card_prices?select=pack_name,model_number&shop=eq.カードラッシュ&game=eq.${g}&limit=1000&offset=${offset}`);
        if (!Array.isArray(page) || page.length === 0) break;
        allCards.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
      }
      const packMap = {};
      for (const c of allCards) {
        const p = c.pack_name || '不明';
        if (!packMap[p]) packMap[p] = 0;
        packMap[p]++;
      }
      const packs = Object.entries(packMap)
        .map(([name, count]) => ({ pack_name: name, card_count: count }))
        .sort((a, b) => b.card_count - a.card_count);
      return res.status(200).json({ packs });
    }

    // パック内カード一覧: card_prices + card_images をJSでJOIN
    if (action === 'cards') {
      if (!pack) return res.status(400).json({ error: 'pack必須' });

      // card_prices（該当パック）
      const prices = await supabaseGet(
        `card_prices?select=card_name,buy_price,rarity,pack_name,model_number&shop=eq.カードラッシュ&game=eq.${g}&pack_name=eq.${encodeURIComponent(pack)}&limit=1000&order=model_number.asc`
      );

      // card_images（該当パック、cardrushソース）
      const images = await supabaseGet(
        `card_images?select=card_name,image_small,number,rarity&card_id=like.cardrush-${g}-*&set_id=eq.${encodeURIComponent(pack)}&limit=1000`
      );
      const imgMap = {};
      if (Array.isArray(images)) {
        for (const img of images) {
          if (img.card_name && img.image_small) imgMap[img.card_name] = img.image_small;
        }
      }

      const cards = (Array.isArray(prices) ? prices : []).map(p => ({
        card_name: p.card_name,
        buy_price: p.buy_price,
        rarity: p.rarity,
        pack_name: p.pack_name,
        model_number: p.model_number,
        image_url: imgMap[p.card_name] || null,
      }));

      return res.status(200).json({ cards, total: cards.length });
    }

    // カード検索
    if (action === 'search') {
      if (!search) return res.status(400).json({ error: 'search必須' });
      const q = encodeURIComponent(search);
      const prices = await supabaseGet(
        `card_prices?select=card_name,buy_price,rarity,pack_name,model_number&shop=eq.カードラッシュ&game=eq.${g}&card_name=ilike.*${q}*&limit=${parseInt(limit) || 200}&order=model_number.asc`
      );
      // 画像をまとめて取得
      const images = await supabaseGet(
        `card_images?select=card_name,image_small&card_id=like.cardrush-${g}-*&card_name=ilike.*${q}*&limit=500`
      );
      const imgMap = {};
      if (Array.isArray(images)) {
        for (const img of images) {
          if (img.card_name && img.image_small) imgMap[img.card_name] = img.image_small;
        }
      }
      const cards = (Array.isArray(prices) ? prices : []).map(p => ({
        card_name: p.card_name,
        buy_price: p.buy_price,
        rarity: p.rarity,
        pack_name: p.pack_name,
        model_number: p.model_number,
        image_url: imgMap[p.card_name] || null,
      }));
      return res.status(200).json({ cards, total: cards.length });
    }

    // 高額カードランキング
    if (action === 'ranking') {
      const rankLimit = parseInt(limit) || 20;
      const allPrices = [];
      let offset = 0;
      while (true) {
        const page = await supabaseGet(`card_prices?select=card_name,buy_price,rarity,pack_name,model_number&shop=eq.カードラッシュ&game=eq.${g}&limit=1000&offset=${offset}`);
        if (!Array.isArray(page) || page.length === 0) break;
        allPrices.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
      }
      // 画像
      const images = [];
      let imgOff = 0;
      while (true) {
        const pg = await supabaseGet(`card_images?select=card_name,image_small&card_id=like.cardrush-${g}-*&limit=1000&offset=${imgOff}`);
        if (!Array.isArray(pg) || pg.length === 0) break;
        images.push(...pg);
        if (pg.length < 1000) break;
        imgOff += 1000;
      }
      const imgMap = {};
      for (const img of images) {
        if (img.card_name && img.image_small) imgMap[img.card_name] = img.image_small;
      }

      const seen = new Set();
      const ranking = allPrices
        .map(p => ({ ...p, price_num: parseInt((p.buy_price || '0').replace(/[^0-9]/g, '')) }))
        .filter(p => p.price_num > 0)
        .sort((a, b) => b.price_num - a.price_num)
        .filter(p => { if (seen.has(p.card_name)) return false; seen.add(p.card_name); return true; })
        .slice(0, rankLimit)
        .map((p, i) => ({ ...p, rank: i + 1, image_url: imgMap[p.card_name] || null }));

      return res.status(200).json({ ranking });
    }

    return res.status(400).json({ error: 'action必須', actions: ['packs', 'cards', 'ranking', 'search'] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
