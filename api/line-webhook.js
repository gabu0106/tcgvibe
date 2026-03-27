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

async function askClaudeWithSearch(userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        }
      ],
      system: `あなたはTCGVIBE.AIの司令塔エージェントです。
ポケモンカード・ワンピースカード・遊戯王などTCGの専門家として、オーナーからの指示に答えます。

必ずweb_searchツールを使って最新情報を取得してから答えてください。
特に以下は必ず検索してください：
- カード環境・tier情報
- 新弾・最新パック情報  
- カード相場・買取価格
- 大会結果・優勝デッキ

返答は300文字以内の日本語で、要点だけ簡潔に答えてください。`,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  const data = await res.json();
  console.log('Claude response:', JSON.stringify(data).slice(0, 200));

  // tool_useとtextブロックを処理
  const textBlocks = data.content?.filter(b => b.type === 'text');
  if (textBlocks?.length > 0) {
    return textBlocks.map(b => b.text).join('\n');
  }

  // tool_useのみの場合は再度呼び出し
  if (data.content?.some(b => b.type === 'tool_use')) {
    const toolUse = data.content.find(b => b.type === 'tool_use');
    const toolResult = data.content.find(b => b.type === 'tool_result') || { content: '検索完了' };

    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `あなたはTCGVIBE.AIの司令塔エージェントです。検索結果をもとに300文字以内の日本語で簡潔に答えてください。`,
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }] },
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

        const reply = await askClaudeWithSearch(userMessage);
        await sendLineMessage(replyToken, reply);
      }
    }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
