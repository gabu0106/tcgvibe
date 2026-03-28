const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

async function loadTodayData() {
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/crawler_data?select=*&crawled_at=gte.${today}&order=crawled_at.desc`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadYesterdayData() {
  const today = new Date();
  const yesterday = new Date(today - 86400000).toISOString().split('T')[0];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/crawler_data?select=*&crawled_at=gte.${yesterday}&crawled_at=lt.${today.toISOString().split('T')[0]}&order=crawled_at.desc`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadMemory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.alert&order=importance.desc&limit=10`,
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
    body: JSON.stringify({ agent_name: 'alert', memory_type: 'alert_insight', content, importance }),
  });
}

async function detectAlerts(todayData, yesterdayData, memory) {
  const todayStr = todayData.map(d => `${d.site_name}: ${d.summary} 高額:${d.high_price_cards}`).join('\n');
  const yesterdayStr = yesterdayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');

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
      system: `あなたはTCGVIBEの高騰アラートエージェントです。
過去の学習：${memory || 'なし'}

今日と昨日のデータを比較して高騰・暴落を検知します。
以下のJSONのみ返してください：
{
  "alerts": [
    {
      "card": "カード名",
      "type": "高騰 or 暴落 or 注目",
      "detail": "具体的な変動内容",
      "urgency": "高 or 中 or 低"
    }
  ],
  "daily_report": "本日の市場サマリー（300文字以内、具体的なカード名・価格含む）",
  "new_insight": "学んだこと"
}`,
      messages: [{
        role: 'user',
        content: `【今日のデータ】\n${todayStr}\n\n【昨日のデータ】\n${yesterdayStr}\n\n高騰・暴落・注目カードを検知してください。`
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
        system: `JSONのみ返してください。`,
        messages: [
          { role: 'user', content: `TCG高騰アラート分析をJSONで返してください。` },
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

  const match = resultText.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { alerts: [], daily_report: resultText.slice(0, 300) };
}

async function sendLineAlert(alerts, dailyReport) {
  let message = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n${dailyReport}`;

  const highUrgency = alerts.filter(a => a.urgency === '高');
  if (highUrgency.length) {
    message += '\n\n🚨 緊急アラート：';
    highUrgency.forEach(a => {
      message += `\n${a.type === '高騰' ? '📈' : '📉'} ${a.card}: ${a.detail}`;
    });
  }

  const midUrgency = alerts.filter(a => a.urgency === '中');
  if (midUrgency.length) {
    message += '\n\n⚠️ 注目：';
    midUrgency.forEach(a => {
      message += `\n${a.card}: ${a.detail}`;
    });
  }

  await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ messages: [{ type: 'text', text: message }] }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Alert agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const [todayData, yesterdayData, memory] = await Promise.all([
      loadTodayData(),
      loadYesterdayData(),
      loadMemory(),
    ]);

    const result = await detectAlerts(todayData, yesterdayData, memory);
    await sendLineAlert(result.alerts || [], result.daily_report || '');
    if (result.new_insight) await saveMemory(result.new_insight, 7);

    console.log('アラート送信完了:', result.alerts?.length, '件');
    return res.status(200).json({ status: 'done', alerts: result.alerts?.length, report: result.daily_report });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
