const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

async function checkSite() {
  try {
    const res = await fetch('https://tcgvibe.com/api/articles');
    return res.ok ? '✅ サイト正常稼働中' : `⚠️ 異常あり（${res.status}）`;
  } catch (e) {
    return `❌ サイト接続不可: ${e.message}`;
  }
}

async function askClaude(userMessage, siteStatus) {
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
      system: `あなたはTCGVIBE.AIの監視エージェントです。
サイト状態: ${siteStatus}
ユーザーからの指示に簡潔に日本語で答えてください。
「データ更新」「価格取得」の指示には「GitHub Actionsで自動実行されます。次回実行は毎朝6時です」と答えてください。
返答は200文字以内にしてください。`,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || '処理できませんでした';
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'LINE Webhook is running' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        console.log('受信:', userMessage);

        const siteStatus = await checkSite();
        const reply = await askClaude(userMessage, siteStatus);
        await sendLineMessage(replyToken, reply);
      }
    }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
