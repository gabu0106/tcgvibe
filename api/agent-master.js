const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const MODEL = 'claude-haiku-4-5-20251001';

// ===== ユーティリティ =====
async function supabaseGet(table, query = '') {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY }
    });
    return await res.json();
  } catch { return []; }
}

async function supabasePost(table, data) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    });
    return await res.json();
  } catch { return null; }
}

async function sendLine(message) {
  try {
    await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ messages: [{ type: 'text', text: message }] }),
    });
  } catch (e) { console.log('LINE送信失敗:', e.message); }
}

// ===== メモリ管理 =====
async function loadMemory(agentName) {
  try {
    const data = await supabaseGet('agent_memory', `agent_name=eq.${agentName}&order=importance.desc&limit=20`);
    return Array.isArray(data) ? data.map(m => m.content).join('\n') : '';
  } catch { return ''; }
}

async function saveMemory(agentName, content, importance = 5) {
  try {
    await supabasePost('agent_memory', { agent_name: agentName, memory_type: 'insight', content, importance });
  } catch {}
}

// ===== データ取得 =====
async function getTopCards() {
  try {
    const data = await supabaseGet('card_prices', 'select=card_name,buy_price,rarity,shop&limit=5000');
    if (!Array.isArray(data)) return [];
    return data
      .map(c => ({ ...c, price_num: parseInt((c.buy_price || '0').replace(/[^0-9]/g, '')) }))
      .filter(c => c.price_num > 0)
      .sort((a, b) => b.price_num - a.price_num)
      .slice(0, 20);
  } catch { return []; }
}

async function getTodayCrawlerData() {
  try {
    const today = new Date().toISOString().split('T')[0];
    return await supabaseGet('crawler_data', `crawled_at=gte.${today}&order=crawled_at.desc&limit=20`);
  } catch { return []; }
}

// ===== Claude呼び出し =====
async function callClaude(system, userContent) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const data = await res.json();

    if (data.content?.some(b => b.type === 'tool_use')) {
      const toolUse = data.content.find(b => b.type === 'tool_use');
      const res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 2000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
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
  } catch (e) {
    console.log('Claude呼び出し失敗:', e.message);
    return '';
  }
}

