const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY || '';

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
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.text();
      diagnostics.push(`supabasePost ${table} ${res.status}: ${err.substring(0, 150)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    diagnostics.push(`supabasePost ${table} 例外: ${e.message}`);
    return null;
  }
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

/*
  テーブル構造:
  card_sets:   id, set_id, set_name, set_name_en, game, release_date, total_cards, symbol_url, logo_url, created_at
  card_images: id, card_id, card_name, card_name_en, number, rarity, set_name, set_id, image_small, image_large, game, created_at
*/

// ===== Pokemon TCG API =====

async function pokemonTcgFetch(endpoint) {
  const headers = { 'Accept': 'application/json' };
  if (POKEMON_TCG_API_KEY) headers['X-Api-Key'] = POKEMON_TCG_API_KEY;

  const res = await fetch(`https://api.pokemontcg.io/v2/${endpoint}`, { headers });
  if (!res.ok) {
    if (res.status === 429) {
      diagnostics.push('Pokemon TCG API レートリミット、30秒待機');
      await sleep(30000);
      const retry = await fetch(`https://api.pokemontcg.io/v2/${endpoint}`, { headers });
      if (!retry.ok) throw new Error(`Pokemon TCG API ${retry.status}`);
      return await retry.json();
    }
    throw new Error(`Pokemon TCG API ${res.status}: ${(await res.text()).substring(0, 200)}`);
  }
  return await res.json();
}

// 全パック（セット）を取得して card_sets に保存
async function syncPokemonSets() {
  console.log('Pokemon TCG セット同期開始');
  const data = await pokemonTcgFetch('sets?orderBy=releaseDate&pageSize=250');
  const sets = data.data || [];
  diagnostics.push(`Pokemon TCG: ${sets.length}セット取得`);

  // 既存のポケカセットを削除して全入れ替え（set_idにUNIQUE制約なしのため）
  await supabaseDelete('card_sets', 'game=eq.pokeca');

  let saved = 0;
  for (let i = 0; i < sets.length; i += 50) {
    const batch = sets.slice(i, i + 50).map(s => ({
      set_id: s.id,
      set_name_en: s.name,
      game: 'pokeca',
      total_cards: s.total || s.printedTotal || 0,
      release_date: s.releaseDate ? s.releaseDate.replace(/\//g, '-') : null,
      logo_url: s.images?.logo || null,
      symbol_url: s.images?.symbol || null,
    }));
    const result = await supabasePost('card_sets', batch);
    if (result) saved += batch.length;
    await sleep(200);
  }

  console.log(`Pokemon TCG セット保存: ${saved}/${sets.length}`);
  return { total: sets.length, saved };
}

// 指定セットのカード画像を取得して card_images に保存
async function syncPokemonCards(setId, setName) {
  let page = 1;
  let totalSaved = 0;
  let totalCards = 0;

  // このセットの既存カードを削除
  await supabaseDelete('card_images', `game=eq.pokeca&set_id=eq.${setId}`);

  while (true) {
    const data = await pokemonTcgFetch(`cards?q=set.id:${setId}&pageSize=250&page=${page}`);
    const cards = data.data || [];
    totalCards = data.totalCount || totalCards;

    if (cards.length === 0) break;

    for (let i = 0; i < cards.length; i += 50) {
      const batch = cards.slice(i, i + 50).map(c => ({
        card_id: c.id,
        card_name_en: c.name,
        game: 'pokeca',
        set_id: setId,
        set_name: setName,
        number: c.number || null,
        rarity: c.rarity || null,
        image_small: c.images?.small || null,
        image_large: c.images?.large || null,
      }));
      const result = await supabasePost('card_images', batch);
      if (result) totalSaved += batch.length;
    }

    if (cards.length < 250) break;
    page++;
    await sleep(1000);
  }

  return { set: setName, total: totalCards, saved: totalSaved };
}

// 全セットのカード画像を同期（offset番目から順にsetLimit個）
async function syncAllPokemonCards(setLimit = 10, offset = 0) {
  const data = await pokemonTcgFetch('sets?orderBy=-releaseDate&pageSize=250');
  const allSets = data.data || [];
  const sets = allSets.slice(offset, offset + setLimit);
  diagnostics.push(`Pokemon TCG: 全${allSets.length}セット中 ${offset}〜${offset + sets.length} のカード同期開始`);

  const results = [];
  for (const s of sets) {
    try {
      const result = await syncPokemonCards(s.id, s.name);
      results.push(result);
      diagnostics.push(`${s.name}: ${result.saved}/${result.total}枚`);
    } catch (e) {
      diagnostics.push(`${s.name} 失敗: ${e.message}`);
      results.push({ set: s.name, error: e.message });
    }
    await sleep(2000);
  }

  return results;
}

// ===== eBay API (ワンピースカード) =====

let cachedEbayToken = null;
let ebayTokenExpiry = 0;

async function getEbayToken() {
  if (cachedEbayToken && Date.now() < ebayTokenExpiry) return cachedEbayToken;
  const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!res.ok) throw new Error(`eBay OAuth失敗: ${res.status}`);
  const data = await res.json();
  cachedEbayToken = data.access_token;
  ebayTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedEbayToken;
}

