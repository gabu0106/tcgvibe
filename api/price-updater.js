const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const diagnostics = [];

/*
  実テーブル構造:
  psa_prices:    id, card_name, game, ebay_price, ebay_count, snkrdunk_price, estimated_price, source, updated_at
  price_history: id, card_name, price, shop, recorded_at
*/

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

// 主要日本語カード名→eBay検索用英語キーワードマッピング
const JA_TO_EN = {
  'リーリエ':'Lillie','アセロラ':'Acerola','ルチア':'Lucia','がんばリーリエ':'Lillie Full Art',
  'リザードン':'Charizard','リザードンex':'Charizard ex','リザードンVSTAR':'Charizard VSTAR','リザードンVMAX':'Charizard VMAX',
  'ピカチュウ':'Pikachu','ピカチュウex':'Pikachu ex','ピカチュウVMAX':'Pikachu VMAX','ピカチュウV':'Pikachu V',
  'レックウザVMAX':'Rayquaza VMAX','レックウザVMAX(SA)':'Rayquaza VMAX Alt Art',
  'ミュウツー':'Mewtwo','ミュウツーex':'Mewtwo ex','ミュウ':'Mew','ミュウex':'Mew ex',
  'ブラッキー':'Umbreon','ブラッキーex':'Umbreon ex','ブラッキーVMAX':'Umbreon VMAX',
  'ニンフィア':'Sylveon','ニンフィアVMAX':'Sylveon VMAX',
  'マリィ':'Marnie','マリィのプライド':'Marnie Pride',
  'カイ':'Irida','ナンジャモ':'Iono','セレナ':'Serena','カミツレのきらめき':'Elesa Sparkle',
  'ギラティナVSTAR':'Giratina VSTAR','パルキアVSTAR':'Palkia VSTAR',
  'ルギアVSTAR':'Lugia VSTAR','アルセウスVSTAR':'Arceus VSTAR',
  'サーナイトex':'Gardevoir ex','ミライドンex':'Miraidon ex','コライドンex':'Koraidon ex',
  'エーフィVMAX':'Espeon VMAX','グレイシアVSTAR':'Glaceon VSTAR',
  'ロケット団のミュウツーex':'Team Rocket Mewtwo ex',
  'ブラッキーVMAX(SA)':'Umbreon VMAX Alt Art','ブラッキーEX':'Umbreon EX',
  'レシラム(15周年)':'Reshiram 15th Anniversary','ゼクロム(15周年)':'Zekrom 15th Anniversary',
  'ラティアス＆ラティオスGX(SA)':'Latias Latios GX Alt Art',
  'ゲンガー＆ミミッキュGX(SA)':'Gengar Mimikyu GX Alt Art',
  'ピカチュウEX':'Pikachu EX','ゲンガーEX':'Gengar EX','アイリス':'Iris',
  'ルギア':'Lugia','ルギアVSTAR':'Lugia VSTAR','レックウザ':'Rayquaza',
  'リザードン(アンリミ)':'Charizard Base Set','ルチア':'Lucia SR',
  'エリカの招待':'Erika Invitation','エリカのおもてなし':'Erika Hospitality',
  'かんこうきゃく':'Tourist','ミモザ':'Miriam','ボタン':'Penny',
  'オモダカ':'Brassius','キバナ':'Raihan','メロン':'Melony',
};

function toEnglish(jaName) {
  // 完全一致
  if (JA_TO_EN[jaName]) return JA_TO_EN[jaName];
  // 括弧除去して再試行
  const base = jaName.replace(/[（(].*[）)]/g, '').trim();
  if (JA_TO_EN[base]) return JA_TO_EN[base];
  // ローマ字読みはできないので日本語のまま返す（eBayで日本語検索も一部ヒットする）
  return jaName;
}

async function fetchPsa10Price(cardName, game = 'pokeca') {
  const token = await getEbayToken();
  const gameQuery = game === 'pokeca' ? 'pokemon card' : 'one piece card';
  const enName = toEnglish(cardName);
  const query = `${gameQuery} ${enName} PSA 10`;
  const params = new URLSearchParams({
    q: query, limit: '50', category_ids: '183454', sort: 'price',
  });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  // PSA10フィルタ: "PSA 10", "PSA10", "PSA GEM MT 10" 等にマッチ
  const prices = (data.itemSummaries || [])
    .filter(item => {
      const t = (item.title || '').toUpperCase();
      return /PSA\s*10|PSA\s*GEM\s*(MT|MINT)\s*10|GEM\s*MINT\s*10/.test(t);
    })
    .map(item => parseFloat(item.price?.value || 0))
    .filter(p => p > 0)
    .map(p => Math.round(p * 150)); // USD→JPY

  if (prices.length === 0) return null;
  return {
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    count: prices.length,
  };
}

// ===== カードラッシュメディア 買取価格スクレイピング =====

