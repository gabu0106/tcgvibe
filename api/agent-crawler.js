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
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCG情報収集エージェントです。
指定されたURLのサイトから最新情報を収集して、必ず以下のJSON形式のみで返してください。
前置きや説明は絶対に書かないでください。JSONのみです：
{"site":"サイト名","date":"取得日","highlights":["注目情報1","注目情報2"],"high_price_cards":["高額カード名と価格"],"summary":"200文字以内のサマリー"}`,
      messages: [{ 
        role: 'user', 
        content: `サイト名: ${site.name}\nURL: ${site.url}\n今日: ${new Date().toLocaleDateString('ja-JP')}\n\nこのサイトの最新買取価格・高額カード・注目情報を収集してJSONで返してください。` 
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
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `JSONのみ返してください。前置き不要。`,
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

  console.log(`${site.name} 結果:`, resultText.slice(0, 100));

  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.log('JSONパース失敗:', e.message);
    }
  }
  
  return { site: site.name, summary: resultText.slice(0, 200), highlights: [], high_price_cards: [] };
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
  console.log('Supabase保存:', res.status);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Crawler agent ready', sites: Object.keys(SITES) });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { site: siteKey } = req.body;
  
  if (siteKey && SITES[siteKey]) {
    const site = SITES[siteKey];
    try {
      console.log(`巡回中: ${site.name}`);
      const data = await crawlSite(site);
      await saveToSupabase(data);
      return res.status(200).json({ status: 'done', site: site.name, summary: data.summary });
    } catch (e) {
      console.error(`エラー:`, e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  const results = [];
  for (const [key, site] of Object.entries(SITES)) {
    try {
      console.log(`巡回中: ${site.name}`);
      const data = await crawlSite(site);
      await saveToSupabase(data);
      results.push({ site: site.name, status: 'ok' });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      results.push({ site: site.name, status: 'error', error: e.message });
    }
  }
  return res.status(200).json({ status: 'done', results });
}