async function searchEbayCards(query, limit = 50) {
  const token = await getEbayToken();
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    category_ids: '183454',
    sort: 'newlyListed',
    filter: 'deliveryCountry:US,conditions:{NEW}',
  });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`eBay検索失敗: ${res.status} ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.itemSummaries || [];
}

// ワンピースカードのパック情報
async function syncOnePieceSets() {
  console.log('ワンピースカード セット同期開始');

  const knownSets = [
    { id: 'op01', name: 'ROMANCE DAWN', release: '2022-07-22' },
    { id: 'op02', name: 'PARAMOUNT WAR', release: '2022-11-04' },
    { id: 'op03', name: 'PILLARS OF STRENGTH', release: '2023-02-11' },
    { id: 'op04', name: 'KINGDOMS OF INTRIGUE', release: '2023-05-27' },
    { id: 'op05', name: 'AWAKENING OF THE NEW ERA', release: '2023-08-25' },
    { id: 'op06', name: 'WINGS OF THE CAPTAIN', release: '2023-11-25' },
    { id: 'op07', name: 'FUTURE 500 YEARS LATER', release: '2024-02-24' },
    { id: 'op08', name: 'TWO LEGENDS', release: '2024-05-25' },
    { id: 'op09', name: 'THE FOUR EMPERORS', release: '2024-08-31' },
    { id: 'op10', name: 'ROYAL BLOODLINES', release: '2024-11-30' },
    { id: 'st01', name: 'Straw Hat Crew Starter Deck', release: '2022-07-22' },
    { id: 'st02', name: 'Worst Generation Starter Deck', release: '2022-07-22' },
    { id: 'st03', name: 'The Seven Warlords of the Sea', release: '2022-07-22' },
    { id: 'st04', name: 'Animal Kingdom Pirates', release: '2022-07-22' },
    { id: 'st05', name: 'Film Edition Starter Deck', release: '2022-09-09' },
    { id: 'st06', name: 'Navy Starter Deck', release: '2022-11-04' },
    { id: 'st07', name: 'Big Mom Pirates Starter Deck', release: '2023-02-11' },
    { id: 'st08', name: 'Monkey.D.Luffy Starter Deck', release: '2023-05-27' },
    { id: 'st09', name: 'Yamato Starter Deck', release: '2023-05-27' },
    { id: 'st10', name: 'Ultra Deck The Three Captains', release: '2023-07-08' },
    { id: 'st11', name: 'Uta Starter Deck', release: '2023-08-25' },
    { id: 'st12', name: 'Zoro & Sanji Starter Deck', release: '2023-11-25' },
    { id: 'st13', name: '3 Brothers Bond Starter Deck', release: '2024-01-27' },
  ];

  // 既存のワンピースセットを削除して入れ替え
  await supabaseDelete('card_sets', 'game=eq.onepiece');

  const batch = knownSets.map(s => ({
    set_id: `onepiece-${s.id}`,
    set_name_en: s.name,
    game: 'onepiece',
    total_cards: 0,
    release_date: s.release,
  }));

  const result = await supabasePost('card_sets', batch);
  const saved = result ? batch.length : 0;
  diagnostics.push(`ワンピース: ${saved}セット保存`);
  console.log(`ワンピース セット保存: ${saved}`);
  return { total: knownSets.length, saved };
}

// eBayからワンピースカード画像・情報を取得
async function syncOnePieceCards(setLimit = 5) {
  console.log('ワンピースカード カード同期開始');

  const sets = await supabaseGet('card_sets', 'game=eq.onepiece&order=release_date.desc&limit=' + setLimit);
  if (!Array.isArray(sets) || sets.length === 0) {
    diagnostics.push('ワンピース: セットデータなし、先にセット同期を実行');
    return [];
  }

  const results = [];
  for (const set of sets) {
    try {
      const setCode = (set.set_id || '').replace('onepiece-', '');
      const query = `one piece card game ${setCode} ${set.set_name_en}`;
      const items = await searchEbayCards(query, 50);
      diagnostics.push(`eBay検索 "${set.set_name_en}": ${items.length}件`);

      // この検索分の既存データを削除
      await supabaseDelete('card_images', `game=eq.onepiece&set_id=eq.${set.set_id}`);

      let saved = 0;
      const cards = items
        .filter(item => item.image?.imageUrl)
        .map((item, idx) => ({
          card_id: `${set.set_id}-ebay-${idx}`,
          card_name_en: extractCardName(item.title),
          game: 'onepiece',
          set_id: set.set_id,
          set_name: set.set_name_en,
          rarity: extractRarity(item.title),
          image_small: item.image.imageUrl,
          image_large: item.image.imageUrl,
        }));

      if (cards.length > 0) {
        for (let i = 0; i < cards.length; i += 50) {
          const batch = cards.slice(i, i + 50);
          const result = await supabasePost('card_images', batch);
          if (result) saved += batch.length;
        }
      }

      results.push({ set: set.set_name_en, total: items.length, saved });
      await sleep(1000);
    } catch (e) {
      diagnostics.push(`${set.set_name_en} 失敗: ${e.message}`);
      results.push({ set: set.set_name_en, error: e.message });
    }
  }

  return results;
}

// eBayタイトルからカード名を抽出
function extractCardName(title) {
  const cleaned = title
    .replace(/one piece card game/i, '')
    .replace(/\b(OP|ST)\d{2}-\d{3}\b/gi, '')
    .replace(/\b(SEC|SR|R|UC|C|L|SP|P|SAR|AR|AA|MANGA)\b/gi, '')
    .replace(/\b(Booster|Box|Pack|Sealed|Japanese|English|TCG)\b/gi, '')
    .replace(/[^\w\s.'-]/g, '')
    .trim();
  return cleaned.split(/\s{2,}/)[0]?.trim() || title.substring(0, 80);
}

// eBayタイトルからレアリティを抽出
function extractRarity(title) {
  const upper = title.toUpperCase();
  if (upper.includes('SEC') || upper.includes('SECRET')) return 'SEC';
  if (upper.includes('SAR') || upper.includes('SPECIAL ART')) return 'SAR';
  if (upper.includes(' SR ') || upper.includes('SUPER RARE')) return 'SR';
  if (upper.includes(' AR ') || upper.includes('ALT ART') || upper.includes('ALTERNATE')) return 'AR';
  if (upper.includes(' R ') || /\bRARE\b/.test(upper)) return 'R';
  if (upper.includes(' UC ') || upper.includes('UNCOMMON')) return 'UC';
  if (upper.includes(' C ') || upper.includes('COMMON')) return 'C';
  if (upper.includes('LEADER') || upper.includes(' L ')) return 'L';
  return null;
}

// ===== メインハンドラ =====

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Card sync API ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, set_limit, offset } = req.body || {};
  diagnostics.length = 0;

  try {
    if (action === 'sync_pokemon_sets') {
      const result = await syncPokemonSets();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'sync_pokemon_cards') {
      const results = await syncAllPokemonCards(parseInt(set_limit) || 10, parseInt(offset) || 0);
      return res.status(200).json({ status: 'done', sets_synced: results.length, offset: parseInt(offset) || 0, results, diagnostics });
    }

    if (action === 'sync_onepiece_sets') {
      const result = await syncOnePieceSets();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'sync_onepiece_cards') {
      if (!EBAY_APP_ID || !EBAY_CERT_ID) {
        return res.status(500).json({ error: 'eBay API credentials not configured' });
      }
      const results = await syncOnePieceCards(parseInt(set_limit) || 5);
      return res.status(200).json({ status: 'done', sets_synced: results.length, results, diagnostics });
    }

    if (action === 'sync_all') {
      const pokeSets = await syncPokemonSets();
      await sleep(2000);
      const pokeCards = await syncAllPokemonCards(parseInt(set_limit) || 5);
      await sleep(2000);
      const opSets = await syncOnePieceSets();
      let opCards = [];
      if (EBAY_APP_ID && EBAY_CERT_ID) {
        await sleep(2000);
        opCards = await syncOnePieceCards(parseInt(set_limit) || 3);
      } else {
        diagnostics.push('eBay認証情報なし、ワンピースカード同期スキップ');
      }
      return res.status(200).json({
        status: 'done',
        pokemon: { sets: pokeSets, cards_synced: pokeCards.length },
        onepiece: { sets: opSets, cards_synced: opCards.length },
        diagnostics,
      });
    }

    if (action === 'status') {
      const [pokeSets, opSets, pokeCards, opCards] = await Promise.all([
        supabaseGet('card_sets', 'game=eq.pokeca&select=id&limit=1000'),
        supabaseGet('card_sets', 'game=eq.onepiece&select=id&limit=1000'),
        supabaseGet('card_images', 'game=eq.pokeca&select=id&limit=1&order=id.desc'),
        supabaseGet('card_images', 'game=eq.onepiece&select=id&limit=1&order=id.desc'),
      ]);
      return res.status(200).json({
        pokemon_sets: Array.isArray(pokeSets) ? pokeSets.length : 0,
        onepiece_sets: Array.isArray(opSets) ? opSets.length : 0,
        has_pokemon_cards: Array.isArray(pokeCards) && pokeCards.length > 0,
        has_onepiece_cards: Array.isArray(opCards) && opCards.length > 0,
      });
    }

    return res.status(400).json({
      error: 'action必須',
      actions: ['sync_pokemon_sets', 'sync_pokemon_cards', 'sync_onepiece_sets', 'sync_onepiece_cards', 'sync_all', 'status'],
    });
  } catch (e) {
    console.error('card-sync エラー:', e.message);
    return res.status(500).json({ error: e.message, diagnostics });
  }
}
