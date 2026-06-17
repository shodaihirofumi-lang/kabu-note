// 株ノート用 株価プロキシ（Cloudflare Worker）
// Yahoo Finance を中継し、CORS を付けて返すだけの薄いプロキシ。
// 無料枠（1日10万リクエスト）で動作。株データは一切保存しない。
//
// 使い方:
//   GET https://<your-worker>.workers.dev/?s=7203.T,6758.T,AAPL
//   → { "updated": "...", "prices": { "7203.T": {price,prevClose,currency,date}, ... } }
//
// デプロイ手順は README.md またはチャットの案内を参照。

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const s = (url.searchParams.get('s') || '').trim();
    if (!s) {
      return json({ usage: '?s=SYMBOL1,SYMBOL2 (例: 7203.T,6758.T,AAPL)' }, 200, cors);
    }

    const symbols = s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100);
    const prices = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          prices[sym] = await fetchQuote(sym);
        } catch (e) {
          prices[sym] = { error: String((e && e.message) || e) };
        }
      })
    );

    return json({ updated: new Date().toISOString(), prices }, 200, {
      ...cors,
      'Cache-Control': 'public, max-age=300',
    });
  },
};

async function fetchQuote(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
  const r = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no price');
  return {
    price: m.regularMarketPrice,
    prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
    currency: m.currency ?? null,
    date: m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10)
      : null,
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
