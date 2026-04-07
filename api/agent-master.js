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
      const msg = `supabasePost ${table} エラー: ${res.status} ${errText.substring(0, 200)}`;
      console.log(msg);
      diagnostics.push(msg);
      return null;
    }
    const result = await res.json();
    const msg = `supabasePost ${table}: ${Array.isArray(result) ? `[${result.length}] id=${result[0]?.id}` : JSON.stringify(result).substring(0, 100)}`;
    console.log(msg);
    diagnostics.push(msg);
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

// ===== 学習システム =====

// 承認・却下された記事の統計を取得
async function getApprovalStats(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [approved, rejected] = await Promise.all([
    supabaseGet('auto_articles', `status=eq.approved&created_at=gte.${since}&order=created_at.desc&limit=50`),
    supabaseGet('auto_articles', `status=eq.rejected&created_at=gte.${since}&order=created_at.desc&limit=50`),
  ]);
  return {
    approved: Array.isArray(approved) ? approved : [],
    rejected: Array.isArray(rejected) ? rejected : [],
  };
}

// 承認された記事からパターンを抽出してプロンプトに埋め込むための文字列を生成
async function buildLearningContext() {
  const stats = await getApprovalStats(14);
  const parts = [];

  if (stats.approved.length > 0) {
    const titles = stats.approved.slice(0, 5).map(a => `「${a.title}」(${a.tag})`).join('、');
    const avgLen = Math.round(stats.approved.reduce((s, a) => s + (a.content?.length || 0), 0) / stats.approved.length);
    const tags = {};
    stats.approved.forEach(a => { tags[a.tag] = (tags[a.tag] || 0) + 1; });
    const topTag = Object.entries(tags).sort((a, b) => b[1] - a[1])[0];
    parts.push(`【承認実績(${stats.approved.length}件)】好評タイトル例: ${titles}。平均文字数: ${avgLen}文字。最も承認率が高いタグ: ${topTag ? topTag[0] : '不明'}`);
  }

  if (stats.rejected.length > 0) {
    const reasons = stats.rejected
      .filter(a => a.reject_reason)
      .slice(0, 5)
      .map(a => a.reject_reason);
    const rejTitles = stats.rejected.slice(0, 3).map(a => `「${a.title}」`).join('、');
    parts.push(`【却下された記事(${stats.rejected.length}件)】例: ${rejTitles}。${reasons.length ? '理由: ' + reasons.join('、') : '具体的な改善ポイント: タイトルの具体性、情報の正確性、文字数不足に注意'}`);
  }

  const approveRate = stats.approved.length + stats.rejected.length > 0
    ? Math.round(stats.approved.length / (stats.approved.length + stats.rejected.length) * 100)
    : 0;
  if (approveRate > 0) {
    parts.push(`【承認率: ${approveRate}%】${approveRate >= 70 ? '良好。現在のスタイルを維持。' : '改善必要。承認された記事のパターンに寄せること。'}`);
  }

  return parts.join('\n');
}

