// tickers.json の銘柄について Yahoo Finance から終値/最新値を取得し
// docs/prices.json に書き出す。GitHub Actions から1日1回実行する想定。
// 依存ゼロ（Node 18+ のグローバル fetch を使用）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TICKERS = path.join(ROOT, 'tickers.json');
const OUT = path.join(ROOT, 'docs', 'prices.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 4桁数字コードは東証(.T)。それ以外(AAPL等)はそのまま米国等として扱う。
function toSymbol(code) {
  return /^\d{4}$/.test(code) ? `${code}.T` : code;
}

async function fetchOne(code) {
  const sym = toSymbol(code);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error('no price');
  return {
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency ?? null,
    date: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10)
      : null,
  };
}

(async () => {
  const tickers = JSON.parse(fs.readFileSync(TICKERS, 'utf8'));
  const prices = {};
  let ok = 0, ng = 0;

  for (const code of tickers) {
    try {
      prices[code] = await fetchOne(code);
      ok++;
    } catch (e) {
      ng++;
      console.error('skip', code, e.message);
    }
    await sleep(250); // Yahoo へ優しく
  }

  const out = {
    updated: new Date().toISOString(),
    source: 'Yahoo Finance（終値/遅延・参考値）',
    count: ok,
    prices,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`done: ok=${ok} ng=${ng} -> ${OUT}`);
})();
