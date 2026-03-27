export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  try {
    const { game, rarity, shop, search, page = 1 } = req.query;
    const limit = 50;
    const offset = (page - 1) * limit;

    let url = `${SUPABASE_URL}/rest/v1/card_prices?select=*&order=buy_price.desc&limit=${limit}&offset=${offset}`;

    if (game) url += `&game=eq.${game}`;
    if (rarity) url += `&rarity=eq.${rarity}`;
    if (shop) url += `&shop=eq.${shop}`;
    if (search) url += `&card_name=ilike.*${search}*`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
      }
    });

    const data = await response.json();
    return res.status(200).json({ prices: data });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
