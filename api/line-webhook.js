import crypto from 'crypto';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// LINEにメッセージを送る
async function sendLineMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
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
}

// Claudeに指示を処理させる
async function processCommand(userMessage) {
  const systemPrompt = `あなたはTCGVIBE.AIの監視エージェントです。
ユーザーからの指示を受け取り、以下のアクションを判断して実行します：

1. データ更新指示（「データ更新して」「価格取得して」など）
   → {"action": "update_prices", "message": "価格データの更新を開始します"}
   
2. サイト状態確認（「サイト確認して」「エラーある？」など）
   → {"action": "check_site", "message": "サイトの状態を確認します"}
   
3. 価格分析（「○○の価格は？」「高騰してるカードは？」など）
   → {"action": "analyze_prices", "target": "カード名や条件", "message": "価格分析を実行します"}

4. 一般的な質問や報告
   → {"action": "reply", "message": "返答内容"}

必ずJSONのみで返答してください。`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  const data = await response.json();
  const text = data.content[0].text;
  
  try {
    return JSON.parse(text);
  } catch {
    return { action: 'reply', message: text };
  }
}

// アクションを実行
async function executeAction(action, replyToken) {
  switch (action.action) {
    case 'update_prices':
      await sendLineMessage(replyToken, '⏳ 価格データの更新を開始します...\n完了したらお知らせします！');
      // GitHub Actionsをトリガーする処理をここに追加予定
      break;
      
    case 'check_site':
      try {
        const res = await fetch('https://tcgvibe.com/api/articles');
        const status = res.ok ? '✅ 正常に動作しています' : '⚠️ 問題が発生しています';
        await sendLineMessage(replyToken, `サイト状態確認結果:\n${status}\nステータスコード: ${res.status}`);
      } catch (e) {
        await sendLineMessage(replyToken, `❌ サイトに接続できません: ${e.message}`);
      }
      break;
      
    case 'analyze_prices':
      await sendLineMessage(replyToken, `🔍 ${action.target || '価格'}の分析を実行中...\n結果をお待ちください`);
      break;
      
    case 'reply':
    default:
      await sendLineMessage(replyToken, action.message || '処理しました');
      break;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'LINE Webhook is running' });
  }

  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  try {
    const body = JSON.stringify(req.body);
    
    // 署名検証
    const signature = req.headers['x-line-signature'];
    const hash = crypto
      .createHmac('SHA256', LINE_CHANNEL_SECRET)
      .update(body)
      .digest('base64');
    
    // if (signature !== hash) {
//   return res.status(401).json({ error: 'Invalid signature' });
// }

    const events = req.body.events || [];
    
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        
        console.log(`受信: ${userMessage}`);
        
        // Claudeで指示を解釈・実行
        const action = await processCommand(userMessage);
        await executeAction(action, replyToken);
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
