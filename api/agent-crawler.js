name: TCG Crawler

on:
  schedule:
    - cron: '0 21 * * *'
  workflow_dispatch:

jobs:
  crawl-cardrush-pokemon:
    runs-on: ubuntu-latest
    steps:
      - name: カードラッシュ_ポケカ
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"cardrush_pokemon"}'

  crawl-cardrush-op:
    runs-on: ubuntu-latest
    steps:
      - name: カードラッシュ_ワンピース
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"cardrush_op"}'

  crawl-raftel:
    runs-on: ubuntu-latest
    steps:
      - name: トレカラフテル
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"raftel"}'

  crawl-onehappy:
    runs-on: ubuntu-latest
    steps:
      - name: ワンハッピー
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"onehappy"}'

  crawl-torecacamp:
    runs-on: ubuntu-latest
    steps:
      - name: トレカキャンプ
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"torecacamp"}'

  crawl-hareruya:
    runs-on: ubuntu-latest
    steps:
      - name: 晴れるや2
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"hareruya"}'

  crawl-torechart-pokemon:
    runs-on: ubuntu-latest
    steps:
      - name: トレチャ_ポケカ
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"torechart_pokemon"}'

  crawl-torechart-op:
    runs-on: ubuntu-latest
    steps:
      - name: トレチャ_ワンピース
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"torechart_op"}'

  crawl-note:
    runs-on: ubuntu-latest
    steps:
      - name: note_PROS
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"note_pros"}'

  crawl-snkrdunk:
    runs-on: ubuntu-latest
    steps:
      - name: スニーカーダンク
        run: curl -X POST https://tcgvibe.com/api/agent-crawler -H "Content-Type: application/json" -d '{"site":"snkrdunk"}'

  collect-x:
    runs-on: ubuntu-latest
    steps:
      - name: X収集
        run: curl -X POST https://tcgvibe.com/api/agent-x-collector -H "Content-Type: application/json" -d '{}'
