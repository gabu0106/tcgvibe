const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { game, set_id, rarity, search, limit, offset, action } = req.query;

    // カード名で画像をマッチングして返す
    if (action === 'match') {
      const cardName = req.query.card_name;
      if (!cardName) return res.status(400).json({ error: 'card_name必須' });

      // 完全一致 → 部分一致の順で検索
      let url = `${SUPABASE_URL}/rest/v1/card_images?select=image_small,image_large,card_name_en,rarity,set_name&card_name_en=ilike.*${encodeURIComponent(cardName)}*&limit=1`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return res.status(200).json({ match: data[0] });
      }
      return res.status(200).json({ match: null });
    }

    // 一括マッチング: card_pricesとcard_imagesをカード名で結合
    if (action === 'match_prices') {
      const g = game || 'pokeca';
      // card_pricesを取得
      let priceUrl = `${SUPABASE_URL}/rest/v1/card_prices?select=id,card_name,buy_price,rarity,shop,pack_name,model_number&limit=5000`;
      if (g) priceUrl += `&game=eq.${g}`;
      const priceRes = await fetch(priceUrl, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const prices = await priceRes.json();

      // card_imagesを取得（同ゲーム、number付き、日本語名含む）
      // card_imagesをページネーションで全件取得（Supabaseの1000件制限を回避）
      const images = [];
      let imgOffset = 0;
      const IMG_PAGE = 1000;
      while (true) {
        const imgUrl = `${SUPABASE_URL}/rest/v1/card_images?select=card_id,card_name,card_name_en,image_small,set_id,number&game=eq.${g}&image_small=not.is.null&limit=${IMG_PAGE}&offset=${imgOffset}&order=id.asc`;
        const imgRes = await fetch(imgUrl, {
          headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
        });
        const page = await imgRes.json();
        if (!Array.isArray(page) || page.length === 0) break;
        images.push(...page);
        if (page.length < IMG_PAGE) break;
        imgOffset += IMG_PAGE;
      }

      // 複数のマップを構築してマッチング精度を上げる
      const byCardId = {};   // card_id → image
      const bySetNum = {};   // "set_id:number" → image
      const byNameJa = {};   // 日本語名 → image
      const byNameEn = {};   // english name → image
      if (Array.isArray(images)) {
        for (const img of images) {
          if (!img.image_small) continue;
          if (img.card_id) byCardId[img.card_id.toLowerCase()] = img.image_small;
          if (img.set_id && img.number) bySetNum[`${img.set_id}:${img.number}`] = img.image_small;
          if (img.card_name) {
            const key = img.card_name;
            if (!byNameJa[key]) byNameJa[key] = img.image_small;
          }
          if (img.card_name_en) {
            const key = img.card_name_en.toLowerCase();
            if (!byNameEn[key]) byNameEn[key] = img.image_small;
          }
        }
      }

      // 日本語pack_name → 英語set_idの正規化候補を生成
      function normalizePackName(pack) {
        const p = pack.toLowerCase().trim();
        const variants = [p];
        // sm4+ → sm4  /  sm4A → sm4  /  sm4S → sm4
        variants.push(p.replace(/[+]$/, ''));
        variants.push(p.replace(/[a-z]$/, ''));
        // S10D → s10  /  S10P → s10  /  S10a → s10
        variants.push(p.replace(/[a-z]$/i, ''));
        // s1H → s1  /  s1W → s1  /  s1a → s1
        // sv → sv  (keep as is)
        // 151C → sv2a (special mapping) - skip, too specific
        // smP2 → smp
        if (p.startsWith('smp')) variants.push('smp');
        // BW1白 → bw1 (remove japanese suffix)
        variants.push(p.replace(/[^\x00-\x7F]+/g, ''));
        // M1L/M1S → me1, M2 → me2, M2a → me2pt5, M3 → me3
        if (/^m\d/.test(p)) {
          const mNum = p.match(/^m(\d+)/)?.[1];
          if (mNum) {
            variants.push(`me${mNum}`);
            if (p.includes('a')) variants.push(`me${mNum}pt5`);
          }
        }
        // sv3.5 → sv3pt5
        variants.push(p.replace(/\.5/g, 'pt5').replace(/\./g, 'pt'));
        // sm3.5 → sm35
        variants.push(p.replace(/\./g, ''));
        // s→sv mapping: s1 → sv1 etc (newer sets)
        if (/^s\d/.test(p) && !p.startsWith('sv') && !p.startsWith('sm')) {
          variants.push('sv' + p.substring(1).replace(/[a-z]$/i, ''));
        }
        return [...new Set(variants)];
      }

      // 価格データに画像URLを付与（複数戦略でマッチ）
      const matched = (Array.isArray(prices) ? prices : []).map(p => {
        let image = null;
        const cardName = (p.card_name || '').trim();

        // 戦略0: 日本語カード名で直接マッチ（TCGdexのcard_nameと照合）
        if (cardName && byNameJa[cardName]) {
          image = byNameJa[cardName];
        }
        // 括弧やサフィックスを除去して再マッチ
        if (!image && cardName) {
          const baseName = cardName.replace(/[（(].*[）)]/g, '').replace(/(VMAX|VSTAR|V|ex|EX|GX|BREAK|δ)$/g, '').trim();
          if (baseName && byNameJa[baseName]) image = byNameJa[baseName];
          // 部分一致
          if (!image) {
            for (const [key, url] of Object.entries(byNameJa)) {
              if (key.includes(cardName) || cardName.includes(key)) {
                image = url;
                break;
              }
            }
          }
        }

        // 戦略1: pack_name + model_number → card_id/set_id:number マッチ
        if (!image && p.pack_name && p.model_number) {
          const num = p.model_number.split('/')[0];
          const setVariants = normalizePackName(p.pack_name);
          for (const setId of setVariants) {
            const cid = `${setId}-${num}`;
            if (byCardId[cid]) { image = byCardId[cid]; break; }
            const sn = `${setId}:${num}`;
            if (bySetNum[sn]) { image = bySetNum[sn]; break; }
          }
        }

        // 戦略2: model_number(番号部分)で全set_idを横断検索
        if (!image && p.model_number) {
          const num = p.model_number.split('/')[0];
          const packBase = (p.pack_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const [key, url] of Object.entries(bySetNum)) {
            const [sid, snum] = key.split(':');
            if (snum === num && sid.startsWith(packBase.substring(0, 2))) {
              image = url;
              break;
            }
          }
        }

        return { ...p, image_url: image };
      });

      const matchedCount = matched.filter(m => m.image_url).length;
      return res.status(200).json({ prices: matched, total: matched.length, matched: matchedCount });
    }

    // セット一覧を取得（日本語名があるセットを優先）
    if (action === 'sets') {
      let url = `${SUPABASE_URL}/rest/v1/card_sets?select=set_id,set_name,set_name_en,game,release_date,total_cards,logo_url,symbol_url&order=release_date.desc.nullslast`;
      if (game) url += `&game=eq.${game}`;
      // 日本語名(set_name)があるセットのみ返す
      url += `&set_name=not.is.null`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      });
      const data = await response.json();
      return res.status(200).json({ sets: Array.isArray(data) ? data : [] });
    }

    // カード画像一覧（メイン）— 日本語データ（card_nameあり）を優先表示
    let url = `${SUPABASE_URL}/rest/v1/card_images?select=*&order=id.desc`;
    if (game) url += `&game=eq.${game}`;
    if (set_id) url += `&set_id=eq.${set_id}`;
    if (rarity) url += `&rarity=eq.${rarity}`;
    if (search) url += `&or=(card_name.ilike.*${encodeURIComponent(search)}*,card_name_en.ilike.*${encodeURIComponent(search)}*)`;
    // 日本語データを優先: card_nameがnullでない＋画像ありのものだけ表示
    if (!set_id && !search) url += `&card_name=not.is.null&image_small=not.is.null`;
    url += `&limit=${parseInt(limit) || 100}`;
    if (offset) url += `&offset=${parseInt(offset)}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
    });
    const data = await response.json();
    return res.status(200).json({ cards: Array.isArray(data) ? data : [], count: Array.isArray(data) ? data.length : 0 });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