const CARDRUSH_GAMES = {
  pokeca: { path: 'pokemon', game: 'pokeca' },
  onepiece: { path: 'onepiece', game: 'onepiece' },
};

async function fetchCardrushPage(gamePath, page, limit = 100) {
  const url = `https://cardrush.media/${gamePath}/buying_prices?limit=${limit}&page=${page}&sort[key]=amount&sort[order]=desc`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TCGVibe-PriceBot/1.0 (+https://tcgvibe.com)' },
  });
  if (!res.ok) throw new Error(`cardrush ${gamePath} page${page}: ${res.status}`);
  const html = await res.text();
  const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">(.*?)<\/script>/s);
  if (!match) throw new Error(`__NEXT_DATA__ not found: ${gamePath} page${page}`);
  const data = JSON.parse(match[1]);
  const props = data?.props?.pageProps;
  return {
    items: props?.buyingPrices || [],
    lastPage: props?.lastPage || 1,
  };
}

function cardrushToCardPrice(item, game) {
  const name = item.extra_difference
    ? `${item.name}（${item.extra_difference}）`
    : item.name;
  return {
    card_name: name,
    buy_price: `¥${item.amount}`,
    rarity: item.rarity || '-',
    shop: 'カードラッシュ',
    game,
    pack_name: item.pack_code || '',
    model_number: item.model_number || '',
  };
}

function cardrushToCardImage(item, game) {
  const imageUrl = item.ocha_product?.image_source || null;
  if (!imageUrl) return null;
  const name = item.extra_difference
    ? `${item.name}（${item.extra_difference}）`
    : item.name;
  return {
    card_id: `cardrush-${game}-${item.id}`,
    card_name: name,
    card_name_en: null,
    number: item.model_number || '',
    rarity: item.rarity || '-',
    set_name: item.pack_code || '',
    set_id: item.pack_code || '',
    image_small: imageUrl,
    image_large: imageUrl,
    game,
  };
}

