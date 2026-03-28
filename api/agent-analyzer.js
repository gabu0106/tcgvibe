const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

async function loadRecentData() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/crawler_data?select=*&order=crawled_at.desc&limit=100`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadPriceHistory() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/price_history?select=*&order=recorded_at.desc&limit=500`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadAgentMemory(agentName) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.${agentName}&order=importance.desc&limit=20`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function saveAgentMemory(agentName, memoryType, content, importance = 5) {
  await fetch(`${SUPABASE_URL}/rest/v1/agent_memory`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ agent_name: agentName, memory_type: memoryType, content, importance }),
  });
}

async function savePriceHistory(cards) {
  for (const card of cards) {
    const match = card.match(/(.+?)\s+([\d,]+)円/);
    if (match) {
      await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'apikey': SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          card_name: match[1].trim(),
          price: parseInt(match[2].replace(',', '')),
          shop: 'auto',
        }),
      });
    }
  }
}

async function savePatternAnalysis(patterns) {
  for (const pattern of patterns) {
    await fetch(`${SUPABASE_URL}/rest/v1/pattern_analysis`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        card_name: pattern.card_name,
        pattern: pattern.pattern,
        confidence: pattern.confidence,
      }),
    });
  }
}

async function analyzeWithClaude(recentData, priceHistory, memory) {
  const dataStr = recentData.map(d => `${d.site_name}: ${d.summary}`).join('\n');
  const historyStr = priceHistory.slice(0, 50).map(p => `${p.card_name}: ${p.price}円 (${p.recorded_at})`).join('\n');
  const memoryStr = memory.map(m => m.content).join('\n');

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
      system: `あなたはTCGVIBEの価格分析エージェントです。
過去のデータと現在のデータを比較して高騰・暴落を検知します。
学習した知識：
${memoryStr}

以下のJSONのみ返してください：
{
  "rising": [{"card": "カード名", "reason": "理由", "confidence": 85}],
  "falling": [{"card": "カード名", "reason": "理由", "confidence": 70}],
  "patterns": [{"card_name": "カード名", "pattern": "パターン説明", "confidence": 80}],
  "alert_cards": ["今すぐ注目すべきカード名"],
  "summary": "本日の市場サマリー300文字以内",
  "new_memories": ["記憶すべき新しい知見1", "知見2"]
}`,
      messages: [{
        role: 'user',
        content: `【本日の収集データ】\n${dataStr}\n\n【価格履歴】\n${historyStr}\n\n高騰・暴落・パターンを分析してください。`
      }],
    }),
  });

  const data = await res.json();

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
        system: `JSONのみ返してください。`,
        messages: [
          { role: 'user', content: `TCG価格分析をJSONで返してください。` },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const data2 = await res2.json();
    const text = data2.content?.find(b => b.type === 'text')?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  }

  const text = data.content?.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return { rising: [], falling: [], patterns: [], alert_cards: [], summary: '', new_memories: [] };
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Analyzer agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const [recentData, priceHistory, memory] = await Promise.all([
      loadRecentData(),
      loadPriceHistory(),
      loadAgentMemory('analyzer'),
    ]);

    const analysis = await analyzeWithClaude(recentData, priceHistory, memory);

    // 価格履歴を保存
    const allCards = recentData.flatMap(d => {
      try { return JSON.parse(d.high_price_cards || '[]'); } catch { return []; }
    });
    await savePriceHistory(allCards);

    // パターンを保存
    if (analysis.patterns?.length) await savePatternAnalysis(analysis.patterns);

    // 新しい知見を記憶
    for (const mem of (analysis.new_memories || [])) {
      await saveAgentMemory('analyzer', 'insight', mem, 7);
    }

    console.log('分析完了:', analysis.summary);
    return res.status(200).json({ status: 'done', analysis });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
