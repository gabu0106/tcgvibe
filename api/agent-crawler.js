const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const SITES = {
  cardrush_pokemon: { name: 'カードラッシュ_ポケカ', url: 'https://www.cardrush-pokemon.jp/' },
  cardrush_op: { name: 'カードラッシュ_ワンピース', url: 'https://www.cardrush-op.jp/' },
  raftel: { name: 'トレカラフテル', url: 'https://www.tcg-raftel.com/' },
  onehappy: { name: 'ワンハッピー', url: 'https://www.onehappy.co.jp/' },
  torecacamp: { name: 'トレカキャンプ', url: 'https://torecacamp-pokemon.com/' },
  hareruya: { name: '晴れるや2', url: 'https://www.hareruya2.com/' },
  torechart_pokemon: { name: 'トレチャ_ポケカ', url: 'https://torechart.com/pokemon' },
  torechart_op: { name: 'トレチャ_ワンピース', url: 'https://torechart.com/onepiece' },
  note_pros: { name: 'note_PROS', url: 'https://note.com/pros_02' },
  snkrdunk: { name: 'スニーカーダンク', url: 'https://snkrdunk.com/' },
};

async function loadMemory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.crawler&order=importance.desc&limit=10`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data.map(m => m.content).join('\n') : '';
  } catch { return ''; }
}

async function saveMemory(content, importance = 5) {
  await fetch(`${SUPABASE_URL}/rest/v1/agent_memory`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ agent_name: 'crawler', memory_type: 'site_insight', content, importance }),
  });
}

async function crawlSite(site, memory) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBEの情報収集エージェントです。
過去の学習：${memory || 'なし'}

指定サイトを徹底調査して以下のJSONのみ返してください：
{
  "site": "サイト名",
  "date": "YYYY/MM/DD",
  "highlights": ["具体的な注目情報（カード名・価格・数量を含む）"],
  "high_price_cards": ["カード名 買取価格円"],
  "trending_cards": ["注目カード名"],
  "summary": "具体的なカード名と価格を含む200文字以内のサマリー",
  "new_insight": "このサイトから学んだ新しい知見（次回に活かせること）"
}
JSONのみ返してください。`,
      messages: [{
        role: 'user',
        content: `サイト名: ${site.name}\nURL: ${site.url}\n今日: ${new Date().toLocaleDateString('ja-JP')}\n\n高額買取カード・価格変動・新入荷・注目情報を徹底収集してください。`
      }],
    }),
  });

  const data = await res.json();
  let resultText = '';

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
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `具体的なカード名と価格を含むJSONのみ返してください。`,
        messages: [
          { role: 'user', content: `${site.name}の最新情報をJSONで返してください。` },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const data2 = await res2.json();
    resultText = data2.content?.find(b => b.type === 'text')?.text || '';
  } else {
    resultText = data.content?.find(b => b.type === 'text')?.text || '';
  }

  console.log(`${site.name}:`, resultText.slice(0, 150));
  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.new_insight) await saveMemory(parsed.new_insight, 6);
      return parsed;
    } catch(e) { console.log('パース失敗'); }
  }
  return { site: site.name, summary: resultText.slice(0, 200), highlights: [], high_price_cards: [], trending_cards: [] };
}

async function saveToSupabase(data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/crawler_data`, {
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
  console.log('保存:', res.status);
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Crawler ready', sites: Object.keys(SITES) });
  if (req.method !== 'POST') return res.status(405).end();

  const { site: siteKey } = req.body;
  const memory = await loadMemory();

  if (siteKey && SITES[siteKey]) {
    const site = SITES[siteKey];
    try {
      console.log(`巡回: ${site.name}`);
      const data = await crawlSite(site, memory);
      await saveToSupabase(data);
      return res.status(200).json({ status: 'done', site: site.name, summary: data.summary });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).json({ status: 'ok', sites: Object.keys(SITES) });
}
