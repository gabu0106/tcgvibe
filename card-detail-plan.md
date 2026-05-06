# カード詳細ページ Phase 1 調査レポート

**作成日**: 2026-05-06
**目的**: 1枚ごとに全情報（画像/テキスト/エキスパンション/番号/価格）を表示する単独ページの実装計画
**スコープ**: 調査と設計のみ（実装は Phase 2）

---

## 1. Supabaseテーブル構造

### マスター系（カード本体）

| テーブル | 用途 | 主要カラム | データ供給元 |
|---|---|---|---|
| `card_prices` | カード価格マスター（最頻出9箇所） | `card_name`, `buy_price`, `sell_price`(※注), `rarity`, `pack_name`, `model_number`, `shop`, `game` | カードラッシュ daily スクレイプ |
| `card_images` | カード画像メタ | `card_id`, `card_name`, `game`, `set_id`, `set_name`, `number`, `rarity`, `image_small`, `image_large` | TCGdex (ja) / punk-records (One Piece) 週次同期 |
| `card_sets` | パック/セット定義 | `set_id`, `set_name`, `release_date`, `total_cards`, `logo_url`, `symbol_url`, `game` | TCGdex / punk-records 週次同期 |

**⚠️ 重要な実装ハック**: `card_prices.sell_price` には画像URL（`https://files.cardrush.media/...`）が格納されている。これは `api/card-images.js` の `toCard()` で参照される現状の暗黙仕様。

### 価格・履歴系

| テーブル | 用途 | 主要カラム |
|---|---|---|
| `psa_prices` | PSA10鑑定済みカード相場 | `card_name`, `game`, `ebay_price`, `ebay_count`, `estimated_price`, `source`, `updated_at` |
| `price_history` | 買取価格の時系列推移 | `card_name`, `price`, `shop`, `recorded_at` |

### 記事・コンテンツ系

| テーブル | 用途 | 主要カラム |
|---|---|---|
| `tcg_articles` | 公開済み記事 | `id`, `game`, `tag`, `title`, `summary`, `content`, `emoji`, `author`, `author_x`, `published_at` |
| `auto_articles` | AI生成記事の承認待ちプール | `id`, `title`, `content`, `tag`, `status`, `approved`, `reject_reason`, `emoji`, `summary`, `game`, `author` |
| `tcg_meta` | TCG環境情報スナップショット | `game`, `category`, `title`, `content`, `collected_at` |

### エージェント・運用系

| テーブル | 用途 |
|---|---|
| `crawler_data` | クロール結果キャッシュ |
| `discovered_sites` | 情報源サイトの品質スコア管理 |
| `chat_history` | LINE Bot 会話履歴 |
| `agent_memory` | エージェントの学習メモリ |
| `settings` | サイト設定（公開状態・対応ゲーム・AIプロンプト等） |

---

## 2. カード1枚あたりに取得できる情報の棚卸し

| 情報項目 | 現状 | 取得元 | 備考 |
|---|---|---|---|
| カード名（日本語） | ✅ | `card_prices.card_name` + `card_images.card_name` | 重複保持 |
| カード番号 | ✅ | `card_prices.model_number` + `card_images.number` | フォーマット差異あり要マージ |
| エキスパンション/パック名 | ✅ | `card_prices.pack_name` + `card_images.set_name` + `card_sets.set_name` | |
| レアリティ | ✅ | `card_prices.rarity` / `card_images.rarity` | |
| 画像URL（カードラッシュ） | ✅ | `card_prices.sell_price`（ハック） | CORS対策で `api/card-images?action=proxy` 経由 |
| 画像URL（TCGdex/punk高画質） | ✅ | `card_images.image_large` | `https://assets.tcgdex.net/...` |
| 買取価格 | ✅ | `card_prices.buy_price` | カードラッシュのみ |
| 販売価格 | ❌ | （`sell_price`カラムは画像URL用に流用中） | 別ショップ追加すれば可 |
| eBay海外相場 | ✅ | `api/ebay.js` 動的取得 | 50件サンプル平均 |
| PSA10相場 | ✅ | `psa_prices.estimated_price` | eBay PSA10検索ベース |
| 価格推移 | ✅ | `price_history` | 14日分くらい蓄積 |
| 発売日 | ✅ | `card_sets.release_date` | |
| パックロゴ画像 | ✅ | `card_sets.logo_url` | |
| **HP** | ❌ | TCGdexから取得可能、**未保存** | sync時に破棄してる |
| **タイプ** | ❌ | TCGdex `types[]`、**未保存** | |
| **進化段階 (stage)** | ❌ | TCGdex `stage`、**未保存** | |
| **進化元** | ❌ | TCGdex `evolveFrom`、**未保存** | |
| **特性 (abilities)** | ❌ | TCGdex `abilities`、**未保存** | |
| **技 (attacks)** | ❌ | TCGdex `attacks` (cost/name/damage/effect)、**未保存** | 日本語効果テキスト含む |
| **弱点・抵抗・逃げる** | ❌ | TCGdex `weaknesses` `resistances` `retreat`、**未保存** | |
| **イラストレーター** | ❌ | TCGdex `illustrator`、**未保存** | |
| **レギュレーションマーク** | ❌ | TCGdex `regulationMark`（F/G/H 等）、**未保存** | |
| **大会レギュレーション (legal)** | ❌ | TCGdex `legal.standard/expanded`、**未保存** | |
| **flavor text** | △ | TCGdex 一部のみ（カードによる） | |
| **全国図鑑番号** | △ | TCGdex `dexId[]`、**未保存** | |

