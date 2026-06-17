# 株ノート 📈

株の売買記録と銘柄メモを残せるWebアプリ。売買理由・振り返りを記録し、実現損益・含み損益・勝率を自動計算します。

- **公開URL（スマホ対応）**: https://shodaihirofumi-lang.github.io/kabu-note/
- データはブラウザ（端末）内のlocalStorageに保存。サーバー不要・無料・常時稼働。
- JSON/CSVでバックアップ・復元できます。

## 使い方

スマホ・PCのブラウザで上記URLを開くだけ。ホーム画面に追加すればアプリのように使えます。

## 株価の自動取得

- **主要約78銘柄**（`tickers.json`）は、GitHub Actions が毎営業日16時（JST）に終値を取得し
  `docs/prices.json` を更新します。設定不要・無料。
- **全銘柄**を自動取得したい場合は、自分の無料 **Cloudflare Worker** を中継として設定します（下記）。

### 全銘柄対応：Cloudflare Worker のセットアップ（約3分・無料）

1. https://dash.cloudflare.com にアクセスし、無料アカウントを作成（クレジットカード不要）。
2. 左メニュー **Workers & Pages** → **Create** → **Workers** → **Create Worker**。
3. 名前を `kabu-price` などにして **Deploy**。
4. **Edit code** を開き、中身を全消去して [`worker/price-worker.js`](worker/price-worker.js) の内容を貼り付け → **Deploy**。
5. 表示された URL（例 `https://kabu-price.xxxx.workers.dev`）をコピー。
6. アプリの **銘柄メモ → 株価の取得設定** に貼り付けて **保存** →（任意で **接続テスト**）。

これで保有している全銘柄の株価（終値/遅延・参考値）が自動で入り、含み損益が計算されます。
※ 設定は端末ごと（localStorage）。別端末では「⬇保存」した JSON を「⬆復元」すれば引き継げます。

## ローカル開発

```bash
node server.js   # http://localhost:3100
```

## 構成

- `docs/` … 公開する静的ファイル（GitHub Pagesの配信元）
  - `index.html` / `style.css` / `app.js` / `manifest.json` / `icon.svg` / `prices.json`
- `tickers.json` … 自動取得する主要銘柄リスト
- `scripts/fetch-prices.js` … 終値を取得して `docs/prices.json` を作る
- `.github/workflows/update-prices.yml` … 毎営業日に上記を実行
- `worker/price-worker.js` … 全銘柄対応用 Cloudflare Worker（任意・無料）
- `server.js` … ローカルプレビュー用のゼロ依存静的サーバー
