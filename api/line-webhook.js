const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

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
        console.log('TOKEN先頭:', LINE_CHANNEL_ACCESS_TOKEN?.slice(0,10));
        await sendLineMessage(replyToken, `✅ 受信しました：「${userMessage}」\nTCGVIBE監視Botが動作しています！`);
      }
    }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
