　const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const BASE_URL = 'https://tcgvibe.com';

// ===== メモリ管理 =====
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

// ===== データ取得 =====
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

// ===== 価格履歴保存 =====
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

// ===== LINE送信 =====
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

// ===== 価格分析エージェント =====
async function runAnalyzer(todayData, priceHistory) {
  const memory = await loadMemory('analyzer');
  const dataStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');
  const historyStr = priceHistory.slice(0, 50).map(p => `${p.card_name}: ${p.price}円`).join('\n');

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
      system: `あなたはTCGVIBEの価格分析エージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"rising":[{"card":"カード名","reason":"理由","confidence":85}],"falling":[{"card":"カード名","reason":"理由"}],"alert_cards":["注目カード"],"summary":"市場サマリー300文字","new_memories":["新しい知見"]}`,
      messages: [{ role: 'user', content: `【本日データ】\n${dataStr}\n\n【価格履歴】\n${historyStr}\n\n高騰・暴落・パターンを分析してください。` }],
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
        model: 'claude-sonnet-4-20250514', max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'JSONのみ返してください。',
        messages: [
          { role: 'user', content: 'TCG価格分析をJSONで返してください。' },
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
    try {
      const result = JSON.parse(match[0]);
      for (const mem of (result.new_memories || [])) await saveMemory('analyzer', mem, 7);
      return result;
    } catch {}
  }
  return { rising: [], falling: [], alert_cards: [], summary: text.slice(0, 300) };
}

// ===== アラートエージェント =====
async function runAlert(todayData, yesterdayData, analyzerResult) {
  const memory = await loadMemory('alert');
  const todayStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');
  const yesterdayStr = yesterdayData.map(d => `${d.site_name}: ${d.summary}`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBEのアラートエージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"alerts":[{"card":"カード名","type":"高騰 or 暴落","detail":"詳細","urgency":"高 or 中 or 低"}],"daily_report":"本日の市場サマリー300文字","new_insight":"学んだこと"}`,
      messages: [{ role: 'user', content: `【今日】\n${todayStr}\n\n【昨日】\n${yesterdayStr}\n\n【分析結果】\n${JSON.stringify(analyzerResult)}\n\n高騰・暴落を検知してください。` }],
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
        model: 'claude-sonnet-4-20250514', max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'JSONのみ返してください。',
        messages: [
          { role: 'user', content: 'TCGアラート分析をJSONで返してください。' },
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
    try {
      const result = JSON.parse(match[0]);
      if (result.new_insight) await saveMemory('alert', result.new_insight, 7);
      return result;
    } catch {}
  }
  return { alerts: [], daily_report: text.slice(0, 300) };
}

// ===== 記事生成エージェント =====
async function runWriter(todayData) {
  const memory = await loadMemory('writer');
  const dataStr = todayData.map(d => `${d.site_name}: ${d.summary}`).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBEの記事執筆エージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"記事タイトル","tag":"価格情報 or 環境解説 or 大会レポート","emoji":"🃏","summary":"要約100文字","content":"記事本文800〜1200文字","x_post":"X投稿文140文字以内","new_insight":"学んだこと"}`,
      messages: [{ role: 'user', content: `【本日データ】\n${dataStr}\n\n今日一番価値のある記事を1本生成してください。` }],
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
        model: 'claude-sonnet-4-20250514', max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'JSONのみ返してください。',
        messages: [
          { role: 'user', content: 'TCG記事をJSONで生成してください。' },
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
      await sendLine(`📝 新記事生成！\n\n「${article.title}」\n\n${article.summary}\n\n承認する場合はLINEで「承認${articleId}」と送ってください`);
      return { title: article.title, id: articleId };
    } catch {}
  }
  return null;
}

// ===== メイン処理 =====
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
    const articles = await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${article_id}&select=*`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY }
    }).then(r => r.json());
    if (articles[0]) {
      await fetch(`${BASE_URL}/api/agent-poster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    return res.status(200).json({ status: 'approved', article_id });
  }

  try {
    console.log('🚀 全エージェント起動');
    const [todayData, yesterdayData, priceHistory] = await Promise.all([
      loadTodayData(),
      loadYesterdayData(),
      loadPriceHistory(),
    ]);

    // 価格履歴保存
    const allCards = todayData.flatMap(d => { try { return JSON.parse(d.high_price_cards || '[]'); } catch { return []; } });
    await savePriceHistory(allCards);

    // 分析
    const analyzerResult = await runAnalyzer(todayData, priceHistory);
    console.log('分析完了:', analyzerResult.summary?.slice(0, 50));

    // アラート
    const alertResult = await runAlert(todayData, yesterdayData, analyzerResult);
    console.log('アラート:', alertResult.alerts?.length, '件');

    // LINE日報送信
    let report = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n${alertResult.daily_report || analyzerResult.summary}`;
    if (alertResult.alerts?.filter(a => a.urgency === '高').length) {
      report += '\n\n🚨 緊急アラート：';
      alertResult.alerts.filter(a => a.urgency === '高').forEach(a => {
        report += `\n${a.type === '高騰' ? '📈' : '📉'} ${a.card}: ${a.detail}`;
      });
    }
    await sendLine(report);

    // 記事生成
    const article = await runWriter(todayData);
    console.log('記事生成:', article?.title);

    await saveMemory('master', `${new Date().toLocaleDateString('ja-JP')}処理完了`, 5);

    return res.status(200).json({ status: 'done', analyzer: analyzerResult.summary, alerts: alertResult.alerts?.length, article: article?.title });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
