const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

const MODEL = 'claude-haiku-4-5-20251001';

const TARGET_KEYWORDS = [
  'ポケカ 買取',
  'ポケモンカード 高騰',
  'ポケカ 入荷',
  'ワンピースカード 買取',
  'TCG 高騰',
];

async function searchTweets(query) {
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=created_at,text`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${X_BEARER_TOKEN}` } });
  const data = await res.json();
  console.log(`検索「${query}」結果:`, data.meta?.result_count || 0, '件');
  return data.data || [];
}

async function analyzeWithClaude(tweets, keyword) {
  if (!tweets.length) return null;
  const tweetTexts = tweets.map(t => t.text).join('\n---\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: `あなたはTCG情報分析エージェントです。
X（Twitter）の投稿を分析して以下のJSONのみ返してください：
{"keyword":"検索キーワード","highlights":["注目情報1","注目情報2"],"high_price_cards":["高額カード名と価格"],"trending":["トレンドカード名"],"summary":"200文字以内のサマリー","alert":true}`,
      messages: [{ role: 'user', content: `キーワード: ${keyword}\n\n${tweetTexts}\n\n分析してください。` }],
    }),
  });
  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return { keyword, summary: text.slice(0, 200) };
}

async function saveToSupabase(data) {
  await fetch(`${SUPABASE_URL}/rest/v1/x_collected_data`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      keyword: data.keyword || '',
      highlights: JSON.stringify(data.highlights || []),
      high_price_cards: JSON.stringify(data.high_price_cards || []),
      trending: JSON.stringify(data.trending || []),
      summary: data.summary || '',
      alert: data.alert || false,
      raw_data: JSON.stringify(data),
      collected_at: new Date().toISOString(),
    }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'X collector agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const results = [];
  for (const keyword of TARGET_KEYWORDS) {
    try {
      console.log(`X検索中: ${keyword}`);
      const tweets = await searchTweets(keyword);
      if (tweets.length > 0) {
        const analysis = await analyzeWithClaude(tweets, keyword);
        if (analysis) {
          await saveToSupabase(analysis);
          results.push({ keyword, status: 'ok', count: tweets.length });
        }
      } else {
        results.push({ keyword, status: 'no_results' });
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`${keyword} エラー:`, e.message);
      results.push({ keyword, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ status: 'done', results });
}