**⚡ ボトルネック発見**: TCGdex API は既に詳細データを返しているのに、`card-sync.js` の `syncPokemonCardsWithRarity()` は `name/number/rarity/image_small/image_large` の **5フィールドだけ抽出**して残りを破棄している。これを拡張すれば追加API不要で完全データが得られる。

---

## 3. GitHub Actions 自動化ジョブの整理

### `.github/workflows/card-sync.yml` — 週次（日曜 12:00 UTC）

| Step | アクション | データフロー | 書き込み先テーブル |
|---|---|---|---|
| sync-pokemon-sets | `POST /api/card-sync action=sync_pokemon_sets` | TCGdex `/sets` → セット定義 | `card_sets` |
| sync-pokemon-cards | `POST /api/card-sync action=sync_pokemon_cards set_limit=10` | TCGdex `/sets/{id}` + `/cards/{id}` 個別取得 | `card_images` |
| sync-onepiece | `sync_onepiece_sets` → `sync_onepiece_cards` | punk-records GitHub Raw JSON | `card_sets`, `card_images` |

### `.github/workflows/crawler.yml` — 毎日（21:00 UTC）

| Step | アクション | データフロー | 書き込み先テーブル |
|---|---|---|---|
| step1-collect | `agent-master action=collect` | 情報源クロール → discovered_sites 品質更新 | `crawler_data`, `discovered_sites` |
| step2-generate | `agent-master action=generate` | クロール結果から記事生成 | `auto_articles` |
| step3-prices |  |  |  |
| ┣ scrape-buyprices | `price-updater action=scrape_buyprices card_limit=10` | カードラッシュ買取ページスクレイプ | `card_prices` |
| ┣ record-history | `price-updater action=record_history` | `card_prices` → 履歴スナップショット | `price_history` |
| ┣ update-psa10 | `price-updater action=update_psa10 card_limit=5 ×3` | eBay PSA10検索 | `psa_prices` |
| ┗ detect-surges | `price-updater action=detect_surges` | 価格高騰検知 → LINE通知 | （通知のみ） |
| step4-learn | `agent-master action=learn` | 承認/却下パターン学習 | `agent_memory` |
| notify-failure | LINE Bot失敗通知 | 上記いずれか失敗時 | （通知のみ） |

**運用上の注意**:
- `card_limit=10` などの上限は無料枠タイムアウト回避のため小さく設定済み
- TCGdex は `await sleep(1000)` でレート配慮
- 全失敗パスに `|| true` で後続ジョブを止めない設計

---

## 4. pokemontcg.io API との比較

### 結論: **TCGdex (既存) で十分。pokemontcg.io導入不要。**

| フィールド | TCGdex (ja) | pokemontcg.io |
|---|---|---|
| 日本語カード名 | ✅ | ❌（英語のみ） |
| 日本語効果テキスト | ✅ | ❌ |
| 日本語パック名 | ✅ | ❌ |
| HP / types / attacks | ✅ | ✅ |
| illustrator | ✅ | ✅ |
| regulationMark | ✅ | ✅ |
| rarity | ✅ | ✅ |
| 画像（高解像度） | ✅ `assets.tcgdex.net` | ✅ |
| TCGplayer USD相場 | ❌ | ✅ |
| Cardmarket EUR相場 | ❌ | ✅ |
| 発売日 | △（sets/{id}のみ） | ✅ |
| flavor text | △（一部） | ✅ |
| 国内買取/販売 | ❌ | ❌ |

