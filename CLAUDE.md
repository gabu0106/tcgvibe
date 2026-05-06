# TCGVIBE.AI 作業ログ - 2026年5月6日

## 今日達成したこと

### AIバックエンドのGemini化（コスト$0化）
- chat.js: Anthropic → Gemini 2.5 Flash-Lite
- admin.js: Anthropic → Gemini 2.5 Flash-Lite
- 環境変数 GEMINI_API_KEY 設定済み
- ANTHROPIC_API_KEY は残してあるが未使用（削除候補）

### バグ修正
- isAdmin未定義バグ（ReferenceError）修正
- sessionStorage → localStorage 変更（タブ間共有対応）

### UI全面リニューアル
- admin.html: プレミアム・リフレッシュ（案D）
  - モバイル対応、ダークモード、CTAブロック、承認待ちバッジ強化
- index.html: メディアファースト + 下部タブ（案①）
  - 上部ナビ刷新、グローバル検索、ヒーロー刷新
- card-list.html: デザイン言語統一
- LINE導線実装（フッターCTA + 価格テーブル各行ボタン）

### カード詳細ページ Phase 1 完了
- 詳細は card-detail-plan.md 参照（315行）
- ポケカ + ワンピ対象で進める方針確定
- TCGdex API継続採用、pokemontcg.io不要

## 明日以降のTODO

### 短期（直近）
- [ ] LINE Bot ID プレースホルダ置換（@tcgvibe → 実ID）
  - 対象: index.html と card-list.html の2箇所
- [ ] AIチャット精度改善（chat.jsのシステムプロンプト強化）
  - 文脈理解、google_search積極活用、レアリティ柔軟解釈

### 中期（1〜2週間）
- [ ] カード詳細ページ Phase 2 実装（card-detail-plan.md 参照）
  - cards テーブル作成
  - card-sync.js 拡張
  - ワンピ対応
  - /api/card エンドポイント
  - card-detail.html 作成
  - SEO対応
  - 推定12.5時間

### 長期
- [ ] AIチャット一般公開（レート制限・スパム対策実装後）
- [ ] card_prices.sell_price ハック整理（画像URLが流用格納されてる）
- [ ] カード詳細ページ Phase 3（価格推移グラフ、関連カード推薦等、約19時間）

## 環境変数の状況（Vercel設定済み）
- GEMINI_API_KEY: Sensitive
- ANTHROPIC_API_KEY: 残ってるが未使用
- ADMIN_KEY: 管理者ログイン用
- SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
- EBAY_APP_ID / EBAY_CERT_ID
- LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
- X_BEARER_TOKEN
- INTERNAL_API_KEY

## 今日のコミット
- e6f8a74 feat: admin.js もGeminiに移行
- 251d1ba fix: isAdmin未定義バグを修正
- c3046b4 fix: ナビのAIチャットボタン表示判定をlocalStorageに変更
- 2abbc8b feat: 管理画面UIをプレミアム・リフレッシュ（案D）
- 599c2d4 一般サイトUI 全面刷新
- f7cdf32 docs: カード詳細ページ Phase 1 調査レポート追加

---

## 今後のロードマップ（自分用メモ）

### 構想中の大プロジェクト

#### 1. TCG相場 YouTube チャンネル
- 既存のずんだもんYouTubeをTCG専門に転換
- 動画自動生成パイプライン
  - tcgvibe.comのDB → 高騰カードTOP情報取得
  - Claude/Gemini で台本生成
  - VOICEVOX/ずんだもんで音声合成
  - 動画編集（FFmpeg）
  - YouTube Data API で自動投稿
- 動画概要欄から tcgvibe.com への誘導
- 過去の課金事故を踏まえて、無料スタック中心で設計

#### 2. データソースの拡張
- 現在：カードラッシュメディア
- 追加候補：
  - スニダン（取引価格、PSA10相場）
  - 駿河屋（買取価格）
  - DMMマイカ（買取価格）
  - 磯一番街（在庫情報）
- 法的注意点：
  - 各サイトの利用規約・robots.txt 確認必須
  - 公式API or RSS があれば優先
  - スクレイピングの場合はレート制限・User-Agent設定
- 技術注意点：
  - Cloudflare等のbot対策をどう回避するか
  - ScraperAPI / Bright Data 等の利用検討

### 着手順序の提案
1. Phase 2（カード詳細ページ実装）← 今の最優先
2. AIチャット精度改善（システムプロンプト強化）
3. データソース拡張（駿河屋から開始、技術的に楽）
4. YouTube連携（大プロジェクトなので最後）

### 重要な学び（過去の事故から）
- AI APIの自動リトライは絶対禁止（残高マイナスの原因）
- 1日のAPI呼び出し上限を必ず実装
- スクレイピングはサイトごとに規約確認
