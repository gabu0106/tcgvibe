const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const BASE_URL = 'https://tcgvibe.com';

async function callAgent(endpoint, body = {}) {
  try {
    const res = await fetch(`${BASE_URL}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(`${endpoint}完了:`, JSON.stringify(data).slice(0, 100));
    return { status: 'ok', data };
  } catch (e) {
    console.error(`${endpoint}エラー:`, e.message);
    return { status: 'error', error: e.message };
  }
}

async function loadMemory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.master&order=importance.desc&limit=20`,
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
    body: JSON.stringify({ agent_name: 'master', memory_type: 'master_insight', content, importance }),
  });
}

async function sendLineReport(results, memory) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `あなたはTCGVIBEの司令塔です。
エージェントの実行結果をオーナーに報告します。
フランクな口調で、絵文字を使って簡潔に報告してください。`,
      messages: [{
        role: 'user',
        content: `実行結果:\n${JSON.stringify(results, null, 2)}\n\n本日の自動処理完了報告をLINEに送る文章を作成してください。`
      }],
    }),
  });

  const data = await res.json();
  const report = data.content?.find(b => b.type === 'text')?.text || '本日の処理が完了しました';

  await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ messages: [{ type: 'text', text: report }] }),
  });
}

async function approveArticle(articleId) {
  await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${articleId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ approved: true }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Master agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, article_id } = req.body;

  // 記事承認処理
  if (action === 'approve' && article_id) {
    await approveArticle(article_id);
    await callAgent('agent-poster');
    return res.status(200).json({ status: 'approved', article_id });
  }

  // 全エージェント順次実行
  const memory = await loadMemory();
  const results = {};

  console.log('🚀 全エージェント起動開始');

  // Step1: 分析エージェント
  console.log('Step1: 価格分析');
  results.analyzer = await callAgent('agent-analyzer');
  await new Promise(r => setTimeout(r, 2000));

  // Step2: 記事生成エージェント
  console.log('Step2: 記事生成');
  results.writer = await callAgent('agent-writer');
  await new Promise(r => setTimeout(r, 2000));

  // Step3: アラートエージェント
  console.log('Step3: アラート送信');
  results.alert = await callAgent('agent-alert');

  // Step4: 完了報告
  await saveMemory(`${new Date().toLocaleDateString('ja-JP')}の処理完了。エラー: ${Object.values(results).filter(r => r.status === 'error').length}件`, 5);
  await sendLineReport(results, memory);

  console.log('全エージェント完了');
  return res.status(200).json({ status: 'done', results });
}
