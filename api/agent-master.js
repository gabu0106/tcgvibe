const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const MODEL = 'claude-haiku-4-5-20251001';

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

async function supabasePatch(table, query, data) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  } catch {}
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

async function getDiscoveredSites() {
  try {
    const data = await supabaseGet('discovered_sites', 
      'order=quality_score.desc,last_updated.desc&limit=20&active=eq.true'
    );
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function saveSite(url, name, category, qualityScore, updateFrequency) {
  try {
    // URLが既に存在するか確認
    const existing = await supabaseGet('discovered_sites', `url=eq.${encodeURIComponent(url)}`);
    if (Array.isArray(existing) && existing.length > 0) {
      // 既存サイトのスコアを更新
      await supabasePatch('discovered_sites', `url=eq.${encodeURIComponent(url)}`, {
        quality_score: Math.min(10, (existing[0].quality_score || 5) + 1),
        last_updated: new Date().toISOString(),
        last_crawled: new Date().toISOString(),
        success_count: (existing[0].success_count || 0) + 1,
        update_frequency: updateFrequency,
      });
    } else {
      // 新規サイトを追加
      await supabasePost('discovered_sites', {
        url,
        name,
        category,
        quality_score: qualityScore,
        update_frequency: updateFrequency,
        last_updated: new Date().toISOString(),
        last_crawled: new Date().toISOString(),
        success_count: 1,
        fail_count: 0,
      });
      console.log(`新サイト発見・記録: ${name} (${url})`);
    }
  } catch (e) { console.log('サイト保存失敗:', e.message); }
}

async function callClaude(system, userContent, maxTokens = 2000) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
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
          model: MODEL, max_tokens: maxTokens,
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

async function collectAndLearn(memory, knownSites) {
  console.log('自由探索型情報収集開始');
  
  const knownSitesStr = knownSites.map(s => `${s.name}(${s.url}) 品質:${s.quality_score} 更新頻度:${s.update_frequency}`).join('\n');
  
  const text = await callClaude(
    `あなたはTCGVIBE情報収集エージェントです。
過去の学習：${memory || 'なし'}

既知の優良サイト：
${knownSitesStr || 'なし（初回探索）'}

web_searchを使って自由にTCG情報を収集してください。
既知サイトも確認しつつ、新しい情報源も積極的に探してください。
情報の鮮度を最優先にしてください。

以下のJSONのみ返してください：
{
  "collected": [
    {
      "site_name": "サイト名",
      "url": "URL",
      "category": "価格情報 or 環境情報 or 大会情報 or コレクター",
      "quality_score": 8,
      "update_frequency": "毎日 or 週数回 or 週1 or 不定期",
      "last_updated": "今日 or 昨日 or 数日前",
      "highlights": ["具体的な情報1", "情報2"],
      "high_price_cards": ["カード名 価格円"],
      "summary": "150文字以内のサマリー"
    }
  ],
  "new_insight": "学んだこと"
}`,
    `今日(${new Date().toLocaleDateString('ja-JP')})のポケカ・ワンピースカードの最新情報を収集してください。
高騰カード・買取価格・大会結果・新弾情報など幅広く調査し、情報源のURLも記録してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      
      // 各サイトを学習・保存
      for (const site of (result.collected || [])) {
        if (site.url && site.site_name) {
          await saveSite(
            site.url,
            site.site_name,
            site.category,
            site.quality_score || 5,
            site.update_frequency || '不定期'
          );
          
          // crawler_dataに保存
          await supabasePost('crawler_data', {
            site_name: site.site_name,
            highlights: JSON.stringify(site.highlights || []),
            high_price_cards: JSON.stringify(site.high_price_cards || []),
            summary: site.summary || '',
            raw_data: JSON.stringify(site),
            crawled_at: new Date().toISOString(),
          });
        }
      }

      if (result.new_insight) await saveMemory('collector', result.new_insight, 7);
      console.log(`情報収集完了: ${result.collected?.length || 0}サイト`);
      return result.collected || [];
    } catch (e) {
      console.log('収集結果パース失敗:', e.message);
    }
  }
  return [];
}

async function generateArticle(type, topCards, crawlerData, memory) {
  const topCardsStr = topCards.slice(0, 10).map(c => `${c.card_name} ${c.buy_price}`).join('\n');
  const crawlerStr = crawlerData.slice(0, 5).map(d => d.summary).filter(Boolean).join('\n');

  const isTourn = type === 'tournament';
  const text = await callClaude(
    `あなたはTCGVIBEの記事執筆エージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{
  "title": "${isTourn ? '大会・環境系' : 'コレクター向け'}の記事タイトル（具体的なカード名含む）",
  "tag": "${isTourn ? '環境解説' : '価格情報'}",
  "emoji": "${isTourn ? '🏆' : '💎'}",
  "summary": "100文字の要約",
  "content": "800文字以上の記事本文（具体的なカード名・価格・理由含む）",
  "new_insight": "学んだこと"
}`,
    `【高額カードTOP10】\n${topCardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日(${new Date().toLocaleDateString('ja-JP')})の${isTourn ? '大会・環境' : 'コレクター向け'}記事を生成してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const article = JSON.parse(match[0]);
      if (!article.title || article.title.includes('タイトル')) return null;
      if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
      
      const saved = await supabasePost('auto_articles', {
        title: article.title,
        content: article.content || '',
        tag: article.tag || '価格情報',
        status: 'pending',
        approved: false,
        x_posted: false,
      });
      
      const articleId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
      console.log(`記事生成: ${article.title} (ID:${articleId})`);
      return { ...article, id: articleId };
    } catch (e) { console.log('記事パース失敗:', e.message); }
  }
  return null;
}

async function generateRanking(topCards, crawlerData, memory) {
  const cardsStr = topCards.slice(0, 20).map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity})`).join('\n');
  const infoStr = crawlerData.slice(0, 3).map(d => d.summary).filter(Boolean).join('\n');
  
  const text = await callClaude(
    `TCGVIBEのランキング生成エージェントです。
過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{
  "ranking": [
    {"rank": 1, "card": "カード名", "price": "価格", "reason": "注目理由30文字", "buy_recommend": true}
  ],
  "summary": "200文字以内のランキング解説",
  "new_insight": "学んだこと"
}`,
    `【買取価格データ】\n${cardsStr}\n\n【最新市場情報】\n${infoStr}\n\n今日のおすすめカードランキングTOP10を生成してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      if (result.new_insight) await saveMemory('ranking', result.new_insight, 6);
      
      await supabasePost('crawler_data', {
        site_name: 'daily_ranking',
        summary: result.summary || '',
        highlights: JSON.stringify(result.ranking?.map(r => `${r.rank}位 ${r.card} ${r.price}`) || []),
        high_price_cards: JSON.stringify(result.ranking?.map(r => `${r.card} ${r.price}`) || []),
        raw_data: JSON.stringify(result),
        crawled_at: new Date().toISOString(),
      });
      
      console.log('ランキング生成完了');
      return result;
    } catch (e) { console.log('ランキングパース失敗:', e.message); }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'Master agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, article_id } = req.body || {};

  if (action === 'approve' && article_id) {
    try {
      await supabasePatch('auto_articles', `id=eq.${article_id}`, { approved: true, status: 'approved' });
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

  console.log('🚀 エージェントシステム起動');
  const results = { collect: false, sites_learned: 0, tournament_article: false, collector_article: false, ranking: false };

  try {
    const [memory, knownSites, topCards] = await Promise.all([
      loadMemory('master'),
      getDiscoveredSites(),
      getTopCards(),
    ]);

    console.log(`既知サイト: ${knownSites.length}件, カードデータ: ${topCards.length}件`);

    // Step1: 自由探索型情報収集
    let collectedData = [];
    try {
      collectedData = await collectAndLearn(memory, knownSites);
      results.collect = true;
      results.sites_learned = collectedData.length;
    } catch (e) { console.log('収集失敗（続行）:', e.message); }

    const crawlerData = await supabaseGet('crawler_data', 
      `crawled_at=gte.${new Date().toISOString().split('T')[0]}&order=crawled_at.desc&limit=20`
    );

    // Step2: 大会記事生成
    let tournamentArticle = null;
    try {
      tournamentArticle = await generateArticle('tournament', topCards, crawlerData, memory);
      if (tournamentArticle) results.tournament_article = true;
    } catch (e) { console.log('大会記事失敗（続行）:', e.message); }

    // Step3: コレクター記事生成
    let collectorArticle = null;
    try {
      collectorArticle = await generateArticle('collector', topCards, crawlerData, memory);
      if (collectorArticle) results.collector_article = true;
    } catch (e) { console.log('コレクター記事失敗（続行）:', e.message); }

    // Step4: ランキング生成
    let ranking = null;
    try {
      ranking = await generateRanking(topCards, crawlerData, memory);
      if (ranking) results.ranking = true;
    } catch (e) { console.log('ランキング失敗（続行）:', e.message); }

    await saveMemory('master', `${new Date().toLocaleDateString('ja-JP')}処理完了 新規サイト:${results.sites_learned}件`, 5);

    // LINE日報
    let report = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n`;
    report += `🔍 情報収集: ${results.collect ? `${results.sites_learned}サイト発見・学習` : '失敗'}\n`;
    report += `📊 既知サイト: ${knownSites.length}件\n`;
    report += `🏆 大会記事: ${tournamentArticle ? `「${tournamentArticle.title}」` : '生成失敗'}\n`;
    report += `💎 コレクター記事: ${collectorArticle ? `「${collectorArticle.title}」` : '生成失敗'}\n`;
    report += `📈 ランキング: ${ranking ? '生成完了' : '生成失敗'}\n`;

    if (tournamentArticle?.id) report += `\n承認→「承認${tournamentArticle.id}」`;
    if (collectorArticle?.id) report += `\n承認→「承認${collectorArticle.id}」`;

    await sendLine(report);

    return res.status(200).json({ status: 'done', results });
  } catch (e) {
    console.error('致命的エラー:', e.message);
    await sendLine(`⚠️ エラー: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
