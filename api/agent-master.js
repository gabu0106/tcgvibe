const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const BASE_URL = 'https://tcgvibe.com';
const MODEL = 'claude-haiku-4-5-20251001';

async function loadMemory(agentName) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.${agentName}&order=importance.desc&limit=20`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data.map(m => m.content).join('\n') : '';
  } catch { return ''; }
}

async function saveMemory(agentName, content, importance = 5) {
  await fetch(`${SUPABASE_URL}/rest/v1/agent_memory`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ agent_name: agentName, memory_type: 'insight', content, importance }),
  });
}

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
  const todayStr = today.toISOString().split('T')[0];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/crawler_data?select=*&crawled_at=gte.${yesterday}&crawled_at=lt.${todayStr}&order=crawled_at.desc`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadPriceHistory() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/price_history?select=*&order=recorded_at.desc&limit=200`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
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

async function sendLine(message) {
  await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ messages: [{ type: 'text', text: message }] }),
  });
}

async function callClaude(system, userContent, useSearch = true) {
  const tools = useSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : [];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, tools, system, messages: [{ role: 'user', content: userContent }] }),
  });
  const data = await res.json();

  if (data.content?.some(b => b.type === 'tool_use')) {
    const toolUse = data.content.find(b => b.type === 'tool_use');
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500, tools,
        system: 'JSONのみ返してください。',
        messages: [
          { role: 'user', content: userContent },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const d2 = await res2.json();
    return d2.content?.find(b => b.type === 'text')?.text || '';
  }
  return data.content?.find(b => b.type === 'text')?.text || '';
}

async function runAnalyzer(todayData, priceHistory) {
  const memory = await loadMemory('analyzer');
  const dataStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');
  const historyStr = priceHistory.slice(0, 30).map(p => `${p.card_name}: ${p.price}円`).join('\n');

  const text = await callClaude(
    `あなたはTCGVIBEの価格分析エージェントです。過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"rising":[{"card":"カード名","reason":"理由","confidence":85}],"falling":[{"card":"カード名","reason":"理由"}],"alert_cards":["注目カード"],"summary":"市場サマリー300文字","new_memories":["新しい知見"]}`,
    `【本日データ】\n${dataStr}\n\n【価格履歴】\n${historyStr}\n\n高騰・暴落・パターンを分析してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      for (const mem of (result.new_memories || [])) await saveMemory('analyzer', mem, 7);
      return result;
    } catch {}
  }
  return { rising: [], falling: [], alert_cards: [], summary: text.slice(0, 300) };
}

async function runAlert(todayData, yesterdayData, analyzerResult) {
  const memory = await loadMemory('alert');
  const todayStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');
  const yesterdayStr = yesterdayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');

  const text = await callClaude(
    `あなたはTCGVIBEのアラートエージェントです。過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"alerts":[{"card":"カード名","type":"高騰 or 暴落","detail":"詳細","urgency":"高 or 中 or 低"}],"daily_report":"本日の市場サマリー300文字","new_insight":"学んだこと"}`,
    `【今日】\n${todayStr}\n\n【昨日】\n${yesterdayStr}\n\n【分析結果】\n${JSON.stringify(analyzerResult)}\n\n高騰・暴落を検知してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      if (result.new_insight) await saveMemory('alert', result.new_insight, 7);
      return result;
    } catch {}
  }
  return { alerts: [], daily_report: text.slice(0, 300) };
}

async function runWriter(todayData) {
  const memory = await loadMemory('writer');
  const dataStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n\n');

  const text = await callClaude(
    `あなたはTCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"記事タイトル","tag":"価格情報 or 環境解説 or 大会レポート","emoji":"🃏","summary":"要約100文字","content":"記事本文800文字以上","x_post":"X投稿文140文字以内","new_insight":"学んだこと"}`,
    `【本日データ】\n${dataStr}\n\n今日一番価値のある記事を1本生成してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const article = JSON.parse(match[0]);
      if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/auto_articles`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'apikey': SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({ title: article.title, content: article.content, tag: article.tag, status: 'pending', approved: false, x_posted: false }),
      });
      const saved = await saveRes.json();
      const articleId = saved[0]?.id;
      await sendLine(`📝 新記事生成！\n\n「${article.title}」\n\n${article.summary}\n\n承認する場合は「承認${articleId}」と送ってください`);
      return { title: article.title, id: articleId };
    } catch {}
  }
  return null;
}

async function approveArticle(articleId) {
  await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${articleId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Master agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, article_id } = req.body || {};

  if (action === 'approve' && article_id) {
    await approveArticle(article_id);
    await fetch(`${BASE_URL}/api/agent-poster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.status(200).json({ status: 'approved', article_id });
  }

  try {
    console.log('🚀 全エージェント起動');
    const [todayData, yesterdayData, priceHistory] = await Promise.all([
      loadTodayData(),
      loadYesterdayData(),
      loadPriceHistory(),
    ]);

    const allCards = todayData.flatMap(d => { try { return JSON.parse(d.high_price_cards || '[]'); } catch { return []; } });
    await savePriceHistory(allCards);

    const analyzerResult = await runAnalyzer(todayData, priceHistory);
    console.log('分析完了:', analyzerResult.summary?.slice(0, 50));

    const alertResult = await runAlert(todayData, yesterdayData, analyzerResult);
    console.log('アラート:', alertResult.alerts?.length, '件');

    let report = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n${alertResult.daily_report || analyzerResult.summary || 'データ収集中'}`;

    const highAlerts = alertResult.alerts?.filter(a => a.urgency === '高') || [];
    if (highAlerts.length) {
      report += '\n\n🚨 緊急アラート：';
      highAlerts.forEach(a => { report += `\n${a.type === '高騰' ? '📈' : '📉'} ${a.card}: ${a.detail}`; });
    }
    await sendLine(report);

    const article = await runWriter(todayData);
    console.log('記事生成:', article?.title);

    await saveMemory('master', `${new Date().toLocaleDateString('ja-JP')}処理完了`, 5);

    return res.status(200).json({ status: 'done', analyzer: analyzerResult.summary, alerts: alertResult.alerts?.length, article: article?.title });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
