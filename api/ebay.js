const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;

let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`eBay OAuth失敗: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function searchEbay(query, limit = 10) {
  const token = await getEbayToken();

  // Browse API で検索 (eBay US + 完了済みリストも含む)
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    category_ids: '183454',  // Collectible Card Games
    sort: 'price',
    filter: 'deliveryCountry:US,conditions:{NEW}',
  });

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>',
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`eBay検索失敗: ${res.status} ${err}`);
  }

  const data = await res.json();
  const items = (data.itemSummaries || []).map(item => ({
    title: item.title,
    price: item.price ? `${item.price.currency} ${item.price.value}` : null,
    price_value: item.price ? parseFloat(item.price.value) : 0,
    currency: item.price?.currency || 'USD',
    condition: item.condition,
    url: item.itemWebUrl,
    image: item.image?.imageUrl || null,
    seller: item.seller?.username || null,
  }));

  // 統計情報を計算
  const prices = items.filter(i => i.price_value > 0).map(i => i.price_value);
  const stats = prices.length > 0 ? {
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100,
    median: prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)],
    count: prices.length,
  } : null;

  return { items, stats, total: data.total || 0 };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    return res.status(500).json({ error: 'eBay API credentials not configured' });
  }

  const { q, card_name, limit } = req.query;
  const query = q || card_name;

  if (!query) {
    return res.status(400).json({
      error: 'パラメータ q または card_name が必要です',
      usage: '/api/ebay?q=pikachu+vmax+sar',
    });
  }

  try {
    // TCGカード検索用にクエリを最適化
    const searchQuery = `pokemon card ${query}`;
    const result = await searchEbay(searchQuery, parseInt(limit) || 10);

    return res.status(200).json({
      query,
      ...result,
    });
  } catch (e) {
    console.error('eBay APIエラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
