const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

async function loadApprovedArticles() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_articles?approved=eq.true&x_posted=eq.false&order=created_at.desc&limit=5`,
    { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
  );
  return res.json();
}

async function loadMemory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_name=eq.poster&order=importance.desc&limit=10`,
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
    body: JSON.stringify({ agent_name: 'poster', memory_type: 'post_insight', content, importance }),
  });
}

async function generateXPost(article, memory) {
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
      system: `あなたはTCGVIBEのX投稿エージェントです。
過去の学習：${memory || 'なし'}

記事をもとにバズりやすいX投稿文を生成してください。
以下のJSONのみ返してください：
{
  "post": "投稿文（140文字以内、ハッシュタグ含む、絵文字あり）",
  "new_insight": "投稿から学んだこと"
}`,
      messages: [{
        role: 'user',
        content: `タイトル: ${article.title}\n内容: ${article.content?.slice(0, 300)}\n\nバズりやすい投稿文を生成してください。`
      }],
    }),
  });

  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { post: `${article.title}\n#ポケカ #TCG #TCGVIBE` };
}

async function postToX(text) {
  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${X_BEARER_TOKEN}`,
    },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  console.log('X投稿結果:', JSON.stringify(data));
  return data;
}

async function markAsPosted(articleId) {
  await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${articleId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ x_posted: true }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Poster agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const [articles, memory] = await Promise.all([
      loadApprovedArticles(),
      loadMemory(),
    ]);

    if (!articles.length) {
      return res.status(200).json({ status: 'no_approved', message: '承認済み記事がありません' });
    }

    const results = [];
    for (const article of articles) {
      const postData = await generateXPost(article, memory);
      const xResult = await postToX(postData.post);
      await markAsPosted(article.id);
      if (postData.new_insight) await saveMemory(postData.new_insight, 6);
      results.push({ id: article.id, title: article.title, posted: !!xResult.data });
    }

    return res.status(200).json({ status: 'done', results });
  } catch (e) {
    console.error('エラー:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
