const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

async function sendLineMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
  const data = await res.json();
  console.log('LINE reply result:', JSON.stringify(data));
}

async function loadHistory() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chat_history?select=*&order=created_at.asc&limit=10`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY } }
    );
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(row => ({ role: row.role, content: row.content }));
  } catch { return []; }
}

async function saveMessage(role, content) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ role, content }),
    });
  } catch {}
}

async function askClaude(userMessage, history) {
  const messages = [...history, { role: 'user', content: userMessage }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `あなたはTCGVIBE.AIの司令塔エージェントです。
ポケモンカード・ワンピースカード・遊戯王などTCGの専門家として、オーナー（俺）からの指示に答えます。

口調はフランクで友達感覚にしてください。
・敬語は使わない
・「〜だよ」「〜だね」「〜じゃん」などカジュアルに
・絵文字は1〜2個だけ使ってOK
・300文字以内で答える

文章のルール：
・改行は最小限にする（1〜2回まで）
・※や「---」などの記号は使わない
・箇条書きは3つまで
・マークダウン記法は絶対に使わない

最新情報が必要な質問は必ずweb_searchで検索してから答える。`,
      messages,
    }),
  });

  const data = await res.json();
  console.log('Claude response:', JSON.stringify(data).slice(0, 200));

  const textBlocks = data.content?.filter(b => b.type === 'text');
  if (textBlocks?.length > 0) return textBlocks.map(b => b.text).join('\n');

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `フランクに、マークダウンなし、改行最小限、300文字以内で答えてください。`,
        messages: [
          ...messages,
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '検索完了' }] },
        ],
      }),
    });
    const data2 = await res2.json();
    const texts = data2.content?.filter(b => b.type === 'text');
    return texts?.map(b => b.text).join('\n') || '処理できませんでした';
  }

  return '処理できませんでした';
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'LINE Webhook is running' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        console.log('受信:', userMessage);

        const history = await loadHistory();
        const reply = await askClaude(userMessage, history);
        await saveMessage('user', userMessage);
        await saveMessage('assistant', reply);
        await sendLineMessage(replyToken, reply);
      }
    }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
