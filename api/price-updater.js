const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const diagnostics = [];

// ===== Supabase helpers =====

async function supabaseGet(table, query = '') {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
    });
    return await res.json();
  } catch { return []; }
}

async function supabasePost(table, data) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });
    if (!res.ok) { diagnostics.push(`supabasePost ${table} ${res.status}: ${(await res.text()).substring(0, 150)}`); return null; }
    return await res.json();
  } catch (e) { diagnostics.push(`supabasePost ${table}: ${e.message}`); return null; }
}

async function supabasePatch(table, query, data) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {}
}

async function supabaseDelete(table, query) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
    });
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendLine(message) {
  try {
    if (!LINE_CHANNEL_ACCESS_TOKEN) return;
    await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ messages: [{ type: 'text', text: message }] }),
    });
  } catch {}
}

/*
  psa_prices テーブル構造（Supabaseで作成が必要）:
  id SERIAL PRIMARY KEY,
  card_name TEXT NOT NULL,
  game TEXT DEFAULT 'pokeca',
  grade TEXT DEFAULT 'PSA10',
  ebay_avg_price INTEGER,        -- eBay平均落札価格（円）
  ebay_min_price INTEGER,        -- eBay最低落札価格（円）
  ebay_max_price INTEGER,        -- eBay最高落札価格（円）
  ebay_count INTEGER,            -- eBay出品数
  snkrdunk_price INTEGER,        -- スニダン価格（円）
  estimated_price INTEGER,       -- 推定PSA10相場（円）
  source TEXT,                   -- 'ebay' or 'snkrdunk' or 'both'
  updated_at TIMESTAMPTZ DEFAULT now()

  price_history テーブル（高騰検知用）:
  id SERIAL PRIMARY KEY,
  card_name TEXT NOT NULL,
  game TEXT DEFAULT 'pokeca',
  buy_price INTEGER,             -- 買取価格（円）
  psa10_price INTEGER,           -- PSA10推定価格（円）
  recorded_at DATE DEFAULT CURRENT_DATE
*/

// ===== eBay API =====

let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!EBAY_APP_ID || !EBAY_CERT_ID) throw new Error('eBay API credentials not configured');
  const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!res.ok) throw new Error(`eBay OAuth失敗: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// PSA10カードの価格をeBayから取得
async function fetchPsa10Price(cardName, game = 'pokeca') {
  const token = await getEbayToken();
  const gameQuery = game === 'pokeca' ? 'pokemon card' : 'one piece card';
  const query = `${gameQuery} ${cardName} PSA 10`;

  const params = new URLSearchParams({
    q: query,
    limit: '20',
    category_ids: '183454',
    sort: 'price',
    filter: 'deliveryCountry:US,conditions:{NEW}',
  });

  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const items = (data.itemSummaries || [])
    .filter(item => {
      const title = (item.title || '').toUpperCase();
      return title.includes('PSA') && title.includes('10');
    })
    .map(item => parseFloat(item.price?.value || 0))
    .filter(p => p > 0);

  if (items.length === 0) return null;

  // USD→JPY変換（概算レート）
  const rate = 150;
  const prices = items.map(p => Math.round(p * rate));

  return {
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    min: Math.min(...prices),
    max: Math.max(...prices),
    count: prices.length,
  };
}

// ===== 平均買取価格計算 =====

async function calcAverageBuyPrices() {
  diagnostics.push('平均買取価格計算開始');

  // card_pricesから全カードを取得
  const allPrices = [];
  let offset = 0;
  while (true) {
    const page = await supabaseGet('card_prices', `select=card_name,buy_price,shop,game&limit=1000&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    allPrices.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  // カード名でグループ化して平均計算
  const grouped = {};
  for (const p of allPrices) {
    if (!p.card_name || !p.buy_price) continue;
    const price = parseInt((p.buy_price || '0').replace(/[^0-9]/g, ''));
    if (price <= 0) continue;
    const key = `${p.card_name}__${p.game || 'pokeca'}`;
    if (!grouped[key]) grouped[key] = { prices: [], shops: new Set(), game: p.game || 'pokeca', card_name: p.card_name };
    grouped[key].prices.push(price);
    grouped[key].shops.add(p.shop);
  }

  const results = {};
  for (const [key, data] of Object.entries(grouped)) {
    const avg = Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length);
    const max = Math.max(...data.prices);
    const min = Math.min(...data.prices);
    results[data.card_name] = {
      card_name: data.card_name,
      game: data.game,
      avg_buy_price: avg,
      max_buy_price: max,
      min_buy_price: min,
      shop_count: data.shops.size,
      shops: [...data.shops].join(','),
    };
  }

  diagnostics.push(`平均買取価格: ${Object.keys(results).length}カード計算完了`);
  return results;
}

// ===== PSA10価格更新 =====

