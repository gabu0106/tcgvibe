import crypto from 'crypto';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const MODEL = 'claude-haiku-4-5-20251001';

function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hash = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

// Disable Vercel body parsing to get raw body for signature verification
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function sendLineMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
  const data = await res.json();
  console.log('LINE reply result:', JSON.stringify(data));
}

async function loadHistory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chat_history?select=*&order=created_at.asc&limit=10`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(row => ({ role: row.role, content: row.content }));
  } catch { return []; }
}

async function saveMessage(role, content) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ role, content }),
    });
  } catch {}
}

async function approveArticle(articleId) {
  await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${articleId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ approved: true, status: 'approved' }),
  });

  // tcg_articlesテーブルにも追加して公開
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${articleId}&select=*`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  const articles = await res.json();
  if (articles[0]) {
    const a = articles[0];
    await fetch(`${SUPABASE_URL}/rest/v1/tcg_articles`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        title: a.title,
        content: a.content,
        tag: a.tag,
        emoji: a.emoji || '🃏',
        summary: a.summary || a.title,
        game: a.game || 'pokeca',
        author: a.author || 'TCGVIBE AI',
      }),
    });
  }
  return true;
}

async function searchCardPrices(query) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/card_prices?select=card_name,buy_price,rarity,shop,game&card_name=ilike.*${encodeURIComponent(query)}*&limit=20`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return '';
    return '\n\n【カード価格データ】\n' + data.map(c => `${c.card_name} / ${c.buy_price} / ${c.rarity} / ${c.shop}`).join('\n');
  } catch { return ''; }
}

async function searchEbayPrices(query) {
  try {
    const EBAY_APP_ID = process.env.EBAY_APP_ID;
    const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
    if (!EBAY_APP_ID || !EBAY_CERT_ID) return '';

    const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
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
    return `\n\n【eBay海外相場】${query}: 平均$${avg} (${items.length}件, $${Math.min(...prices)}〜$${Math.max(...prices)})`;
  } catch { return ''; }
}

async function getTopPrices() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/card_prices?select=card_name,buy_price,rarity,shop,game&order=id.asc&limit=5000`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    if (!Array.isArray(data)) return '';
    const sorted = data
      .map(c => ({ ...c, price_num: parseInt((c.buy_price || '0').replace(/[^0-9]/g, '')) }))
      .filter(c => c.price_num > 0)
      .sort((a, b) => b.price_num - a.price_num)
      .slice(0, 15);
    if (sorted.length === 0) return '';
    return '\n\n【高額カードTOP15】\n' + sorted.map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity}/${c.shop})`).join('\n');
  } catch { return ''; }
}

async function askClaude(userMessage, history) {
  // 価格関連キーワードがあればcard_prices+eBayを検索
  const priceKeywords = ['価格', '値段', '買取', '相場', '高い', '高額', 'いくら', '円', 'eBay', 'ebay', '海外'];
  let priceContext = '';
  if (priceKeywords.some(kw => userMessage.includes(kw))) {
    let searchTerm = userMessage;
    priceKeywords.forEach(kw => { searchTerm = searchTerm.replace(kw, ''); });
    searchTerm = searchTerm.replace(/[のはがをにで？?、。]/g, '').trim();
    if (searchTerm.length >= 2) {
      const [domestic, ebay] = await Promise.all([
        searchCardPrices(searchTerm),
        searchEbayPrices(searchTerm),
      ]);
      priceContext = domestic + ebay;
    }
    if (!priceContext) {
      priceContext = await getTopPrices();
    }
  }

  const messages = [...history, { role: 'user', content: userMessage }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBE.AIの司令塔エージェントです。
ポケモンカード・ワンピースカード・遊戯王などTCGの専門家として、オーナー（俺）からの指示に答えます。

口調はフランクで友達感覚にしてください。
・敬語は使わない
・「〜だよ」「〜だね」「〜じゃん」などカジュアルに
・絵文字は1〜2個だけ使ってOK
・300文字以内で答える
・改行は最小限（1〜2回まで）
・※や「---」などの記号は使わない
・マークダウン記法は絶対に使わない

カード価格の質問には以下のデータを参照して正確に答えてください。国内買取価格とeBay海外相場の両方があれば両方答える。データにないカードは「データにないから最新はショップで確認して」と伝える。
最新情報が必要な質問は必ずweb_searchで検索してから答える。${priceContext}`,
      messages,
    }),
  });

  const data = await res.json();
  const textBlocks = data.content?.filter(b => b.type === 'text');
  if (textBlocks?.length > 0) return textBlocks.map(b => b.text).join('\n');

  if (data.content?.some(b => b.type === 'tool_use')) {
    const toolUse = data.content.find(b => b.type === 'tool_use');
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `フランクに、マークダウンなし、改行最小限、300文字以内で答えてください。`,
        messages: [
          ...messages,
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const data2 = await res2.json();
    const texts = data2.content?.filter(b => b.type === 'text');
    return texts?.map(b => b.text).join('\n') || '処理できませんでした';
  }

  return '処理できませんでした';
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'LINE Webhook is running' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Read raw body and verify LINE signature
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(rawBody, signature)) {
      console.error('LINE署名検証失敗');
      return res.status(403).json({ error: 'Invalid signature' });
    }
    const body = JSON.parse(rawBody.toString());
    const events = body.events || [];
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        console.log('受信:', userMessage);

        // 承認コマンド処理
        const approveMatch = userMessage.match(/^承認(\d+)$/);
        if (approveMatch) {
          const articleId = parseInt(approveMatch[1]);
          await approveArticle(articleId);
          await sendLineMessage(replyToken, `✅ 記事ID:${articleId}を承認してサイトに公開しました！`);
          continue;
        }

        // 通常の会話
        const history = await loadHistory();
        const reply = await askClaude(userMessage, history);
        await saveMessage('user', userMessage);
        await saveMessage('assistant', reply);
        await sendLineMessage(replyToken, reply);
      }
    }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
