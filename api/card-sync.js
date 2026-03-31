const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

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

  // TCGdexに重複IDが存在するため除去し、releaseDate降順でソート
  const seenIds = new Set();
  const sets = [];
  for (const s of rawSets) {
    if (!seenIds.has(s.id)) { seenIds.add(s.id); sets.push(s); }
  }
  diagnostics.push(`TCGdex: ${rawSets.length}セット取得 (重複除去後: ${sets.length})`);

  // 既存のポケカセットを削除して全入れ替え
  await supabaseDelete('card_sets', 'game=eq.pokeca');

  // 各セットの詳細からreleaseDateを取得（並列で高速化）
  diagnostics.push('TCGdex: releaseDateを取得中...');
  const setDetails = {};
  for (let i = 0; i < sets.length; i += 10) {
    const chunk = sets.slice(i, i + 10);
    const details = await Promise.all(chunk.map(async s => {
      try {
        const d = await tcgdexFetch(`sets/${s.id}`);
        return { id: s.id, releaseDate: d.releaseDate || null };
      } catch { return { id: s.id, releaseDate: null }; }
    }));
    for (const d of details) setDetails[d.id] = d.releaseDate;
    await sleep(300);
  }

  let saved = 0;
  for (let i = 0; i < sets.length; i += 50) {
    const batch = sets.slice(i, i + 50).map(s => ({
      set_id: s.id,
      set_name: s.name,
      game: 'pokeca',
      total_cards: s.cardCount?.total || s.cardCount?.official || 0,
      release_date: setDetails[s.id] || null,
      symbol_url: s.symbol || null,
      // pokemontcg.ioのロゴ画像（小文字set_id）
      logo_url: `https://images.pokemontcg.io/${s.id.toLowerCase()}/logo.png`,
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
  const rawSets = await tcgdexFetch('sets');
  if (!Array.isArray(rawSets)) throw new Error('TCGdex sets応答が配列でない');

  // 各セットの詳細からreleaseDateを取得してソート（キャッシュ済みセット情報を使う）
  // セットIDリストだけ取得し、DB上のcard_setsからrelease_dateでソート
  const dbSets = await supabaseGet('card_sets', 'game=eq.pokeca&select=set_id&order=release_date.desc.nullslast&limit=500');
  const orderedIds = Array.isArray(dbSets) ? dbSets.map(s => s.set_id) : rawSets.map(s => s.id);
  // DBにないセットは末尾に追加
  const allIds = [...new Set([...orderedIds, ...rawSets.map(s => s.id)])];
  const setMap = {};
  for (const s of rawSets) setMap[s.id] = s;
  const allSets = allIds.map(id => setMap[id]).filter(Boolean);

  const sets = allSets.slice(offset, offset + setLimit);
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

// ===== ワンピースカード（punk-records: 公式サイト画像 + 日本語データ） =====

const PUNK_RECORDS_BASE = 'https://raw.githubusercontent.com/buhbbl/punk-records/main/japanese';
const OP_IMAGE_BASE = 'https://www.onepiece-cardgame.com/images/cardlist/card';

async function fetchPunkRecords(path) {
  const res = await fetch(`${PUNK_RECORDS_BASE}/${path}`);
  if (!res.ok) throw new Error(`punk-records ${res.status}: ${path}`);
  return await res.json();
}

// セット一覧を取得して card_sets に保存（日本語名）
async function syncOnePieceSets() {
  console.log('ワンピースカード セット同期開始（punk-records）');
  const packsData = await fetchPunkRecords('packs.json');
  const packs = Object.values(packsData);
  diagnostics.push(`punk-records: ${packs.length}パック取得`);

  await supabaseDelete('card_sets', 'game=eq.onepiece');

  // cards_by_id.jsonから各パックの先頭カードIDを取得してロゴ画像に使用
  let cardsIndex = {};
  try { cardsIndex = await fetchPunkRecords('index/cards_by_id.json'); } catch {}
  const packFirstCard = {};
  for (const [cardId, c] of Object.entries(cardsIndex)) {
    if (/_p\d/.test(cardId)) continue;
    if (!packFirstCard[c.pack_id] || cardId < packFirstCard[c.pack_id]) {
      packFirstCard[c.pack_id] = cardId;
    }
  }

  const setRows = packs.map(p => {
    const firstCard = packFirstCard[p.id];
    const logoUrl = firstCard ? `${OP_IMAGE_BASE}/${firstCard}.png` : null;
    return {
      set_id: `op-${p.id}`,
      set_name: p.raw_title,
      game: 'onepiece',
      total_cards: 0,
      logo_url: logoUrl,
    };
  });

  let saved = 0;
  for (let i = 0; i < setRows.length; i += 50) {
    const batch = setRows.slice(i, i + 50);
    const result = await supabasePost('card_sets', batch);
    if (result) saved += batch.length;
  }

  diagnostics.push(`ワンピース: ${saved}/${packs.length}パック保存`);
  return { total: packs.length, saved };
}

// 全カードを取得して card_images に保存（日本語名 + 公式画像URL）
async function syncOnePieceCards() {
  console.log('ワンピースカード カード同期開始（punk-records）');

  // cards_by_id.json で全カードのインデックスを取得
  const cardsIndex = await fetchPunkRecords('index/cards_by_id.json');
  const allCardEntries = Object.entries(cardsIndex);
  diagnostics.push(`punk-records: ${allCardEntries.length}カード取得`);

  diagnostics.push(`全${allCardEntries.length}枚（パラレル含む）`);

  // 既存のワンピースカードを削除
  await supabaseDelete('card_images', 'game=eq.onepiece');

  // パックIDからセット名を取得するためにpacks.jsonも取得
  const packsData = await fetchPunkRecords('packs.json');

  let totalSaved = 0;
  for (let i = 0; i < allCardEntries.length; i += 50) {
    const batch = allCardEntries.slice(i, i + 50).map(([cardId, c]) => {
      const packName = packsData[c.pack_id]?.raw_title || '';
      return {
        card_id: cardId,
        card_name: c.name,
        game: 'onepiece',
        set_id: `op-${c.pack_id}`,
        set_name: packName,
        number: cardId.replace(/^[A-Z]+-/, ''),
        rarity: c.category || null,
        image_small: `${OP_IMAGE_BASE}/${cardId}.png`,
        image_large: `${OP_IMAGE_BASE}/${cardId}.png`,
      };
    });
    const result = await supabasePost('card_images', batch);
    if (result) totalSaved += batch.length;
  }

  diagnostics.push(`ワンピース: ${totalSaved}/${allCardEntries.length}枚保存`);
  return { total: allCardEntries.length, saved: totalSaved };
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
      const result = await syncOnePieceCards();
      return res.status(200).json({ status: 'done', ...result, diagnostics });
    }

    if (action === 'sync_all') {
      const pokeSets = await syncPokemonSets();
      await sleep(2000);
      const pokeCards = await syncAllPokemonCards(parseInt(set_limit) || 5, 0, false);
      await sleep(2000);
      const opSets = await syncOnePieceSets();
      await sleep(1000);
      const opCards = await syncOnePieceCards();
      return res.status(200).json({
        status: 'done',
        pokemon: { sets: pokeSets, cards_synced: pokeCards.length },
        onepiece: { sets: opSets, cards: opCards },
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
