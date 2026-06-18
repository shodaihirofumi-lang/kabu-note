// 株ノート用 株価プロキシ（Cloudflare Worker）
// Yahoo Finance を中継し、CORS を付けて返すだけの薄いプロキシ。
// 無料枠（1日10万リクエスト）で動作。株データは一切保存しない。
//
// 使い方:
//   GET ?s=7203.T,6758.T,AAPL          → 現在値一括取得
//   GET ?chart=7203.T&interval=1d      → 日足 OHLC（3ヶ月）
//   GET ?chart=7203.T&interval=1wk     → 週足 OHLC（1年）

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // チャートデータ
    const chartSym = (url.searchParams.get('chart') || '').trim();
    if (chartSym) {
      const interval = url.searchParams.get('interval') || '1d';
      const range = interval === '1wk' ? '1y' : '3mo';
      try {
        const candles = await fetchCandles(chartSym, interval, range);
        return json({ updated: new Date().toISOString(), symbol: chartSym, interval, candles }, 200, {
          ...cors,
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500, cors);
      }
    }

    // 現在値一括取得
    const s = (url.searchParams.get('s') || '').trim();
    if (!s) {
      return json({ usage: '?s=SYMBOL1,SYMBOL2 or ?chart=SYMBOL&interval=1d|1wk' }, 200, cors);
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
    name: m.shortName || m.longName || null,
    date: m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10)
      : null,
  };
}

async function fetchCandles(sym, interval, range) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const r = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res) throw new Error('no data');
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  return ts
    .map((t, i) => ({
      t: new Date(t * 1000).toISOString().slice(0, 10),
      o: q.open ? +q.open[i].toFixed(2) : null,
      h: q.high ? +q.high[i].toFixed(2) : null,
      l: q.low ? +q.low[i].toFixed(2) : null,
      c: q.close ? +q.close[i].toFixed(2) : null,
    }))
    .filter((x) => x.c != null);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