// ===== 情報収集 =====
async function collectInfo() {
  console.log('情報収集開始');
  const queries = ['ポケカ 高騰 最新', 'ポケモンカード 相場 今日', 'ワンピースカード 買取'];
  
  for (const query of queries) {
    try {
      const text = await callClaude(
        `TCG情報収集エージェントです。以下のJSONのみ返してください：
{"highlights":["注目情報1","注目情報2"],"high_price_cards":["カード名 価格円"],"summary":"200文字以内"}`,
        `「${query}」の最新情報を収集してください。今日:${new Date().toLocaleDateString('ja-JP')}`
      );
      
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        await supabasePost('crawler_data', {
          site_name: `web_search:${query}`,
          highlights: JSON.stringify(parsed.highlights || []),
          high_price_cards: JSON.stringify(parsed.high_price_cards || []),
          summary: parsed.summary || '',
          raw_data: JSON.stringify(parsed),
          crawled_at: new Date().toISOString(),
        });
        console.log(`収集完了: ${query}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.log(`収集失敗: ${query}`, e.message);
    }
  }
}

// ===== 記事生成 =====
async function generateArticle(type, topCards, crawlerData, memory) {
  const topCardsStr = topCards.slice(0, 10).map(c => `${c.card_name} ${c.buy_price}`).join('\n');
  const crawlerStr = crawlerData.map(d => d.summary).filter(Boolean).join('\n');

  const systemPrompt = type === 'tournament'
    ? `あなたはTCGVIBEの記事執筆エージェントです。大会・環境に関する記事を書きます。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"大会・環境系の記事タイトル","tag":"環境解説","emoji":"🏆","summary":"100文字の要約","content":"800文字以上の記事本文","new_insight":"学んだこと"}`
    : `あなたはTCGVIBEの記事執筆エージェントです。コレクター向けの記事を書きます。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"コレクター向けの記事タイトル","tag":"価格情報","emoji":"💎","summary":"100文字の要約","content":"800文字以上の記事本文","new_insight":"学んだこと"}`;

  const text = await callClaude(
    systemPrompt,
    `【高額カードTOP10】\n${topCardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日の記事を生成してください。今日:${new Date().toLocaleDateString('ja-JP')}`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const article = JSON.parse(match[0]);
      if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
      
      const saved = await supabasePost('auto_articles', {
        title: article.title || '本日のTCG情報',
        content: article.content || '',
        tag: article.tag || '価格情報',
        status: 'pending',
        approved: false,
        x_posted: false,
      });
      
      const articleId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
      console.log(`記事生成完了: ${article.title} (ID:${articleId})`);
      return { ...article, id: articleId };
    } catch (e) {
      console.log('記事JSONパース失敗:', e.message);
    }
  }
  return null;
}

// ===== ランキング生成 =====
async function generateRanking(topCards, memory) {
  const cardsStr = topCards.slice(0, 20).map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity})`).join('\n');
  
  const text = await callClaude(
    `TCGVIBEのランキング生成エージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"ranking":[{"rank":1,"card":"カード名","price":"価格","reason":"注目理由","buy_recommend":true}],"summary":"ランキング全体の解説200文字","new_insight":"学んだこと"}`,
    `【買取価格データ】\n${cardsStr}\n\n今日のおすすめカードランキングTOP10を生成してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      if (result.new_insight) await saveMemory('ranking', result.new_insight, 6);
      
      await supabasePost('crawler_data', {
        site_name: 'ranking',
        summary: result.summary || '',
        highlights: JSON.stringify(result.ranking?.map(r => `${r.rank}位 ${r.card} ${r.price}`) || []),
        high_price_cards: JSON.stringify(result.ranking?.map(r => `${r.card} ${r.price}`) || []),
        raw_data: JSON.stringify(result),
        crawled_at: new Date().toISOString(),
      });
      
      console.log('ランキング生成完了');
      return result;
    } catch (e) {
      console.log('ランキングJSONパース失敗:', e.message);
    }
  }
  return null;
}

// ===== メイン処理 =====
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Master agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, article_id } = req.body || {};

  // 記事承認処理
  if (action === 'approve' && article_id) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/auto_articles?id=eq.${article_id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true, status: 'approved' }),
      });

      const articles = await supabaseGet('auto_articles', `id=eq.${article_id}&select=*`);
      if (articles[0]) {
        await supabasePost('tcg_articles', {
          title: articles[0].title,
          content: articles[0].content,
          tag: articles[0].tag,
          emoji: '🃏',
          summary: articles[0].title,
          date: new Date().toLocaleDateString('ja-JP'),
        });
      }
      return res.status(200).json({ status: 'approved', article_id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // メイン自動実行
  console.log('🚀 エージェントシステム起動');
  const results = { collect: false, tournament_article: false, collector_article: false, ranking: false };

  try {
    // Step1: 情報収集（失敗しても続行）
    try {
      await collectInfo();
      results.collect = true;
    } catch (e) { console.log('情報収集失敗（続行）:', e.message); }

    // Step2: データ取得
    const [topCards, crawlerData, memory] = await Promise.all([
      getTopCards(),
      getTodayCrawlerData(),
      loadMemory('master'),
    ]);
    console.log(`データ取得: カード${topCards.length}件, クローラー${crawlerData.length}件`);

    // Step3: 大会・環境記事生成（失敗しても続行）
    let tournamentArticle = null;
    try {
      tournamentArticle = await generateArticle('tournament', topCards, crawlerData, memory);
      if (tournamentArticle) results.tournament_article = true;
    } catch (e) { console.log('大会記事生成失敗（続行）:', e.message); }

    // Step4: コレクター記事生成（失敗しても続行）
    let collectorArticle = null;
    try {
      collectorArticle = await generateArticle('collector', topCards, crawlerData, memory);
      if (collectorArticle) results.collector_article = true;
    } catch (e) { console.log('コレクター記事生成失敗（続行）:', e.message); }

    // Step5: ランキング生成（失敗しても続行）
    let ranking = null;
    try {
      ranking = await generateRanking(topCards, memory);
      if (ranking) results.ranking = true;
    } catch (e) { console.log('ランキング生成失敗（続行）:', e.message); }

    // Step6: 学習メモリ保存
    await saveMemory('master', `${new Date().toLocaleDateString('ja-JP')}処理完了 結果:${JSON.stringify(results)}`, 5);

    // Step7: LINEに日報送信
    let report = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n`;
    report += `✅ 情報収集: ${results.collect ? '成功' : '失敗'}\n`;
    report += `✅ 大会記事: ${tournamentArticle ? `「${tournamentArticle.title}」生成` : '失敗'}\n`;
    report += `✅ コレクター記事: ${collectorArticle ? `「${collectorArticle.title}」生成` : '失敗'}\n`;
    report += `✅ ランキング: ${ranking ? '生成完了' : '失敗'}\n`;

    if (tournamentArticle?.id) report += `\n📝 大会記事承認→「承認${tournamentArticle.id}」`;
    if (collectorArticle?.id) report += `\n📝 コレクター記事承認→「承認${collectorArticle.id}」`;

    await sendLine(report);
    console.log('日報送信完了');

    return res.status(200).json({ status: 'done', results });
  } catch (e) {
    console.error('致命的エラー:', e.message);
    await sendLine(`⚠️ エージェントエラー: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
