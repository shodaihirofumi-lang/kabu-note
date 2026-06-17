# 株ノート 📈

株の売買記録と銘柄メモを残せるWebアプリ。売買理由・振り返りを記録し、実現損益・含み損益・勝率を自動計算します。

- **公開URL（スマホ対応）**: https://shodaihirofumi-lang.github.io/kabu-note/
- データはブラウザ（端末）内のlocalStorageに保存。サーバー不要・無料・常時稼働。
- JSON/CSVでバックアップ・復元できます。

## 使い方

スマホ・PCのブラウザで上記URLを開くだけ。ホーム画面に追加すればアプリのように使えます。

## ローカル開発

```bash
node server.js   # http://localhost:3100
```

## 構成

- `docs/` … 公開する静的ファイル（GitHub Pagesの配信元）
  - `index.html` / `style.css` / `app.js` / `manifest.json` / `icon.svg`
- `server.js` … ローカルプレビュー用のゼロ依存静的サーバー