async function scrapeBuyPrices(maxPages = 10) {
  diagnostics.push('カードラッシュ買取価格スクレイピング開始');
  let totalPricesSaved = 0;
  let totalImagesSaved = 0;

  for (const [, cfg] of Object.entries(CARDRUSH_GAMES)) {
    try {
      // 既存のカードラッシュデータを削除
      await supabaseDelete('card_prices', `shop=eq.カードラッシュ&game=eq.${cfg.game}`);
      await supabaseDelete('card_images', `card_id=like.cardrush-${cfg.game}-*`);
      diagnostics.push(`${cfg.game}: 旧データ削除完了`);

      const rawItems = [];
      const first = await fetchCardrushPage(cfg.path, 1);
      rawItems.push(...first.items);
      const pages = Math.min(first.lastPage, maxPages);
      diagnostics.push(`${cfg.game}: ${first.lastPage}ページ中${pages}ページ取得予定`);

      for (let p = 2; p <= pages; p++) {
        await sleep(500);
        try {
          const page = await fetchCardrushPage(cfg.path, p);
          rawItems.push(...page.items);
        } catch (e) { diagnostics.push(`${cfg.game} page${p}失敗: ${e.message}`); }
      }

      // 重複除去（同名+同型番で高い方を優先＝先に来る）
      const seen = new Set();
      const uniqueItems = rawItems.filter(item => {
        const name = item.extra_difference ? `${item.name}（${item.extra_difference}）` : item.name;
        const key = `${name}__${item.model_number || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // card_prices バッチ挿入
      const priceRecords = uniqueItems.map(i => cardrushToCardPrice(i, cfg.game));
      let priceSaved = 0;
      for (let i = 0; i < priceRecords.length; i += 50) {
        const batch = priceRecords.slice(i, i + 50);
        const result = await supabasePost('card_prices', batch);
        if (result) priceSaved += batch.length;
      }
      totalPricesSaved += priceSaved;

      // card_images バッチ挿入
      const imageRecords = uniqueItems.map(i => cardrushToCardImage(i, cfg.game)).filter(Boolean);
      let imageSaved = 0;
      for (let i = 0; i < imageRecords.length; i += 50) {
        const batch = imageRecords.slice(i, i + 50);
        const result = await supabasePost('card_images', batch);
        if (result) imageSaved += batch.length;
      }
      totalImagesSaved += imageSaved;

      diagnostics.push(`${cfg.game}: 価格${priceSaved}件, 画像${imageSaved}件保存`);
    } catch (e) {
      diagnostics.push(`${cfg.game}失敗: ${e.message}`);
    }
  }

  diagnostics.push(`カードラッシュ合計: 価格${totalPricesSaved}件, 画像${totalImagesSaved}件`);
  return { prices_saved: totalPricesSaved, images_saved: totalImagesSaved };
}

// ===== 平均買取価格計算 =====

async function calcAverageBuyPrices() {
  diagnostics.push('平均買取価格計算開始');
  const allPrices = [];
  let offset = 0;
  while (true) {
    const page = await supabaseGet('card_prices', `select=card_name,buy_price,shop,game&limit=1000&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    allPrices.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  const grouped = {};
  for (const p of allPrices) {
    if (!p.card_name || !p.buy_price) continue;
    const price = parseInt((p.buy_price || '0').replace(/[^0-9]/g, ''));
    if (price <= 0) continue;
    const key = p.card_name;
    if (!grouped[key]) grouped[key] = { prices: [], shops: new Set(), card_name: p.card_name };
    grouped[key].prices.push(price);
    grouped[key].shops.add(p.shop);
  }

  const results = {};
  for (const [key, data] of Object.entries(grouped)) {
    const avg = Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length);
    results[key] = { card_name: data.card_name, avg_buy_price: avg, shop_count: data.shops.size, shops: [...data.shops].join(',') };
  }

  diagnostics.push(`平均買取価格: ${Object.keys(results).length}カード計算完了`);
  return results;
}

// ===== PSA10価格更新 =====

async function updatePsa10Prices(cardLimit = 15) {
  diagnostics.push('PSA10価格更新開始');
  if (!EBAY_APP_ID || !EBAY_CERT_ID) { diagnostics.push('eBay認証なし、スキップ'); return { updated: 0 }; }

  // 高額カードTOP N
  const allPrices = [];
  let offset = 0;
  while (true) {
    const page = await supabaseGet('card_prices', `select=card_name,buy_price,game&limit=1000&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    allPrices.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  const seen = new Set();
  const topCards = allPrices
    .map(p => ({ ...p, n: parseInt((p.buy_price || '0').replace(/[^0-9]/g, '')) }))
    .filter(p => p.n > 0)
    .sort((a, b) => b.n - a.n)
    .filter(p => { if (seen.has(p.card_name)) return false; seen.add(p.card_name); return true; })
    .slice(0, cardLimit);

  diagnostics.push(`PSA10: TOP${topCards.length}カードをeBay検索`);

  // 既存データ削除
  await supabaseDelete('psa_prices', 'source=eq.ebay');

  let updated = 0;
  for (const card of topCards) {
    try {
      const ebay = await fetchPsa10Price(card.card_name, card.game || 'pokeca');
      await sleep(1500);
      if (ebay) {
        await supabasePost('psa_prices', {
          card_name: card.card_name,
          game: card.game || 'pokeca',
          ebay_price: ebay.avg,
          ebay_count: ebay.count,
          estimated_price: ebay.avg,
          source: 'ebay',
        });
        updated++;
        diagnostics.push(`${card.card_name}(${toEnglish(card.card_name)}): PSA10 ¥${ebay.avg.toLocaleString()} (${ebay.count}件)`);
      } else {
        diagnostics.push(`${card.card_name}(${toEnglish(card.card_name)}): PSA10該当なし`);
      }
    } catch (e) { diagnostics.push(`${card.card_name} 失敗: ${e.message}`); }
  }

  diagnostics.push(`PSA10更新完了: ${updated}/${topCards.length}カード`);
  return { updated };
}

// ===== 価格履歴記録 =====

async function recordPriceHistory() {
  diagnostics.push('価格履歴記録開始');
  const today = new Date().toISOString().split('T')[0];

  const existing = await supabaseGet('price_history', `recorded_at=eq.${today}&limit=1`);
  if (Array.isArray(existing) && existing.length > 0) {
    diagnostics.push('今日の履歴は記録済み');
    return { recorded: 0 };
  }

  const avgPrices = await calcAverageBuyPrices();
  // price_historyカラム: card_name, price, shop, recorded_at
  const records = Object.values(avgPrices).map(p => ({
    card_name: p.card_name,
    price: p.avg_buy_price,
    shop: p.shops,
    recorded_at: today,
  }));

  let saved = 0;
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50);
    const result = await supabasePost('price_history', batch);
    if (result) saved += batch.length;
  }

  diagnostics.push(`価格履歴: ${saved}/${records.length}件記録`);
  return { recorded: saved };
}

// ===== 高騰検知 =====

async function detectPriceSurges(thresholdPercent = 15) {
  diagnostics.push('高騰検知開始');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const [todayPrices, yesterdayPrices] = await Promise.all([
    supabaseGet('price_history', `recorded_at=eq.${today}&select=card_name,price&limit=1000`),
    supabaseGet('price_history', `recorded_at=eq.${yesterday}&select=card_name,price&limit=1000`),
  ]);

  if (!Array.isArray(todayPrices) || !Array.isArray(yesterdayPrices)) {
    diagnostics.push('価格履歴データ不足');
    return { surges: [] };
  }

  const yMap = {};
  for (const p of yesterdayPrices) { if (p.card_name && p.price) yMap[p.card_name] = p.price; }

  const surges = [];
  for (const p of todayPrices) {
    if (!p.card_name || !p.price) continue;
    const prev = yMap[p.card_name];
    if (!prev || prev <= 0) continue;
    const change = ((p.price - prev) / prev) * 100;
    if (change >= thresholdPercent) {
      surges.push({ card_name: p.card_name, prev_price: prev, current_price: p.price, change_percent: Math.round(change) });
    }
  }

  surges.sort((a, b) => b.change_percent - a.change_percent);
  diagnostics.push(`高騰検知: ${surges.length}カード検出`);
  return { surges };
}

async function sendSurgeAlerts(surges) {
  if (!surges || surges.length === 0) return;
  let msg = `🚨 高騰アラート (${new Date().toLocaleDateString('ja-JP')})\n\n`;
  for (const s of surges.slice(0, 10)) {
    msg += `📈 ${s.card_name}\n  ¥${s.prev_price.toLocaleString()} → ¥${s.current_price.toLocaleString()} (+${s.change_percent}%)\n\n`;
  }
  if (surges.length > 10) msg += `...他${surges.length - 10}件`;
  await sendLine(msg);
  diagnostics.push(`高騰アラート送信: ${Math.min(surges.length, 10)}件`);
}

// ===== メインハンドラ =====

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Price updater ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, card_limit, threshold } = req.body || {};
  diagnostics.length = 0;

  // 書き込み系アクションは内部APIキー必須、読み取りはフロントから許可
  const writeActions = ['update_psa10', 'record_history', 'detect_surges', 'daily_update', 'avg_prices', 'scrape_buyprices'];
  if (writeActions.includes(action)) {
    const key = req.headers['x-api-key'] || req.body?.api_key;
    if (!key || key !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    if (action === 'avg_prices') {
      const results = await calcAverageBuyPrices();
      return res.status(200).json({ status: 'done', count: Object.keys(results).length, prices: results, diagnostics });
    }

    if (action === 'update_psa10') {
      const result = await updatePsa10Prices(parseInt(card_limit) || 15);
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'record_history') {
      const result = await recordPriceHistory();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'detect_surges') {
      const result = await detectPriceSurges(parseInt(threshold) || 15);
      if (result.surges.length > 0) await sendSurgeAlerts(result.surges);
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    // フロントエンド用: PSA10価格
    if (action === 'get_psa10') {
      const prices = await supabaseGet('psa_prices', 'order=estimated_price.desc&limit=100');
      return res.status(200).json({ prices: Array.isArray(prices) ? prices : [] });
    }

    // フロントエンド用: 高騰カード
    if (action === 'get_surges') {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const [tP, yP] = await Promise.all([
        supabaseGet('price_history', `recorded_at=eq.${today}&select=card_name,price&limit=1000`),
        supabaseGet('price_history', `recorded_at=eq.${yesterday}&select=card_name,price&limit=1000`),
      ]);
      const yMap = {};
      if (Array.isArray(yP)) for (const p of yP) { if (p.card_name && p.price) yMap[p.card_name] = p.price; }
      const surges = [];
      if (Array.isArray(tP)) {
        for (const p of tP) {
          if (!p.card_name || !p.price || !yMap[p.card_name]) continue;
          const c = ((p.price - yMap[p.card_name]) / yMap[p.card_name]) * 100;
          if (c >= 5) surges.push({ card_name: p.card_name, change_percent: Math.round(c), current_price: p.price, prev_price: yMap[p.card_name] });
        }
      }
      surges.sort((a, b) => b.change_percent - a.change_percent);
      return res.status(200).json({ surges: surges.slice(0, 30) });
    }

    // カードラッシュ買取価格スクレイピング
    if (action === 'scrape_buyprices') {
      const result = await scrapeBuyPrices(parseInt(card_limit) || 10);
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    // 日次バッチ
    if (action === 'daily_update') {
      const history = await recordPriceHistory();
      await sleep(1000);
      let psa = { updated: 0 };
      if (EBAY_APP_ID && EBAY_CERT_ID) {
        psa = await updatePsa10Prices(parseInt(card_limit) || 15);
      } else { diagnostics.push('eBay認証なし、PSA10スキップ'); }
      const surges = await detectPriceSurges(parseInt(threshold) || 15);
      if (surges.surges.length > 0) await sendSurgeAlerts(surges.surges);
      return res.status(200).json({ status: 'done', history, psa10: psa.updated, surges: surges.surges.length, diagnostics });
    }

    return res.status(400).json({ error: 'action必須', actions: ['avg_prices','update_psa10','record_history','detect_surges','get_psa10','get_surges','daily_update','scrape_buyprices'] });
  } catch (e) {
    return res.status(500).json({ error: e.message, diagnostics });
  }
}
