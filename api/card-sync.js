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
  - ポケモンカード: TCGdex API (https://api.tcgdex.net/v2/ja/) — 日本語名・日本語パック名
  - ポケモンカード ロゴ: カードラッシュメディア (https://cardrush.media/pokemon/packs) — パックボックス画像
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

// カードラッシュメディアからパックボックス画像URLマップを構築
// https://cardrush.media/pokemon/packs の __NEXT_DATA__ からpack code→image_sourceを取得
async function fetchCardrushPackLogos() {
  const map = {};
  try {
    // 全ページを取得（lastPageで判定）
    for (let page = 1; page <= 10; page++) {
      const url = `https://cardrush.media/pokemon/packs${page > 1 ? `?page=${page}` : ''}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TCGVibe-SyncBot/1.0 (+https://tcgvibe.com)' },
      });
      if (!res.ok) break;
      const html = await res.text();
      const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">(.*?)<\/script>/s);
      if (!match) break;
      const data = JSON.parse(match[1]);
      const packs = data?.props?.pageProps?.packs || [];
      const lastPage = data?.props?.pageProps?.lastPage || 1;
      for (const p of packs) {
        if (p.code && p.image_source) {
          map[p.code.toLowerCase()] = p.image_source;
        }
      }
      if (page >= lastPage) break;
      await sleep(500);
    }
  } catch (e) {
    diagnostics.push(`カードラッシュパックロゴ取得エラー: ${e.message}`);
  }
  return map;
}

// 全セットを取得して card_sets に保存（日本語名 + カードラッシュボックス画像）
async function syncPokemonSets() {
  console.log('TCGdex セット同期開始（日本語）');
  const rawSets = await tcgdexFetch('sets');
  if (!Array.isArray(rawSets)) throw new Error('TCGdex sets応答が配列でない');

  // TCGdexに重複IDが存在するため除去
  const seenIds = new Set();
  const sets = [];
  for (const s of rawSets) {
    if (!seenIds.has(s.id)) { seenIds.add(s.id); sets.push(s); }
  }
  diagnostics.push(`TCGdex: ${rawSets.length}セット取得 (重複除去後: ${sets.length})`);

  // 既存のポケカセットを削除して全入れ替え
  await supabaseDelete('card_sets', 'game=eq.pokeca');

  // カードラッシュメディアからパックボックス画像を取得
  const packLogoMap = await fetchCardrushPackLogos();
  diagnostics.push(`カードラッシュ: ${Object.keys(packLogoMap).length}パックのボックス画像取得`);

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
    const batch = sets.slice(i, i + 50).map(s => {
      // ロゴURL: カードラッシュのパックボックス画像を使用（pack_codeで照合）
      const logoUrl = packLogoMap[s.id.toLowerCase()] || null;
      return {
        set_id: s.id,
        set_name: s.name,
        game: 'pokeca',
        total_cards: s.cardCount?.total || s.cardCount?.official || 0,
        release_date: setDetails[s.id] || null,
        symbol_url: s.symbol || null,
        logo_url: logoUrl,
      };
    });
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

  // 公式サイトのパックボックス画像URLを構築
  // パターン: /renewal/images/products/{boosters|decks}/{code}/img_item01.webp
  const OP_PRODUCT_IMG = 'https://www.onepiece-cardgame.com/renewal/images/products';

  const setRows = packs.map(p => {
    const codeMatch = p.raw_title.match(/【([A-Z]+-(\d+[A-Za-z]?))】/);
    let logoUrl = null;
    if (codeMatch) {
      const fullCode = codeMatch[1]; // e.g. "OP-01", "ST-16", "EB-03"
      const prefix = fullCode.split('-')[0].toLowerCase(); // "op", "st", "eb"
      const num = fullCode.split('-')[1]; // "01", "16", "03"
      const code = prefix + num; // "op01", "st16", "eb03"
      const category = prefix === 'st' ? 'decks' : 'boosters';
      logoUrl = `${OP_PRODUCT_IMG}/${category}/${code}/img_item01.webp`;
    }
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
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Card sync API ready' });
  if (req.method !== 'POST') return res.status(405).end();

  // 内部APIキー認証
  const key = req.headers['x-api-key'] || req.body?.api_key;
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
