const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
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
    if (!res.ok) {
      const errText = await res.text();
      console.log(`supabasePost ${table} エラー:`, res.status, errText.substring(0, 200));
      return null;
    }
    const result = await res.json();
    console.log(`supabasePost ${table} 結果:`, Array.isArray(result) ? `配列[${result.length}] id=${result[0]?.id}` : typeof result);
    return result;
  } catch (e) {
    console.log(`supabasePost ${table} 例外:`, e.message);
    return null;
  }
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

// 診断情報を蓄積するグローバル配列
const diagnostics = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJSON(text) {
  // マークダウンコードブロック内のJSONを優先
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    const m = codeBlock[1].match(/\{[\s\S]*\}/);
    if (m) return m[0];
  }
  // 全てのJSONブロックを探して最長のものを返す（最も記事本体らしいもの）
  const matches = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) { matches.push(text.substring(start, i + 1)); start = -1; } }
  }
  // 最長のJSONブロックを返す
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

async function callClaude(system, userContent, maxTokens = 4096, useSearch = true) {
  try {
    const tools = useSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] : undefined;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        ...(tools && { tools }),
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      const msg = `Claude APIエラー: ${res.status} ${errText.substring(0, 300)}`;
      console.log(msg);
      diagnostics.push(msg);

      // 429の場合は60秒待ってweb_searchなしでリトライ
      if (res.status === 429) {
        console.log('レートリミット、60秒待機後リトライ');
        diagnostics.push('レートリミット、60秒待機後リトライ');
        await sleep(60000);
      }

      // web_searchなしでリトライ
      const res_retry = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL, max_tokens: maxTokens, system,
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      if (!res_retry.ok) {
        const errText2 = await res_retry.text();
        diagnostics.push(`リトライも失敗: ${res_retry.status} ${errText2.substring(0, 200)}`);
        return '';
      }
      const data_retry = await res_retry.json();
      const allText = data_retry.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      diagnostics.push(`リトライ成功 ${allText.length}文字`);
      return allText;
    }

    const data = await res.json();
    const blockTypes = data.content?.map(b => b.type) || [];
    console.log('Claude応答 stop_reason:', data.stop_reason, 'blocks:', blockTypes);
    diagnostics.push(`応答OK stop:${data.stop_reason} blocks:${blockTypes.join(',')}`);

    // 全テキストブロックを結合して返す
    const allText = data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
    if (allText) return allText;

    console.log('テキストブロックなし', JSON.stringify(data).substring(0, 300));
    diagnostics.push('テキストなし');
    return '';
  } catch (e) {
    diagnostics.push(`Claude例外: ${e.message}`);
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

  const match = extractJSON(text);
  if (match) {
    try {
      const result = JSON.parse(match);
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
    console.log('大会記事生成開始 topCards:', topCardsStr.length, '文字 crawlerData:', crawlerStr.length, '文字');
    const text = await callClaude(
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}
以下のJSON形式のみ返してください（マークダウンのコードブロックは使わないこと）：
{"title":"大会・環境系タイトル（具体的なカード名含む）","tag":"環境解説","game":"pokeca","summary":"100文字の要約","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr || 'データなし'}\n\n【最新情報】\n${crawlerStr || 'データなし'}\n\n今日(${new Date().toLocaleDateString('ja-JP')})の大会・環境記事を生成してください。web_searchで最新の大会結果や環境情報を検索してから記事を書いてください。`
    );
    console.log('大会記事Claude応答:', text.length, '文字', text.substring(0, 100));
    const match = extractJSON(text);
    // extractJSON returns a string or null
    if (match) {
      const article = JSON.parse(match);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '環境解説',
          summary: article.summary || '', game: article.game || 'pokeca', author: 'TCGVIBE AI',
          status: 'pending', approved: false, x_posted: false,
        });
        const savedId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
        console.log('大会記事保存 id:', savedId);
        results.tournament = { title: article.title, id: savedId || null, game: article.game || 'pokeca' };
        console.log('大会記事生成:', article.title);
      } else {
        console.log('大会記事タイトル不正:', article.title);
      }
    } else {
      console.log('大会記事JSONマッチ失敗 応答:', text.substring(0, 300));
    }
  } catch (e) { console.log('大会記事失敗:', e.message, e.stack); }

  // レートリミット回避のため60秒待機
  console.log('レートリミット回避: 60秒待機');
  await sleep(60000);

  // コレクター記事
  try {
    console.log('コレクター記事生成開始');
    const text = await callClaude(
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}
以下のJSON形式のみ返してください（マークダウンのコードブロックは使わないこと）：
{"title":"コレクター向けタイトル（具体的なカード名含む）","tag":"価格情報","game":"pokeca","summary":"100文字の要約","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr || 'データなし'}\n\n【最新情報】\n${crawlerStr || 'データなし'}\n\n今日(${new Date().toLocaleDateString('ja-JP')})のコレクター向け記事を生成してください。web_searchで最新のカード価格情報を検索してから記事を書いてください。`
    );
    console.log('コレクター記事Claude応答:', text.length, '文字', text.substring(0, 100));
    const match = extractJSON(text);
    // extractJSON returns a string or null
    if (match) {
      const article = JSON.parse(match);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '価格情報',
          summary: article.summary || '', game: article.game || 'pokeca', author: 'TCGVIBE AI',
          status: 'pending', approved: false, x_posted: false,
        });
        const savedId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
        console.log('コレクター記事保存 id:', savedId);
        results.collector = { title: article.title, id: savedId || null, game: article.game || 'pokeca' };
        console.log('コレクター記事生成:', article.title);
      } else {
        console.log('コレクター記事タイトル不正:', article.title);
      }
    } else {
      console.log('コレクター記事JSONマッチ失敗 応答:', text.substring(0, 300));
    }
  } catch (e) { console.log('コレクター記事失敗:', e.message, e.stack); }

  // レートリミット回避のため60秒待機
  console.log('レートリミット回避: 60秒待機');
  await sleep(60000);

  // ランキング
  try {
    const cardsStr = topCards.slice(0, 20).map((c, i) => `${i+1}. ${c.card_name} ${c.buy_price} (${c.rarity})`).join('\n');
    const text = await callClaude(
      `TCGVIBEランキング生成エージェントです。
以下のJSON形式のみ返してください（マークダウンのコードブロックは使わないこと）：
{"ranking":[{"rank":1,"card":"カード名","price":"価格","reason":"理由30文字","buy_recommend":true}],"summary":"200文字以内の解説","new_insight":"学んだこと"}`,
      `【買取価格データ】\n${cardsStr}\n\n【最新情報】\n${crawlerStr}\n\n今日のおすすめカードランキングTOP10を生成してください。`,
      4096,
      false  // ランキングはweb_search不要
    );
    const match = extractJSON(text);
    // extractJSON returns a string or null
    if (match) {
      const result = JSON.parse(match);
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

  // 承認コマンドを追加（idが取れない場合はDB最新を取得）
  if (results.tournament || results.collector) {
    let tournamentId = results.tournament?.id;
    let collectorId = results.collector?.id;

    // idが取れなかった場合、auto_articlesから最新のpending記事を取得
    if ((!tournamentId && results.tournament) || (!collectorId && results.collector)) {
      const pending = await supabaseGet('auto_articles', 'status=eq.pending&approved=eq.false&order=id.desc&limit=10');
      console.log('フォールバックpending取得:', Array.isArray(pending) ? pending.length + '件' : 'エラー', JSON.stringify(pending)?.substring(0, 300));
      if (Array.isArray(pending) && pending.length > 0) {
        for (const p of pending) {
          if (!tournamentId && results.tournament && p.title?.includes(results.tournament.title.substring(0, 15))) tournamentId = p.id;
          if (!collectorId && results.collector && p.title?.includes(results.collector.title.substring(0, 15))) collectorId = p.id;
        }
        // タイトルマッチも失敗なら最新2件を使う
        if (!tournamentId && results.tournament && pending[0]) tournamentId = pending[0].id;
        if (!collectorId && results.collector && pending[1]) collectorId = pending[1].id;
      }
    }

    if (tournamentId) report += `\n承認→「承認${tournamentId}」`;
    if (collectorId) report += `\n承認→「承認${collectorId}」`;
    if (!tournamentId && !collectorId) report += `\n※IDが取得できませんでした。管理画面から承認してください。`;
  }

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
        const a = articles[0];
        await supabasePost('tcg_articles', {
          title: a.title,
          content: a.content,
          tag: a.tag,
          emoji: a.emoji || '🃏',
          summary: a.summary || a.title,
          game: a.game || 'pokeca',
          author: a.author || 'TCGVIBE AI',
        });
      }
      return res.status(200).json({ status: 'approved', article_id });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'collect') {
    try {
      diagnostics.length = 0;
      const count = await runCollect();
      return res.status(200).json({ status: 'done', sites_collected: count, diagnostics });
    } catch (e) { return res.status(500).json({ error: e.message, diagnostics }); }
  }

  if (action === 'generate') {
    try {
      diagnostics.length = 0;
      const results = await runGenerate();
      return res.status(200).json({ status: 'done', results, diagnostics });
    } catch (e) { return res.status(500).json({ error: e.message, diagnostics }); }
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
