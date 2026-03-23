export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // フォールバック記事を返す（APIを呼ばない）
  return res.status(200).json({
    articles: [
      { title: 'ポケカ最新環境まとめ', tag: '環境解説', summary: '現在の環境トップデッキを解説します', emoji: '🃏', date: new Date().toLocaleDateString('ja-JP') },
      { title: '今週の注目高騰カード', tag: '価格情報', summary: '今週値上がりが予想されるカードを紹介', emoji: '📈', date: new Date().toLocaleDateString('ja-JP') },
      { title: '最新大会結果レポート', tag: '大会レポート', summary: '直近の大会優勝デッキを分析', emoji: '🏆', date: new Date().toLocaleDateString('ja-JP') },
    ]
  });
}
