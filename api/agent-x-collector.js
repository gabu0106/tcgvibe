const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const MODEL = 'claude-haiku-4-5-20251001';

const RSS_QUERIES = [
  'ポケカ 買取 高騰',
  'ポケモンカード 相場',
  'ワンピースカード 買取',
  'TCG 投資 高騰',
  'ポケカ 入荷 速報',
];

async function fetchRSS(query) {
  try {
    const url = `https://nitter.net/search/rss?q=${encodeURIComponent(query)}&f=tweets`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await res.text();
    
    // RSSからテキストを抽出
    const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.slice(0, 20).map(item => {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || '';
      const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] || '';
      return `${title} ${desc}`.replace(/<[^>]+>/g, '').trim();
    }).filter(t => t.length > 10);
  } catch (e) {
    console.log('RSS取得失敗:', e.message);
    return [];
  }
}

async function fetchWithWebSearch(query) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `TCG情報収集エージェントです。X(Twitter)の最新投稿から情報を収集してください。
以下のJSONのみ返してください：
{"posts":["投稿内容1","投稿内容2","投稿内容3"]}`,
      messages: [{ 
        role: 'user', 
        content: `site:x.com OR site:twitter.com ${query} の最新投稿を10件収集してください。今日: ${new Date().toLocaleDateString('ja-JP')}` 
      }],
    }),
  });

  const data = await res.json();
  let text = '';

  if (data.content?.some(b => b.type === 'tool_use')) {
    const toolUse = data.content.find(b => b.type === 'tool_use');
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'JSONのみ返してください。',
        messages: [
          { role: 'user', content: `${query}のX投稿をJSONで返してください。` },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const d2 = await res2.json();
    text = d2.content?.find(b => b.type === 'text')?.text || '';
  } else {
    text = data.content?.find(b => b.type === 'text')?.text || '';
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]).posts || []; } catch {}
  }
  return [];
}

async function analyzeWithClaude(posts, keyword) {
  if (!posts.length) return null;
  const postsText = posts.join('\n---\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: `TCG情報分析エージェントです。投稿を分析して以下のJSONのみ返してください：
{"keyword":"検索キーワード","highlights":["注目情報1","注目情報2"],"high_price_cards":["高額カード名と価格"],"trending":["トレンドカード名"],"summary":"200文字以内のサマリー","alert":false}`,
      messages: [{ role: 'user', content: `キーワード: ${keyword}\n\n${postsText}\n\n分析してください。` }],
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

  for (const query of RSS_QUERIES) {
    try {
      console.log(`収集中: ${query}`);
      
      // RSSとweb_searchを組み合わせて取得
      const [rssPosts, searchPosts] = await Promise.all([
        fetchRSS(query),
        fetchWithWebSearch(query),
      ]);
      
      const allPosts = [...new Set([...rssPosts, ...searchPosts])];
      console.log(`${query}: ${allPosts.length}件取得`);

      if (allPosts.length > 0) {
        const analysis = await analyzeWithClaude(allPosts, query);
        if (analysis) {
          await saveToSupabase(analysis);
          results.push({ query, status: 'ok', count: allPosts.length });
        }
      } else {
        results.push({ query, status: 'no_results' });
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`${query} エラー:`, e.message);
      results.push({ query, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ status: 'done', results });
}