// 学習サイクル: 承認・却下パターンを分析してメモリに蓄積
async function runLearningCycle() {
  console.log('学習サイクル開始');
  const stats = await getApprovalStats(14);

  if (stats.approved.length === 0 && stats.rejected.length === 0) {
    console.log('学習対象データなし');
    return { status: 'no_data' };
  }

  // Claudeに承認/却下パターンを分析させる
  const approvedSamples = stats.approved.slice(0, 5).map(a => ({
    title: a.title, tag: a.tag, content_length: a.content?.length || 0,
    content_preview: (a.content || '').substring(0, 200),
  }));
  const rejectedSamples = stats.rejected.slice(0, 5).map(a => ({
    title: a.title, tag: a.tag, content_length: a.content?.length || 0,
    content_preview: (a.content || '').substring(0, 200),
    reject_reason: a.reject_reason || '理由なし',
  }));

  const analysisText = await callClaude(
    `あなたはTCGVIBE記事品質分析エージェントです。承認された記事と却下された記事を比較して、品質改善の具体的なルールを抽出してください。
以下のJSON形式のみ返してください：
{
  "approved_patterns": ["承認された記事の共通パターン1", "パターン2"],
  "rejected_patterns": ["却下された記事の共通問題1", "問題2"],
  "improvement_rules": ["具体的改善ルール1", "ルール2", "ルール3"],
  "title_guidelines": "良いタイトルの特徴",
  "content_guidelines": "良い本文の特徴",
  "quality_score": 0-100の現在の品質スコア
}`,
    `【承認された記事(${stats.approved.length}件)】\n${JSON.stringify(approvedSamples, null, 1)}\n\n【却下された記事(${stats.rejected.length}件)】\n${JSON.stringify(rejectedSamples, null, 1)}\n\n上記を分析して品質改善ルールを抽出してください。`,
    4096,
    false
  );

  const match = extractJSON(analysisText);
  if (!match) {
    console.log('学習分析パース失敗');
    return { status: 'parse_error' };
  }

  const analysis = JSON.parse(match);

  // 学習結果をメモリに保存（高重要度）
  const learningContent = [
    `[学習レポート ${new Date().toLocaleDateString('ja-JP')}]`,
    `承認率: ${Math.round(stats.approved.length / (stats.approved.length + stats.rejected.length) * 100)}%`,
    `承認パターン: ${(analysis.approved_patterns || []).join('、')}`,
    `却下理由: ${(analysis.rejected_patterns || []).join('、')}`,
    `改善ルール: ${(analysis.improvement_rules || []).join('、')}`,
    `タイトル指針: ${analysis.title_guidelines || ''}`,
    `本文指針: ${analysis.content_guidelines || ''}`,
  ].join('\n');

  // 古い学習レポートを低重要度に下げるため、新しいものを高重要度で保存
  await saveMemory('writer', learningContent, 9);
  await saveMemory('learning', learningContent, 9);

  console.log('学習サイクル完了 品質スコア:', analysis.quality_score);
  return {
    status: 'completed',
    approved_count: stats.approved.length,
    rejected_count: stats.rejected.length,
    quality_score: analysis.quality_score,
    improvement_rules: analysis.improvement_rules,
  };
}

// discovered_sitesの品質スコアを記事承認実績ベースで更新
async function updateSiteQualityScores() {
  console.log('サイト品質スコア更新開始');

  // 過去14日の承認された記事が参照したcrawler_dataを分析
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const [approved, rejected, recentCrawls, sites] = await Promise.all([
    supabaseGet('auto_articles', `status=eq.approved&created_at=gte.${since}&select=created_at`),
    supabaseGet('auto_articles', `status=eq.rejected&created_at=gte.${since}&select=created_at`),
    supabaseGet('crawler_data', `crawled_at=gte.${since}&select=site_name,crawled_at`),
    supabaseGet('discovered_sites', 'select=*&limit=100'),
  ]);

  if (!Array.isArray(sites) || sites.length === 0) return { status: 'no_sites' };

  // 各サイトの情報提供日と記事承認日を照合してスコアを計算
  const approvedDates = new Set((Array.isArray(approved) ? approved : []).map(a => a.created_at?.split('T')[0]));
  const rejectedDates = new Set((Array.isArray(rejected) ? rejected : []).map(a => a.created_at?.split('T')[0]));

  const siteContributions = {};
  if (Array.isArray(recentCrawls)) {
    for (const crawl of recentCrawls) {
      const date = crawl.crawled_at?.split('T')[0];
      const name = crawl.site_name;
      if (!name || name === 'daily_ranking') continue;
      if (!siteContributions[name]) siteContributions[name] = { approved: 0, rejected: 0, total: 0 };
      siteContributions[name].total++;
      if (approvedDates.has(date)) siteContributions[name].approved++;
      if (rejectedDates.has(date)) siteContributions[name].rejected++;
    }
  }

  // スコア更新
  let updated = 0;
  for (const site of sites) {
    const contrib = siteContributions[site.name];
    if (!contrib || contrib.total === 0) continue;

    const approvalRate = contrib.approved / contrib.total;
    // 承認率が高いサイトはスコアアップ、低いサイトはダウン
    let newScore = site.quality_score || 5;
    if (approvalRate >= 0.7) newScore = Math.min(10, newScore + 1);
    else if (approvalRate <= 0.3 && contrib.rejected > 0) newScore = Math.max(1, newScore - 1);

    if (newScore !== (site.quality_score || 5)) {
      await supabasePatch('discovered_sites', `id=eq.${site.id}`, { quality_score: newScore });
      updated++;
    }
  }

  console.log(`サイト品質更新: ${updated}件`);
  return { status: 'completed', sites_evaluated: sites.length, sites_updated: updated };
}