### TCGdex無料枠（公開API・キー不要）
- レート制限: 公開上限値の明示なし。経験的に `sleep(500-1000ms)` で安定
- 制約: ブランドカード（TCGdexで未登録のセット）には穴あり

### pokemontcg.io無料枠（参考）
- 1000 req/day（キーなし）/ 20000 req/day（無料キー登録）
- 30 req/分制限
- 利点: TCGplayer USD価格（公式）

### 判断
- **日本人ユーザー向け**サイトなので日本語データが最重要 → TCGdex一択
- USD相場は既存 `api/ebay.js` で海外相場を取得しており代替可能
- pokemontcg.io追加はメンテ複雑化のデメリットが上回る

---

## 5. URL とテーブル設計の提案

### URL構造

| 候補 | URL | メリット | デメリット |
|---|---|---|---|
| A | `/card/{set_id}/{number}` 例: `/card/SV2a/001` | SEOクリーン、共有しやすい | Vercel rewrites設定要 |
| B | `/card-detail.html?id={card_id}` 例: `?id=SV2a-001` | 静的HTMLで即動く、Vercel設定不要 | URLが長い、SEO弱い |
| C | A + B のハイブリッド | 両方の長所 | 設定がやや複雑 |

### **推奨: 候補C（ハイブリッド）**
1. 内部実装は `card-detail.html?id=SV2a-001`（既存スタックで動く）
2. `vercel.json` の `rewrites` で `/card/:set/:number` → `/card-detail.html?id=:set-:number` をマッピング
3. canonical URL は `/card/{set_id}/{number}` を使用（SEO最適化）
4. 内部リンクからは `/card/SV2a/001` を使い、共有時もキレイなURL

```json
// vercel.json 追加例
{
  "rewrites": [
    { "source": "/card/:set/:number", "destination": "/card-detail.html?id=:set-:number" }
  ]
}
```

### 新規テーブル `cards` の設計案

責務分離のため `card_images` を拡張せず**新規テーブル**を推奨。

```sql
CREATE TABLE cards (
  card_id text PRIMARY KEY,            -- 'SV2a-001'
  game text NOT NULL,                  -- 'pokeca' | 'onepiece'
  card_name text NOT NULL,             -- 日本語名
  set_id text NOT NULL,                -- 'SV2a'
  set_name text,                       -- 'ポケモンカード151'（冗長保持・高速化）
  number text,                         -- '001'
  category text,                       -- 'Pokemon' | 'Trainer' | 'Energy'
  rarity text,                         -- 'Common' | 'SAR' | 'UR' 等

  -- ポケモン固有
  hp integer,
  types text[],                        -- ['Grass', 'Fire']
  stage text,                          -- 'Basic' | 'Stage1' | 'Stage2'
  evolves_from text,
  attacks jsonb,                       -- [{cost,name,damage,effect}]
  abilities jsonb,                     -- [{type,name,effect}]
  weaknesses jsonb,                    -- [{type,value}]
  resistances jsonb,
  retreat integer,
  dex_id integer[],

  -- メタ情報
  illustrator text,
  regulation_mark text,                -- 'F' | 'G' | 'H'
  legal_standard boolean,
  legal_expanded boolean,
  flavor_text text,

  -- 画像
  image_small text,
  image_large text,

  -- 同期管理
  source text DEFAULT 'tcgdex',        -- 'tcgdex' | 'punk-records'
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX cards_game_set ON cards(game, set_id);
CREATE INDEX cards_name ON cards(card_name);
CREATE INDEX cards_set_number ON cards(set_id, number);
CREATE INDEX cards_rarity ON cards(game, rarity);
```

### 既存テーブルとのリレーション

```
cards (card_id PK)
  ├─ card_id ⇔ card_images.card_id        (同期キー、card_images は廃止候補)
  ├─ set_id ⇔ card_sets.set_id            (パック情報JOIN)
  ├─ card_name + number ⇔ card_prices     (価格JOIN — 完全一致でない場合あり、要正規化)
  ├─ card_name ⇔ psa_prices.card_name     (PSA10 JOIN)
  └─ card_name ⇔ price_history.card_name  (価格推移JOIN)
```

**注意**: `card_prices.model_number` と `cards.number` のフォーマット揺れ（"001/108" vs "001"）に対するマッチングロジック実装要。

---

## 6. Phase 2 実装タスク見積もり

### タスク分解と所要時間