async function updatePsa10Prices(cardLimit = 20) {
  diagnostics.push('PSA10価格更新開始');

  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    diagnostics.push('eBay API認証情報なし、PSA10価格更新スキップ');
    return { updated: 0 };
  }

  // 高額カードTOP N を取得
  const allPrices = [];
  let offset = 0;
  while (true) {
    const page = await supabaseGet('card_prices', `select=card_name,buy_price,game&limit=1000&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    allPrices.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  const sorted = allPrices
    .map(p => ({ ...p, price_num: parseInt((p.buy_price || '0').replace(/[^0-9]/g, '')) }))
    .filter(p => p.price_num > 0)
    .sort((a, b) => b.price_num - a.price_num);

  // 重複除去してTOP N
  const seen = new Set();
  const topCards = [];
  for (const p of sorted) {
    if (!seen.has(p.card_name)) { seen.add(p.card_name); topCards.push(p); }
    if (topCards.length >= cardLimit) break;
  }

  diagnostics.push(`PSA10: 高額TOP${topCards.length}カードのeBay検索開始`);

  // 既存のpsa_pricesを削除
  await supabaseDelete('psa_prices', 'grade=eq.PSA10');

  let updated = 0;
  const psaResults = [];

  for (const card of topCards) {
    try {
      const ebayPrice = await fetchPsa10Price(card.card_name, card.game || 'pokeca');
      await sleep(1000); // eBayレートリミット対策

      if (ebayPrice) {
        const row = {
          card_name: card.card_name,
          game: card.game || 'pokeca',
          grade: 'PSA10',
          ebay_avg_price: ebayPrice.avg,
          ebay_min_price: ebayPrice.min,
          ebay_max_price: ebayPrice.max,
          ebay_count: ebayPrice.count,
          estimated_price: ebayPrice.avg,
          source: 'ebay',
        };
        await supabasePost('psa_prices', row);
        psaResults.push(row);
        updated++;
        diagnostics.push(`${card.card_name}: PSA10 ¥${ebayPrice.avg.toLocaleString()} (${ebayPrice.count}件)`);
      }
    } catch (e) {
      diagnostics.push(`${card.card_name} PSA10取得失敗: ${e.message}`);
    }
  }

  diagnostics.push(`PSA10価格更新完了: ${updated}/${topCards.length}カード`);
  return { updated, results: psaResults };
}

// ===== 高騰検知 =====

async function detectPriceSurges(thresholdPercent = 15) {
  diagnostics.push('高騰検知開始');

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // 今日と昨日の価格履歴を取得
  const [todayPrices, yesterdayPrices] = await Promise.all([
    supabaseGet('price_history', `recorded_at=eq.${today}&select=card_name,buy_price,game`),
    supabaseGet('price_history', `recorded_at=eq.${yesterday}&select=card_name,buy_price,game`),
  ]);

  if (!Array.isArray(todayPrices) || !Array.isArray(yesterdayPrices)) {
    diagnostics.push('価格履歴データ不足');
    return { surges: [] };
  }

  // 昨日の価格マップ
  const yesterdayMap = {};
  for (const p of yesterdayPrices) {
    if (p.card_name && p.buy_price) yesterdayMap[p.card_name] = p.buy_price;
  }

  // 高騰検知
  const surges = [];
  for (const p of todayPrices) {
    if (!p.card_name || !p.buy_price) continue;
    const prevPrice = yesterdayMap[p.card_name];
    if (!prevPrice || prevPrice <= 0) continue;
    const change = ((p.buy_price - prevPrice) / prevPrice) * 100;
    if (change >= thresholdPercent) {
      surges.push({
        card_name: p.card_name,
        game: p.game || 'pokeca',
        prev_price: prevPrice,
        current_price: p.buy_price,
        change_percent: Math.round(change),
      });
    }
  }

  surges.sort((a, b) => b.change_percent - a.change_percent);
  diagnostics.push(`高騰検知: ${surges.length}カード検出`);
  return { surges };
}

// 価格履歴を記録
async function recordPriceHistory() {
  diagnostics.push('価格履歴記録開始');
  const today = new Date().toISOString().split('T')[0];

  // 今日の記録が既にあるかチェック
  const existing = await supabaseGet('price_history', `recorded_at=eq.${today}&limit=1`);
  if (Array.isArray(existing) && existing.length > 0) {
    diagnostics.push('今日の履歴は記録済み');
    return { recorded: 0 };
  }

  // card_pricesから現在の価格を取得して履歴に記録
  const avgPrices = await calcAverageBuyPrices();
  const records = Object.values(avgPrices).map(p => ({
    card_name: p.card_name,
    game: p.game,
    buy_price: p.avg_buy_price,
    recorded_at: today,
  }));

  // PSA10価格も取得して追加
  const psaPrices = await supabaseGet('psa_prices', 'select=card_name,game,estimated_price&grade=eq.PSA10&limit=100');
  if (Array.isArray(psaPrices)) {
    const psaMap = {};
    for (const p of psaPrices) { if (p.card_name && p.estimated_price) psaMap[p.card_name] = p.estimated_price; }
    for (const r of records) {
      if (psaMap[r.card_name]) r.psa10_price = psaMap[r.card_name];
    }
  }

  let saved = 0;
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50);
    const result = await supabasePost('price_history', batch);
    if (result) saved += batch.length;
  }

  diagnostics.push(`価格履歴: ${saved}/${records.length}件記録`);
  return { recorded: saved };
}

// ===== 高騰アラートをLINEに送信 =====

async function sendSurgeAlerts(surges) {
  if (!surges || surges.length === 0) return;

  let msg = `🚨 高騰アラート (${new Date().toLocaleDateString('ja-JP')})\n\n`;
  for (const s of surges.slice(0, 10)) {
    msg += `📈 ${s.card_name}\n`;
    msg += `  前日 ¥${s.prev_price.toLocaleString()} → ¥${s.current_price.toLocaleString()} (+${s.change_percent}%)\n\n`;
  }
  if (surges.length > 10) msg += `...他${surges.length - 10}件`;

  await sendLine(msg);
  diagnostics.push(`高騰アラート送信: ${Math.min(surges.length, 10)}件`);
}

// ===== メインハンドラ =====

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Price updater API ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, card_limit, threshold } = req.body || {};
  diagnostics.length = 0;

  try {
    // 平均買取価格を取得
    if (action === 'avg_prices') {
      const results = await calcAverageBuyPrices();
      return res.status(200).json({ status: 'done', count: Object.keys(results).length, prices: results, diagnostics });
    }

    // PSA10価格を更新
    if (action === 'update_psa10') {
      const result = await updatePsa10Prices(parseInt(card_limit) || 20);
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    // 価格履歴を記録
    if (action === 'record_history') {
      const result = await recordPriceHistory();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    // 高騰検知
    if (action === 'detect_surges') {
      const result = await detectPriceSurges(parseInt(threshold) || 15);
      if (result.surges.length > 0) await sendSurgeAlerts(result.surges);
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    // PSA10価格を取得（フロントエンド用）
    if (action === 'get_psa10') {
      const psaPrices = await supabaseGet('psa_prices', 'grade=eq.PSA10&order=estimated_price.desc&limit=100');
      return res.status(200).json({ prices: Array.isArray(psaPrices) ? psaPrices : [] });
    }

    // 高騰カードを取得（フロントエンド用）
    if (action === 'get_surges') {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const [todayP, yesterdayP] = await Promise.all([
        supabaseGet('price_history', `recorded_at=eq.${today}&select=card_name,buy_price,game&limit=1000`),
        supabaseGet('price_history', `recorded_at=eq.${yesterday}&select=card_name,buy_price,game&limit=1000`),
      ]);
      const yMap = {};
      if (Array.isArray(yesterdayP)) for (const p of yesterdayP) { if (p.card_name && p.buy_price) yMap[p.card_name] = p.buy_price; }
      const surges = [];
      if (Array.isArray(todayP)) {
        for (const p of todayP) {
          if (!p.card_name || !p.buy_price || !yMap[p.card_name]) continue;
          const change = ((p.buy_price - yMap[p.card_name]) / yMap[p.card_name]) * 100;
          if (change >= 5) surges.push({ card_name: p.card_name, game: p.game, change_percent: Math.round(change), current_price: p.buy_price, prev_price: yMap[p.card_name] });
        }
      }
      surges.sort((a, b) => b.change_percent - a.change_percent);
      return res.status(200).json({ surges: surges.slice(0, 30) });
    }

    // 全更新（日次バッチ）
    if (action === 'daily_update') {
      // 1. 価格履歴記録
      const history = await recordPriceHistory();
      await sleep(1000);

      // 2. PSA10価格更新
      let psa = { updated: 0 };
      if (EBAY_APP_ID && EBAY_CERT_ID) {
        psa = await updatePsa10Prices(parseInt(card_limit) || 15);
      } else {
        diagnostics.push('eBay認証なし、PSA10スキップ');
      }

      // 3. 高騰検知+LINE通知
      const surges = await detectPriceSurges(parseInt(threshold) || 15);
      if (surges.surges.length > 0) await sendSurgeAlerts(surges.surges);

      return res.status(200).json({
        status: 'done',
        history,
        psa10: { updated: psa.updated },
        surges: surges.surges.length,
        diagnostics,
      });
    }

    return res.status(400).json({
      error: 'action必須',
      actions: ['avg_prices', 'update_psa10', 'record_history', 'detect_surges', 'get_psa10', 'get_surges', 'daily_update'],
    });
  } catch (e) {
    console.error('price-updater エラー:', e.message);
    return res.status(500).json({ error: e.message, diagnostics });
  }
}