// ===== メインエージェント関数 =====

async function runCollect() {
  console.log('情報収集開始');
  const memory = await loadMemory('collector');
  const knownSites = await supabaseGet('discovered_sites', 'order=quality_score.desc&limit=10');
  const knownStr = Array.isArray(knownSites) ? knownSites.map(s => `${s.name}(${s.url}) Q:${s.quality_score}`).join('\n') : '';

  const text = await callClaude(
    `あなたはTCGVIBE情報収集エージェントです。
過去の学習：${memory || 'なし'}
既知の優良サイト：${knownStr || 'なし'}
web_searchで自由にTCG情報を収集してください。
品質スコアが高いサイトを優先的に参照してください。
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
  const [topCards, memory, learningContext] = await Promise.all([
    getTopCards(),
    loadMemory('writer'),
    buildLearningContext(),
  ]);
  const today = new Date().toISOString().split('T')[0];
  const crawlerData = await supabaseGet('crawler_data', `crawled_at=gte.${today}&order=crawled_at.desc&limit=10`);
  const crawlerStr = Array.isArray(crawlerData) ? crawlerData.map(d => d.summary).filter(Boolean).join('\n') : '';
  const topCardsStr = topCards.slice(0, 10).map(c => `${c.card_name} ${c.buy_price}`).join('\n');

  // 学習コンテキストを組み込んだシステムプロンプトの共通部分
  const learningBlock = learningContext ? `\n\n===学習データ（承認・却下の実績分析）===\n${learningContext}\n上記の傾向を踏まえて、承認されやすい記事を生成してください。` : '';

  const results = { tournament: null, collector: null, ranking: null };

  // 大会記事
  try {
    console.log('大会記事生成開始 topCards:', topCardsStr.length, '文字 crawlerData:', crawlerStr.length, '文字');
    const text = await callClaude(
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}${learningBlock}
以下のJSON形式のみ返してください（マークダウンのコードブロックは使わないこと）：
{"title":"大会・環境系タイトル（具体的なカード名含む）","tag":"環境解説","game":"pokeca","summary":"100文字の要約","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr || 'データなし'}\n\n【最新情報】\n${crawlerStr || 'データなし'}\n\n今日(${new Date().toLocaleDateString('ja-JP')})の大会・環境記事を生成してください。web_searchで最新の大会結果や環境情報を検索してから記事を書いてください。`
    );
    console.log('大会記事Claude応答:', text.length, '文字', text.substring(0, 100));
    const match = extractJSON(text);
    if (match) {
      const article = JSON.parse(match);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '環境解説',
          status: 'pending', approved: false,
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
      `TCGVIBEの記事執筆エージェントです。過去の学習：${memory || 'なし'}${learningBlock}
以下のJSON形式のみ返してください（マークダウンのコードブロックは使わないこと）：
{"title":"コレクター向けタイトル（具体的なカード名含む）","tag":"価格情報","game":"pokeca","summary":"100文字の要約","content":"800文字以上の本文","new_insight":"学んだこと"}`,
      `【高額カードTOP10】\n${topCardsStr || 'データなし'}\n\n【最新情報】\n${crawlerStr || 'データなし'}\n\n今日(${new Date().toLocaleDateString('ja-JP')})のコレクター向け記事を生成してください。web_searchで最新のカード価格情報を検索してから記事を書いてください。`
    );
    console.log('コレクター記事Claude応答:', text.length, '文字', text.substring(0, 100));
    const match = extractJSON(text);
    if (match) {
      const article = JSON.parse(match);
      if (article.title && !article.title.includes('タイトル')) {
        if (article.new_insight) await saveMemory('writer', article.new_insight, 6);
        const saved = await supabasePost('auto_articles', {
          title: article.title, content: article.content || '', tag: article.tag || '価格情報',
          status: 'pending', approved: false,
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

  // 日次学習記録を保存
  const genRecord = `[生成記録 ${new Date().toLocaleDateString('ja-JP')}] 大会:${results.tournament ? '成功' : '失敗'} コレクター:${results.collector ? '成功' : '失敗'} ランキング:${results.ranking ? '成功' : '失敗'}`;
  await saveMemory('daily_log', genRecord, 3);

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
  // CORS制限
  const origin = req.headers.origin || '';
  if (['https://tcgvibe.com','https://www.tcgvibe.com'].includes(origin) || origin.includes('localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Master agent ready' });
  if (req.method !== 'POST') return res.status(405).end();

  const { action, article_id, reject_reason } = req.body || {};

  // 内部APIキー認証（collect/generate/learn等のバッチ処理）
  const internalActions = ['collect', 'generate', 'learn'];
  if (internalActions.includes(action) || !action) {
    const key = req.headers['x-api-key'] || req.body?.api_key;
    if (!key || key !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (action === 'send_line_alert') {
    const msg = req.body?.message;
    if (msg) await sendLine(msg);
    return res.status(200).json({ status: 'sent' });
  }

  if (action === 'list_pending') {
    try {
      const pending = await supabaseGet('auto_articles', 'status=eq.pending&approved=eq.false&order=id.desc&limit=50');
      return res.status(200).json({ articles: Array.isArray(pending) ? pending : [] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'reject' && article_id) {
    try {
      const patchData = { status: 'rejected' };
      if (reject_reason) patchData.reject_reason = reject_reason;
      await supabasePatch('auto_articles', `id=eq.${article_id}`, patchData);
      // 却下理由を学習メモリに記録
      if (reject_reason) {
        await saveMemory('writer', `[却下フィードバック] ID:${article_id} 理由: ${reject_reason}`, 8);
      }
      return res.status(200).json({ status: 'rejected', article_id });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

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
        // 承認された記事のパターンを学習メモリに記録
        await saveMemory('writer', `[承認済] タイトル:「${a.title}」 タグ:${a.tag} 文字数:${(a.content||'').length}`, 7);
      }
      return res.status(200).json({ status: 'approved', article_id });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // --- Oripa layout learning ---
  if (action === 'oripa_save_layout') {
    try {
      const layout = req.body?.layout;
      if (!layout) return res.status(400).json({ error: 'layout required' });
      await saveMemory('oripa_designer',
        `[承認済レイアウト] items:${layout.itemCount} theme:${layout.theme} config:${JSON.stringify(layout)}`,
        7);
      return res.status(200).json({ status: 'saved' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'oripa_get_patterns') {
    try {
      const raw = await loadMemory('oripa_designer');
      const patterns = [];
      if (typeof raw === 'string') {
        // Parse each memory line for layout configs
        for (const line of raw.split('\n')) {
          const m = line.match(/config:(\{.+\})$/);
          if (m) {
            try { patterns.push(JSON.parse(m[1])); } catch {}
          }
        }
      }
      return res.status(200).json({ patterns });
    } catch (e) { return res.status(200).json({ patterns: [] }); }
  }

  if (action === 'learn') {
    try {
      diagnostics.length = 0;
      const [learningResult, siteResult] = await Promise.all([
        runLearningCycle(),
        updateSiteQualityScores(),
      ]);
      return res.status(200).json({ status: 'done', learning: learningResult, sites: siteResult, diagnostics });
    } catch (e) { return res.status(500).json({ error: e.message, diagnostics }); }
  }

  if (action === 'learning_stats') {
    try {
      const stats = await getApprovalStats(14);
      const memory = await loadMemory('learning');
      const writerMemory = await loadMemory('writer');
      return res.status(200).json({
        approved_count: stats.approved.length,
        rejected_count: stats.rejected.length,
        approval_rate: stats.approved.length + stats.rejected.length > 0
          ? Math.round(stats.approved.length / (stats.approved.length + stats.rejected.length) * 100) : 0,
        learning_memory: memory,
        writer_memory: writerMemory,
      });
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