| # | タスク | 所要 | 難易度 |
|---|---|---|---|
| 1 | Supabase で `cards` テーブル作成（DDL実行） | 30分 | 低 |
| 2 | `api/card-sync.js` 拡張：TCGdex全フィールドを `cards` に保存 | 2.0h | 中 |
| 3 | ワンピース punk-records からの同様マッピング | 1.5h | 中 |
| 4 | 全ポケカセット（〜100セット）の段階的同期ワークフロー調整 | 1.0h | 低 |
| 5 | 新規API `/api/card?id={card_id}` 詳細取得＋価格JOIN | 1.5h | 中 |
| 6 | `public/card-detail.html` 新規作成（画像・全情報・価格・推移） | 4.0h | 中 |
| 7 | `card-list.html` モーダル → カード詳細遷移リンク追加 | 0.5h | 低 |
| 8 | SEO（OGP・schema.org Product・canonical・パンくず） | 1.0h | 低 |
| 9 | `vercel.json` rewrites 追加（`/card/[set]/[num]`） | 0.5h | 低 |
| 10 | 既存価格テーブル「LINE通知」ボタン → 詳細ページ遷移にも対応 | 0.5h | 低 |

**合計: 約 12.5 時間（実働1.5〜2日）**

### Phase 2 完了基準
- [ ] 任意のポケカ・ワンピースカードの詳細ページが `/card/{set}/{num}` で開ける
- [ ] HP・技・特性・弱点・イラストレーター・レギュ全表示
- [ ] 買取価格・eBay相場・PSA10相場・14日価格推移が同ページで見れる
- [ ] OGP対応（X/LINEシェア時にカード画像が出る）
- [ ] 既存機能（記事・チャット・カード一覧）が壊れていない

---

## 7. Phase 3 さらに先のロードマップ（参考）

| タスク | 所要 | 価値 |
|---|---|---|
| 価格推移グラフ (Chart.js) | 2h | 中（スニダン的な可視化） |
| 関連カード推薦（同イラストレーター・同セット） | 3h | 中 |
| 高度カード検索（HP範囲・タイプ・効果テキスト全文） | 3h | 高 |
| カード比較ページ（最大3枚並べる） | 4h | 中 |
| お気に入り登録（localStorage） | 2h | 高（再訪率↑） |
| 価格アラート登録（LINE通知連動） | 5h | 高（差別化） |

**Phase 3 合計: 約 19 時間**

---

## 8. リスクとボトルネック

### データ品質
- `card_prices.model_number` と `cards.number` のフォーマット差異 → 正規化関数が必要
- カードラッシュにあって TCGdex に無いカード（プロモ等）は詳細ページが空白になる → fallback UI設計要
- ワンピース punk-records は更新頻度がポケカ TCGdex より低い → カバレッジ確認要

### パフォーマンス
- ポケカ全セット同期は約100セット × 平均200枚 = 20000カード。一度に同期するとTCGdex側に負荷
- → Phase 2 タスク4 で「offset/setLimit」を活かして週次で5〜10セットずつ進める運用を推奨
- Vercel API のタイムアウトは関数ごとに `vercel.json` で設定済み（card-sync 60s, agent-master 300s）

### Supabase 無料枠
- 現状の使用量を確認してから新規テーブル追加（cardsで〜20MB増を想定）
- Storage よりも Row 数より egress（API呼び出し）が制約になりやすい
- → 詳細ページに `Cache-Control: public, max-age=3600` 等のCDNキャッシュを設定すべき

---

## 9. Phase 2 開始前のチェックリスト

- [ ] LINE Bot ID を `@tcgvibe` プレースホルダから実IDに置換（`index.html` / `card-list.html` 各1箇所）
- [ ] Supabase の現状ストレージ使用量確認（cards テーブル追加余地あるか）
- [ ] TCGdex API の連続リクエストでレート制限を踏まないか手動検証（`/sets` → `/cards/{id}` × 200 程度）
- [ ] `card_prices ↔ cards` のマッチング正規化ルール仕様化（`SV2a-001` ↔ `001/198 [SV2a]` など）

---

## 参考リンク

- TCGdex API: https://api.tcgdex.net/v2/ja/
- TCGdex GitHub: https://github.com/tcgdex/cards-database
- punk-records: https://github.com/buhbbl/punk-records
- pokemontcg.io: https://pokemontcg.io（採用しないが参考）
- カードラッシュ: https://www.cardrush.jp（買取価格スクレイプ元）
