const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const SITES = [
  { name: 'カードラッシュ', query: 'カードラッシュ ポケカ 買取価格 高騰 最新' },
  { name: 'トレカラフテル', query: 'トレカラフテル ポケカ 買取 最新情報' },
  { name: 'ワンハッピー', query: 'ワンハッピー トレカ 買取価格 最新' },
  { name: 'トレカキャンプ', query: 'トレカキャンプ ポケカ 買取 最新' },
  { name: '晴れるや2', query: '晴れるや2 トレカ 買取価格 最新情報' },
  { name: 'TCG PORTAL', query: 'TCG PORTAL ポケカ 環境 最新' },
  { name: 'ポケカ環境', query: 'ポケモンカード 環境デッキ tier 最新 2026' },
  { name: 'X買取情報', query: 'site:x.com ポケカ 買取表 最新 入荷' },
];

async function crawlSite(site) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCG情報収集エージェントです。
指定されたキーワードで検索して、以下の情報をJSON形式で返してください：
{
  "site": "サイト名",
  "date": "取得日",
  "highlights": ["注目情報1", "注目情報2", "注目情報3"],
  "high_price_cards": ["高額カード1", "高額カード2"],
  "summary": "全体サマリー200文字以内"
}
必ずJSONのみ返してください。前置きや説明は不要です。`,
      messages: [{ role: 'user', content: `${site.query} の最新情報を収集してください。今日の日付: ${new Date().toLocaleDateString('ja-JP')}` }],
    }),
  });

  const data = await res.json();
  
  // tool_useの結果を処理
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `JSONのみ返してください。`,
        messages: [
          { role: 'user', content: `${site.query} の最新情報を収集してください。` },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const data2 = await res2.json();
    const text = data2.content?.find(b => b.type === 'text')?.text || '{}';
    try {
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return { site: site.name, summary: text.slice(0, 200) };
    }
  }

  const text = data.content?.find(b => b.type === 'text')?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { site: site.name, summary: text.slice(0, 200) };
  }
}

async function saveToSupabase(data) {
  await fetch(`${SUPABASE_URL}/rest/v1/crawler_data`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      site_name: data.site || '',
      highlights: JSON.stringify(data.highlights || []),
      high_price_cards: JSON.stringify(data.high_price_cards || []),
      summary: data.summary || '',
      raw_data: JSON.stringify(data),
      crawled_at: new Date().toISOString(),
    }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Crawler agent ready' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const results = [];
  for (const site of SITES) {
    try {
      console.log(`巡回中: ${site.name}`);
      const data = await crawlSite(site);
      await saveToSupabase(data);
      results.push({ site: site.name, status: 'ok' });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`${site.name} エラー:`, e.message);
      results.push({ site: site.name, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ status: 'done', results });
}
