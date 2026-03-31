const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;

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

  データソース:
  - ポケモンカード: TCGdex API (https://api.tcgdex.net/v2/ja/) — 日本語名・日本語パック名・画像
  - ワンピースカード: eBay Browse API — 英語名・画像
*/

// ===== TCGdex API (日本語ポケモンカード) =====

async function tcgdexFetch(endpoint) {
  const res = await fetch(`https://api.tcgdex.net/v2/ja/${endpoint}`);
  if (!res.ok) {
    if (res.status === 429) {
      diagnostics.push('TCGdex レートリミット、10秒待機');
      await sleep(10000);
      const retry = await fetch(`https://api.tcgdex.net/v2/ja/${endpoint}`);
      if (!retry.ok) throw new Error(`TCGdex ${retry.status}`);
      return await retry.json();
    }
    throw new Error(`TCGdex ${res.status}: ${(await res.text()).substring(0, 200)}`);
  }
  return await res.json();
}

// 全セットを取得して card_sets に保存（日本語名）
async function syncPokemonSets() {
  console.log('TCGdex セット同期開始（日本語）');
  const rawSets = await tcgdexFetch('sets');
  if (!Array.isArray(rawSets)) throw new Error('TCGdex sets応答が配列でない');

  // TCGdexに重複IDが存在するため、最後のものだけ保持
  const seenIds = new Set();
  const sets = [];
  for (const s of [...rawSets].reverse()) {
    if (!seenIds.has(s.id)) { seenIds.add(s.id); sets.push(s); }
  }
  sets.reverse();
  diagnostics.push(`TCGdex: ${rawSets.length}セット取得 (重複除去後: ${sets.length})`);

  // 既存のポケカセットを削除して全入れ替え
  await supabaseDelete('card_sets', 'game=eq.pokeca');

  let saved = 0;
  for (let i = 0; i < sets.length; i += 50) {
    const batch = sets.slice(i, i + 50).map(s => ({
      set_id: s.id,
      set_name: s.name,
      game: 'pokeca',
      total_cards: s.cardCount?.total || s.cardCount?.official || 0,
      symbol_url: s.symbol || null,
      logo_url: s.logo || null,
    }));
    const result = await supabasePost('card_sets', batch);
    if (result) saved += batch.length;
    await sleep(100);
  }

  console.log(`TCGdex セット保存: ${saved}/${sets.length}`);
  return { total: sets.length, saved };
}

// 指定セットの全カードを取得して card_images に保存（日本語）
async function syncPokemonCards(setId) {
  const setData = await tcgdexFetch(`sets/${setId}`);
  const cards = setData.cards || [];
  const setName = setData.name || setId;

  // このセットの既存カードを削除
  await supabaseDelete('card_images', `game=eq.pokeca&set_id=eq.${setId}`);

  let totalSaved = 0;
  for (let i = 0; i < cards.length; i += 50) {
    const batch = cards.slice(i, i + 50).map(c => ({
      card_id: c.id,
      card_name: c.name,
      game: 'pokeca',
      set_id: setId,
      set_name: setName,
      number: c.localId || null,
      image_small: c.image ? `${c.image}/low.webp` : null,
      image_large: c.image ? `${c.image}/high.webp` : null,
    }));
    const result = await supabasePost('card_images', batch);
    if (result) totalSaved += batch.length;
  }

  return { set: setName, set_id: setId, total: cards.length, saved: totalSaved };
}

// カード詳細を取得してレアリティを付与（バッチ）
async function syncPokemonCardsWithRarity(setId) {
  const setData = await tcgdexFetch(`sets/${setId}`);
  const cardSummaries = setData.cards || [];
  const setName = setData.name || setId;

  // このセットの既存カードを削除
  await supabaseDelete('card_images', `game=eq.pokeca&set_id=eq.${setId}`);

  // 各カードの詳細を取得してレアリティを含める
  const cardDetails = [];
  for (const c of cardSummaries) {
    try {
      const detail = await tcgdexFetch(`cards/${c.id}`);
      cardDetails.push({
        card_id: c.id,
        card_name: detail.name || c.name,
        game: 'pokeca',
        set_id: setId,
        set_name: setName,
        number: detail.localId || c.localId || null,
        rarity: detail.rarity || null,
        image_small: c.image ? `${c.image}/low.webp` : null,
        image_large: c.image ? `${c.image}/high.webp` : null,
      });
      // TCGdex にやさしく
      if (cardDetails.length % 20 === 0) await sleep(500);
    } catch (e) {
      // 詳細取得失敗時はサマリーだけで保存
      cardDetails.push({
        card_id: c.id,
        card_name: c.name,
        game: 'pokeca',
        set_id: setId,
        set_name: setName,
        number: c.localId || null,
        image_small: c.image ? `${c.image}/low.webp` : null,
        image_large: c.image ? `${c.image}/high.webp` : null,
      });
    }
  }

  // バッチINSERT
  let totalSaved = 0;
  for (let i = 0; i < cardDetails.length; i += 50) {
    const batch = cardDetails.slice(i, i + 50);
    const result = await supabasePost('card_images', batch);
    if (result) totalSaved += batch.length;
  }

  return { set: setName, set_id: setId, total: cardSummaries.length, saved: totalSaved };
}

// 全セットのカードを同期（offset番目からsetLimit個）
async function syncAllPokemonCards(setLimit = 5, offset = 0, withRarity = false) {
  const allSets = await tcgdexFetch('sets');
  if (!Array.isArray(allSets)) throw new Error('TCGdex sets応答が配列でない');

  // 新しいセット（後ろ）から順に処理
  const reversed = [...allSets].reverse();
  const sets = reversed.slice(offset, offset + setLimit);
  diagnostics.push(`TCGdex: 全${allSets.length}セット中 ${offset}〜${offset + sets.length} のカード同期開始`);

  const results = [];
  for (const s of sets) {
    try {
      const result = withRarity
        ? await syncPokemonCardsWithRarity(s.id)
        : await syncPokemonCards(s.id);
      results.push(result);
      diagnostics.push(`${result.set}: ${result.saved}/${result.total}枚`);
    } catch (e) {
      diagnostics.push(`${s.name || s.id} 失敗: ${e.message}`);
      results.push({ set: s.name || s.id, error: e.message });
    }
    await sleep(1000);
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
  return { total: knownSets.length, saved };
}

async function syncOnePieceCards(setLimit = 5) {
  console.log('ワンピースカード カード同期開始');
  const sets = await supabaseGet('card_sets', 'game=eq.onepiece&order=release_date.desc&limit=' + setLimit);
  if (!Array.isArray(sets) || sets.length === 0) {
    diagnostics.push('ワンピース: セットデータなし');
    return [];
  }
  const results = [];
  for (const set of sets) {
    try {
      const setCode = (set.set_id || '').replace('onepiece-', '');
      const query = `one piece card game ${setCode} ${set.set_name_en}`;
      const items = await searchEbayCards(query, 50);
      diagnostics.push(`eBay検索 "${set.set_name_en}": ${items.length}件`);
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
  if (req.method === 'GET') return res.status(200).json({ status: 'Card sync API ready (TCGdex + eBay)' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, set_limit, offset, with_rarity } = req.body || {};
  diagnostics.length = 0;

  try {
    if (action === 'sync_pokemon_sets') {
      const result = await syncPokemonSets();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'sync_pokemon_cards') {
      const results = await syncAllPokemonCards(
        parseInt(set_limit) || 5,
        parseInt(offset) || 0,
        !!with_rarity
      );
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
      const pokeCards = await syncAllPokemonCards(parseInt(set_limit) || 5, 0, false);
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
