const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

// カードラッシュデータではsell_priceフィールドに画像URLを格納
// 画像URL形式: https://files.cardrush.media/{pokemon|onepiece}/ocha_products/{id}.webp

const SELECT_FIELDS = 'card_name,buy_price,sell_price,rarity,pack_name,model_number';

async function supabaseGet(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
  });
  return await res.json();
}

function toCard(p) {
  return {
    card_name: p.card_name,
    buy_price: p.buy_price,
    rarity: p.rarity,
    pack_name: p.pack_name,
    model_number: p.model_number,
    image_url: (p.sell_price && p.sell_price.startsWith('http')) ? p.sell_price : null,
  };
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

    // パック一覧（card_setsとマージして正式名・発売日を付与）
    if (action === 'packs') {
      // card_pricesからパック集計
      const allCards = [];
      let offset = 0;
      while (true) {
        const page = await supabaseGet(`card_prices?select=pack_name&shop=eq.カードラッシュ&game=eq.${g}&limit=1000&offset=${offset}`);
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

      // card_setsからセット情報を取得（set_name, release_date, total_cards）
      const sets = await supabaseGet(`card_sets?select=set_id,set_name,release_date,total_cards,logo_url&game=eq.${g}&limit=500`);
      const setMap = {};
      if (Array.isArray(sets)) {
        for (const s of sets) {
          if (s.set_id) setMap[s.set_id.toLowerCase()] = s;
        }
      }

      const packs = Object.entries(packMap).map(([code, count]) => {
        const setInfo = setMap[code.toLowerCase()] || null;
        return {
          pack_name: code,
          display_name: setInfo?.set_name || code,
          release_date: setInfo?.release_date || null,
          total_cards: setInfo?.total_cards || null,
          logo_url: setInfo?.logo_url || null,
          card_count: count,
        };
      });

      // 発売日ありを日付降順 → 発売日なしをカード数降順
      packs.sort((a, b) => {
        if (a.release_date && b.release_date) return b.release_date.localeCompare(a.release_date);
        if (a.release_date) return -1;
        if (b.release_date) return 1;
        return b.card_count - a.card_count;
      });

      return res.status(200).json({ packs });
    }

    // パック内カード一覧（sell_priceに画像URL格納済み）
    if (action === 'cards') {
      if (!pack) return res.status(400).json({ error: 'pack必須' });
      const prices = await supabaseGet(
        `card_prices?select=${SELECT_FIELDS}&shop=eq.カードラッシュ&game=eq.${g}&pack_name=eq.${encodeURIComponent(pack)}&limit=1000&order=model_number.asc`
      );
      const cards = (Array.isArray(prices) ? prices : []).map(toCard);
      return res.status(200).json({ cards, total: cards.length });
    }

    // カード検索
    if (action === 'search') {
      if (!search) return res.status(400).json({ error: 'search必須' });
      const prices = await supabaseGet(
        `card_prices?select=${SELECT_FIELDS}&shop=eq.カードラッシュ&game=eq.${g}&card_name=ilike.*${encodeURIComponent(search)}*&limit=${parseInt(limit) || 200}&order=model_number.asc`
      );
      const cards = (Array.isArray(prices) ? prices : []).map(toCard);
      return res.status(200).json({ cards, total: cards.length });
    }

    // 高額カードランキング
    if (action === 'ranking') {
      const rankLimit = parseInt(limit) || 20;
      const allPrices = [];
      let offset = 0;
      while (true) {
        const page = await supabaseGet(`card_prices?select=${SELECT_FIELDS}&shop=eq.カードラッシュ&game=eq.${g}&limit=1000&offset=${offset}`);
        if (!Array.isArray(page) || page.length === 0) break;
        allPrices.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
      }

      const seen = new Set();
      const ranking = allPrices
        .map(p => ({ ...toCard(p), price_num: parseInt((p.buy_price || '0').replace(/[^0-9]/g, '')) }))
        .filter(p => p.price_num > 0)
        .sort((a, b) => b.price_num - a.price_num)
        .filter(p => { if (seen.has(p.card_name)) return false; seen.add(p.card_name); return true; })
        .slice(0, rankLimit)
        .map((p, i) => ({ ...p, rank: i + 1 }));

      return res.status(200).json({ ranking });
    }

    // 画像プロキシ（CORS回避用 — cardrush.media画像をCanvas描画するために使用）
    if (action === 'proxy') {
      const imgUrl = req.query.url;
      if (!imgUrl || !imgUrl.startsWith('https://files.cardrush.media/')) {
        return res.status(400).json({ error: 'cardrush.media URLのみ対応' });
      }
      try {
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) return res.status(imgRes.status).end();
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get('content-type') || 'image/webp';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(buf);
      } catch (e) {
        return res.status(502).json({ error: 'proxy fetch failed' });
      }
    }

    return res.status(400).json({ error: 'action必須', actions: ['packs', 'cards', 'ranking', 'search', 'proxy'] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
