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

async function loadAnalysis() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pattern_analysis?select=*&order=last_updated.desc&limit=20`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadMemory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.writer&order=importance.desc&limit=10`,
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
    body: JSON.stringify({ agent_name: 'writer', memory_type: 'article_insight', content, importance }),
  });
}

async function generateArticle(crawlerData, analysis, memory) {
  const dataStr = crawlerData.map(d => `${d.site_name}: ${d.summary}\n高額: ${d.high_price_cards}`).join('\n\n');
  const analysisStr = analysis.slice(0, 10).map(a => `${a.card_name}: ${a.pattern}`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBEの記事執筆エージェントです。
過去の学習：${memory || 'なし'}

収集データをもとに読者が価値を感じる記事を生成します。
以下のJSONのみ返してください：
{
  "title": "記事タイトル（具体的なカード名・数字を含む）",
  "tag": "大会レポート or 環境解説 or デッキ紹介 or 価格情報",
  "emoji": "🃏",
  "summary": "記事の要約（100文字）",
  "content": "記事本文（800〜1200文字、具体的なカード名・価格・理由を含む）",
  "x_post": "X投稿文（140文字以内、ハッシュタグ含む）",
  "new_insight": "記事執筆から学んだこと"
}`,
      messages: [{
        role: 'user',
        content: `【本日の収集データ】\n${dataStr}\n\n【分析パターン】\n${analysisStr}\n\n今日一番価値のある記事を1本生成してください。`
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
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `JSONのみ返してください。`,
        messages: [
          { role: 'user', content: `TCG記事をJSONで生成してください。` },
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

  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch(e) { console.log('パース失敗'); }
  }
  return null;
}

async function saveArticle(article) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/auto_articles`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      title: article.title,
      content: article.content,
      tag: article.tag,
      status: 'pending',
      approved: false,
      x_posted: false,
    }),
  });
  const data = await res.json();
  return data[0]?.id;
}

async function notifyLine(article, articleId) {
  const message = `📝 新記事が生成されました！\n\n「${article.title}」\n\n${article.summary}\n\n承認しますか？\n「承認${articleId}」と返信してください`;
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
  if (req.method === 'GET') return res.status(200).json({ status: 'Writer agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const [crawlerData, analysis, memory] = await Promise.all([
      loadTodayData(),
      loadAnalysis(),
      loadMemory(),
    ]);

    if (!crawlerData.length) {
      return res.status(200).json({ status: 'no_data', message: '本日のデータがありません' });
    }

    const article = await generateArticle(crawlerData, analysis, memory);
    if (!article) return res.status(200).json({ status: 'failed', message: '記事生成失敗' });

    const articleId = await saveArticle(article);
    if (article.new_insight) await saveMemory(article.new_insight, 6);
    await notifyLine(article, articleId);

    console.log('記事生成完了:', article.title);
    return res.status(200).json({ status: 'done', title: article.title, id: articleId });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
