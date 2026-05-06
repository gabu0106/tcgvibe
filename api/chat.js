// eBay海外相場取得（既存の動作確認済みコードをそのまま維持）
async function fetchEbayContext(query) {
  try {
    const EBAY_APP_ID = process.env.EBAY_APP_ID;
    const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
    if (!EBAY_APP_ID || !EBAY_CERT_ID) return '';

    const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });
    if (!tokenRes.ok) return '';
    const tokenData = await tokenRes.json();

    const params = new URLSearchParams({ q: `pokemon card ${query}`, limit: '5', category_ids: '183454', sort: 'price' });
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const items = (data.itemSummaries || []).filter(i => i.price);
    if (items.length === 0) return '';
    const prices = items.map(i => parseFloat(i.price.value));
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100;
    return `\n\n【eBay海外相場】 ${query}: 平均$${avg} (${items.length}件, $${Math.min(...prices)}〜$${Math.max(...prices)})`;
  } catch { return ''; }
}

export default async function handler(req, res) {
  // CORS設定（既存のまま）
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages が必要です' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  // ★ ここがAnthropicからGeminiに変わった部分
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が未設定です' });
  }

  // TCGメタ情報を取得（既存ロジックそのまま）
  let tcgContext = '';
  try {
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tcg_meta?order=collected_at.desc&limit=20`,
      {
        headers: {
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        },
      }
    );
    if (dbRes.ok) {
      const dbData = await dbRes.json();
      if (dbData.length > 0) {
        tcgContext = '\n\n【最新TCG情報データベース】\n' +
          dbData.map(d => `[${d.game}][${d.category}] ${d.title}: ${d.content}`).join('\n');
      }
    }
  } catch (e) {
    console.error('DB取得エラー:', e);
  }

  // 価格情報の検索（既存ロジックそのまま）
  const lastMessage = messages[messages.length - 1]?.content || '';
  let priceContext = '';
  const priceKeywords = ['価格', '値段', '買取', '相場', '高い', '高額', 'いくら', '円', 'eBay', 'ebay', '海外'];
  if (priceKeywords.some(kw => lastMessage.includes(kw))) {
    try {
      let searchTerm = lastMessage;
      priceKeywords.forEach(kw => { searchTerm = searchTerm.replace(kw, ''); });
      searchTerm = searchTerm.replace(/[のはがをにで？?、。]/g, '').trim();

      if (searchTerm.length >= 2) {
        const [priceRes, ebayContext] = await Promise.all([
          fetch(
            `${SUPABASE_URL}/rest/v1/card_prices?select=card_name,buy_price,rarity,shop,game&card_name=ilike.*${encodeURIComponent(searchTerm)}*&limit=20`,
            { headers: { 'apikey': SUPABASE_PUBLISHABLE_KEY, 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` } }
          ),
          fetchEbayContext(searchTerm),
        ]);
        const priceData = await priceRes.json();
        if (Array.isArray(priceData) && priceData.length > 0) {
          priceContext = '\n\n【カード価格データ】\n' + priceData.map(c => `${c.card_name} / ${c.buy_price} / ${c.rarity} / ${c.shop}`).join('\n');
        }
        priceContext += ebayContext;
      }

      if (!priceContext) {
        const topRes = await fetch(
          `${SUPABASE_URL}/rest/v1/card_prices?select=card_name,buy_price,rarity,shop,game&order=id.asc&limit=5000`,
          { headers: { 'apikey': SUPABASE_PUBLISHABLE_KEY, 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` } }
        );
        const topData = await topRes.json();
        if (Array.isArray(topData)) {
          const sorted = topData
            .map(c => ({ ...c, price_num: parseInt((c.buy_price || '0').replace(/[^0-9]/g, '')) }))
            .filter(c => c.price_num > 0)
            .sort((a, b) => b.price_num - a.price_num)
            .slice(0, 15);
          if (sorted.length > 0) {
            priceContext = '\n\n【高額カードTOP15】\n' + sorted.map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity}/${c.shop})`).join('\n');
          }
        }
      }
    } catch (e) {
      console.error('価格データ取得エラー:', e);
    }
  }

  // ★ ここからGemini API呼び出し（Anthropicから変更）
  try {
    // システムプロンプト（既存の人格設定をそのまま継承）
    const systemInstruction = `あなたはTCGVIBE.AIの専属AIアドバイザーです。
ポケモンカード、遊戯王、MTG、デュエルマスターズ、ヴァイスシュヴァルツ、ワンピースカードの専門家です。

【重要】以下のデータベース情報を最優先で参照して回答してください。
データベースにない情報はGoogle検索で補完してください。${tcgContext}${priceContext}

カード価格の質問にはデータを参照して正確に答えてください。国内買取価格とeBay海外相場の両方があれば両方答える。データにないカードは「最新情報はショップでご確認ください」と伝える。

【回答スタイル】
・友達に話しかけるような自然な日本語で話すこと
・##や**や---などのマークダウン記号は絶対に使わない
・箇条書きは「・」のみ使う
・「〜だよ」「〜だね」「〜かな」など話し言葉で答える
・専門知識は持ちつつも堅くなりすぎない
・回答は長すぎず、テンポよく答える`;

    // Anthropic形式のmessages配列をGemini形式のcontents配列に変換
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

    // Gemini 2.5 Flash-Lite を使用（無料枠：1日1,000リクエスト）
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: contents,
        tools: [{ google_search: {} }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini APIエラー:', response.status, errorText);
      return res.status(response.status).json({ error: 'AI APIエラーが発生しました' });
    }

    const data = await response.json();

    const candidate = data.candidates?.[0];
    if (!candidate) {
      return res.status(500).json({ error: 'AIの応答が空でした' });
    }

    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKLIST') {
      return res.status(200).json({ reply: 'ごめん、その質問にはちょっと答えづらいかも。別の聞き方で試してみて！' });
    }

    const reply = candidate.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    if (!reply) {
      return res.status(500).json({ error: '応答テキストが取得できませんでした' });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
