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

async function callClaude(system, userContent, maxTokens = 1500) {
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
    console.log('Claude失敗:', e.message);
    return '';
  }
}

async function runCollect() {
  console.log('情報収集開始');
  const memory = await loadMemory('collector');
  const knownSites = await supabaseGet('discovered_sites', 'order=quality_score.desc&limit=10');
  const knownStr = Array.isArray(knownSites) ? knownSites.map(s => `${s.name}(${s.url})`).join('\n') : '';

  const text = await callClaude(
    `あなたはTCGVIBE情報収集エージェントです。
過去の学習：${memory || 'なし'}
既知の優良サイト：${knownStr || 'なし'}
web_searchで自由にTCG情報を収集してください。
以下のJSONのみ返してください：
{
  "collected": [
    {
      "site_name": "サイト名",
      "url": "URL",
      "category": "価格情報 or 環境情報 or 大会情報",
      "quality_score": 7,
      "update_frequency": "毎日",
      "highlights": ["具体的な情報1", "情報2"],
      "high_price_cards": ["カード名 価格円"],
      "summary": "150文字以内のサマリー"
    }
  ],
  "new_insight": "学んだこと"
}`,
    `今日(${new Date().toLocaleDateString('ja-JP')})のポケカ・ワンピースカードの最新情報を収集してください。`
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      for (const site of (result.collected || [])) {
        if (site.url && site.site_name) {
          await supabasePost('crawler_data', {
            site_name: site.site_name,
            highlights: JSON.stringify(site.highlights || []),
            high_price_cards: JSON.stringify(site.high_price_cards || []),
            summary: site.summary || '',
            raw_data: JSON.stringify(site),
            crawled_at: new Date().toISOString(),
          });
          const existing = await supabaseGet('discovered_sites', `url=eq.${encodeURIComponent(site.url)}`);
          if (Array.isArray(existing) && existing.length > 0) {
            await supabasePatch('discovered_sites', `url=eq.${encodeURIComponent(site.url)}`, {
              quality_score: Math.min(10, (existing[0].quality_score || 5) + 1),
              last_crawled: new Date().toISOString(),
              success_count: (existing[0].success_count || 0) + 1,
            });
          } else {
            await supabasePost('discovered_sites', {
              url: site.url, name: site.site_name, category: site.category,
              quality_score: site.quality_score || 5,
              update_frequency: site.update_frequency || '不定期',
              last_crawled: new Date().toISOString(),
              success_count: 1, fail_count: 0,
            });
            console.log('新サイト発見:', site.site_name);
          }
        }
      }
      if (result.new_insight) await saveMemory('collector', result.new_insight, 7);
      console.log('収集完了:', result.collected?.length, 'サイト');
      return result.collected?.length || 0;
    } catch (e) { console.log('収集パース失敗:', e.message); }
  }
  return 0;
}

async function runGenerate() {
  console.log('記事・ランキング生成開始');
  const [topCards, memory] = await Promise.all([getTopCards(), loadMemory('writer')]);
  const today = new Date().toISOString().split('T')[0];
  const crawlerData = await supabaseGet('crawler_data', `crawled_at=gte.${today}&order=crawled_at.desc&limit=10`);
  const crawlerStr = Array.isArray(crawlerData) ? crawlerData.map(d => d.summary).filter(Boolean).join('\n') : '';
  const topCardsStr = topCards.slice(0, 10).map(c => `${c.card_name} ${c.buy_price}`).join('\n');

  const results = { tournament: null, collector: null, ranking: null };

  // 大会記事
  try {
    const text = await callClaude(
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"大会・環境系タイトル（具体的なカード名含む）","tag":"環境解説","emoji":"🏆","summary":"100文字","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日(${new Date().toLocaleDateString('ja-JP')})の大会・環境記事を生成してください。`
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const article = JSON.parse(match[0]);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '環境解説',
          status: 'pending', approved: false, x_posted: false,
        });
        results.tournament = { title: article.title, id: Array.isArray(saved) ? saved[0]?.id : saved?.id };
        console.log('大会記事生成:', article.title);
      }
    }
  } catch (e) { console.log('大会記事失敗:', e.message); }

  // コレクター記事
  try {
    const text = await callClaude(
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}
以下のJSONのみ返してください：
{"title":"コレクター向けタイトル（具体的なカード名含む）","tag":"価格情報","emoji":"💎","summary":"100文字","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日(${new Date().toLocaleDateString('ja-JP')})のコレクター向け記事を生成してください。`
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const article = JSON.parse(match[0]);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '価格情報',
          status: 'pending', approved: false, x_posted: false,
        });
        results.collector = { title: article.title, id: Array.isArray(saved) ? saved[0]?.id : saved?.id };
        console.log('コレクター記事生成:', article.title);
      }
    }
  } catch (e) { console.log('コレクター記事失敗:', e.message); }

  // ランキング
  try {
    const cardsStr = topCards.slice(0, 20).map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity})`).join('\n');
    const text = await callClaude(
      `TCGVIBEランキング生成エージェントです。
以下のJSONのみ返してください：
{"ranking":[{"rank":1,"card":"カード名","price":"価格","reason":"理由30文字","buy_recommend":true}],"summary":"200文字以内の解説","new_insight":"学んだこと"}`,
      `【買取価格データ】\n${cardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日のおすすめカードランキングTOP10を生成してください。`
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
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
      results.ranking = result.summary;
      console.log('ランキング生成完了');
    }
  } catch (e) { console.log('ランキング失敗:', e.message); }

  // LINE日報
  let report = `🌅 TCGVIBEデイリーレポート\n${new Date().toLocaleDateString('ja-JP')}\n\n`;
  report += `🏆 大会記事: ${results.tournament ? `「${results.tournament.title}」` : '生成失敗'}\n`;
  report += `💎 コレクター記事: ${results.collector ? `「${results.collector.title}」` : '生成失敗'}\n`;
  report += `📈 ランキング: ${results.ranking ? '生成完了' : '生成失敗'}\n`;
  if (results.tournament?.id) report += `\n承認→「承認${results.tournament.id}」`;
  if (results.collector?.id) report += `\n承認→「承認${results.collector.id}」`;

  await sendLine(report);
  await saveMemory('master', `${new Date().toLocaleDateString('ja-JP')}生成完了`, 5);
  console.log('日報送信完了');
  return results;
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
          title: articles[0].title, content: articles[0].content,
          tag: articles[0].tag, emoji: '🃏',
          summary: articles[0].title,
          date: new Date().toLocaleDateString('ja-JP'),
        });
      }
      return res.status(200).json({ status: 'approved', article_id });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'collect') {
    try {
      const count = await runCollect();
      return res.status(200).json({ status: 'done', sites_collected: count });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'generate') {
    try {
      const results = await runGenerate();
      return res.status(200).json({ status: 'done', results });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  try {
    await runCollect();
    const results = await runGenerate();
    return res.status(200).json({ status: 'done', results });
  } catch (e) {
    await sendLine(`⚠️ エラー: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
