/* ===== 株ノート - データ層 ===== */
const KEY = 'kabu-note-db';

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.trades)) return d;
  } catch (e) {}
  return { trades: [], memos: {}, proxy: '' };
}
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
let db = load();

let autoPrices = {};      // prices.json から読み込む自動株価（終値・主要銘柄）
let pricesUpdated = null; // 自動株価の最終更新時刻(ISO)
let livePrices = {};      // Cloudflare Worker から取得した株価（全銘柄対応）
let _autoPricesReady = null; // prices.json 読み込み完了を待つ Promise

/* ===== ユーティリティ ===== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const fmt = n => new Intl.NumberFormat('ja-JP').format(Math.round(n || 0));
const yen = n => '¥' + fmt(n);
const signed = n => (n >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(n));
const pnlCls = n => (n > 0 ? 'profit' : n < 0 ? 'loss' : 'muted');

function parseTags(str) {
  return [...new Set(String(str || '').split(/[,、\s]+/).map(s => s.trim()).filter(Boolean))];
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

/* ===== 集計（平均取得単価法） ===== */
function byDateAsc(a, b) {
  return a.date === b.date ? a.createdAt - b.createdAt : (a.date < b.date ? -1 : 1);
}
function tickerStats(ticker) {
  const ts = db.trades.filter(t => t.ticker === ticker).sort(byDateAsc);
  let qty = 0, cost = 0, realized = 0, sells = 0, wins = 0;
  for (const t of ts) {
    const q = Number(t.qty) || 0, p = Number(t.price) || 0, fee = Number(t.fee) || 0;
    if (t.side === 'buy') {
      qty += q; cost += p * q + fee;
    } else {
      const avg = qty > 0 ? cost / qty : 0;
      const sold = Math.min(q, qty);
      const pnl = (p - avg) * sold - fee;
      realized += pnl; sells++; if (pnl > 0) wins++;
      cost -= avg * sold; qty -= sold;
      if (qty <= 0) { qty = 0; cost = 0; }
    }
  }
  return { qty, avgCost: qty > 0 ? cost / qty : 0, realized, sells, wins };
}
function allTickers() {
  const set = new Set(Object.keys(db.memos));
  db.trades.forEach(t => set.add(t.ticker));
  return [...set].sort();
}

// 有効な現在値: 手動入力 > Worker(全銘柄) > prices.json(主要銘柄)
function effPrice(ticker, m) {
  m = m || db.memos[ticker] || {};
  if (m.currentPrice != null && m.currentPrice !== '') {
    return { price: Number(m.currentPrice), source: 'manual', date: null };
  }
  const live = livePrices[ticker];
  if (live && live.price != null) return { price: Number(live.price), source: 'auto', date: live.date };
  const a = autoPrices[ticker];
  if (a && a.price != null) return { price: Number(a.price), source: 'auto', date: a.date };
  return { price: null, source: null, date: null };
}

// 銘柄コード → Yahooシンボル（4桁数字は東証 .T、それ以外はそのまま）
function toSymbol(code) {
  return /^\d{4}$/.test(code) ? code + '.T' : code;
}

/* ===== ダッシュボード ===== */
function renderDashboard() {
  let realized = 0, sells = 0, wins = 0, holdings = 0, unreal = 0, hasCur = false;
  for (const tk of allTickers()) {
    const s = tickerStats(tk);
    realized += s.realized; sells += s.sells; wins += s.wins;
    if (s.qty > 0) {
      holdings++;
      const ep = effPrice(tk);
      if (ep.price != null) { hasCur = true; unreal += (ep.price - s.avgCost) * s.qty; }
    }
  }
  const winRate = sells > 0 ? Math.round(wins / sells * 100) : null;

  $('#statGrid').innerHTML = `
    <div class="stat-card">
      <div class="label">実現損益</div>
      <div class="value ${pnlCls(realized)}">${signed(realized)}</div>
    </div>
    <div class="stat-card">
      <div class="label">含み損益</div>
      <div class="value ${hasCur ? pnlCls(unreal) : 'muted'}">${hasCur ? signed(unreal) : '—'}</div>
      <div class="sub">${pricesUpdated ? '株価 ' + pricesUpdated.slice(0, 10) + ' 自動更新' : '現在値の登録で自動計算'}</div>
    </div>
    <div class="stat-card">
      <div class="label">勝率</div>
      <div class="value">${winRate == null ? '—' : winRate + '%'}</div>
      <div class="sub">${sells}回中 ${wins}勝</div>
    </div>
    <div class="stat-card">
      <div class="label">取引回数</div>
      <div class="value">${db.trades.length}</div>
    </div>
    <div class="stat-card">
      <div class="label">保有銘柄</div>
      <div class="value">${holdings}</div>
    </div>`;

  const recent = db.trades.slice().sort((a, b) => byDateAsc(b, a)).slice(0, 5);
  $('#recentTrades').innerHTML = recent.length
    ? recent.map(tradeItemHTML).join('')
    : emptyHTML('まだ取引がありません', true);
  renderDashSearch();
}

/* ===== 取引一覧 ===== */
function tradeItemHTML(t) {
  const amt = (Number(t.price) || 0) * (Number(t.qty) || 0);
  const tags = (t.tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join('');
  const notes = [];
  if (t.reason) notes.push(`<div class="note-line"><b>理由:</b> ${esc(t.reason)}</div>`);
  if (t.reflection) notes.push(`<div class="note-line"><b>振り返り:</b> ${esc(t.reflection)}</div>`);
  return `
    <div class="trade-item">
      <div class="trade-top">
        <span class="side-badge ${t.side}">${t.side === 'buy' ? '買い' : '売り'}</span>
        <span class="t-ticker">${esc(t.ticker)}</span>
        <span class="t-name">${esc(t.name || '')}</span>
        <span class="t-date">${esc(t.date)}</span>
      </div>
      <div class="trade-money">
        単価 <span class="amt">${yen(t.price)}</span> × ${fmt(t.qty)}株
        = <span class="amt">${yen(amt)}</span>
        ${Number(t.fee) ? `<span class="muted">（手数料 ${yen(t.fee)}）</span>` : ''}
      </div>
      ${tags ? `<div class="chips">${tags}</div>` : ''}
      ${notes.length ? `<div class="notes">${notes.join('')}</div>` : ''}
      <div class="trade-actions">
        <button class="btn ghost small danger" data-del="${t.id}">削除</button>
      </div>
    </div>`;
}
function filteredTrades() {
  const q = ($('#searchInput').value || '').toLowerCase();
  const side = $('#sideFilter').value;
  const tag = $('#tagFilter').value;
  return db.trades.slice().sort((a, b) => byDateAsc(b, a)).filter(t => {
    if (side !== 'all' && t.side !== side) return false;
    if (tag !== 'all' && !(t.tags || []).includes(tag)) return false;
    if (q) {
      const hay = [t.ticker, t.name, t.reason, t.reflection, (t.tags || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function renderTrades() {
  const list = filteredTrades();
  $('#tradeList').innerHTML = list.length
    ? list.map(tradeItemHTML).join('')
    : emptyHTML('該当する取引がありません');
}
function refreshTagFilter() {
  const tags = [...new Set(db.trades.flatMap(t => t.tags || []))].sort();
  const sel = $('#tagFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">タグ: すべて</option>' +
    tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

/* ===== 銘柄メモ ===== */
function renderStocks() {
  const tickers = allTickers();
  if (!tickers.length) {
    $('#stockList').innerHTML = emptyHTML('まだ銘柄がありません。取引を記録すると自動で追加されます。', true);
    return;
  }
  $('#stockList').innerHTML = tickers.map(tk => {
    const s = tickerStats(tk);
    const m = db.memos[tk] || { name: '', memo: '', tags: [], currentPrice: '' };
    const ep = effPrice(tk, m);
    const hasCur = ep.price != null;
    const unreal = hasCur && s.qty > 0 ? (ep.price - s.avgCost) * s.qty : null;
    const winRate = s.sells > 0 ? Math.round(s.wins / s.sells * 100) + '%' : '—';
    const hist = db.trades.filter(t => t.ticker === tk).sort((a, b) => byDateAsc(b, a)).map(t => `
      <div class="hist-item">
        <span class="hb side-badge ${t.side}">${t.side === 'buy' ? '買' : '売'}</span>
        <span class="muted">${esc(t.date)}</span>
        <span>${yen(t.price)} × ${fmt(t.qty)}</span>
      </div>`).join('');

    return `
    <div class="stock-card" data-ticker="${esc(tk)}">
      <div class="stock-head">
        <span class="code">${esc(tk)}</span>
        <span class="nm">${esc(m.name || '')}</span>
        ${s.qty > 0 ? `<span class="pos">保有 ${fmt(s.qty)}株</span>` : ''}
      </div>
      <div class="stock-metrics">
        <div class="metric"><div class="k">平均取得単価</div><div class="v">${s.qty > 0 ? yen(s.avgCost) : '—'}</div></div>
        <div class="metric"><div class="k">実現損益</div><div class="v ${pnlCls(s.realized)}">${signed(s.realized)}</div></div>
        <div class="metric"><div class="k">含み損益</div><div class="v ${unreal == null ? 'muted' : pnlCls(unreal)}">${unreal == null ? '—' : signed(unreal)}</div></div>
        <div class="metric"><div class="k">勝率</div><div class="v">${winRate}</div></div>
      </div>
      <div class="stock-row">
        <label>現在値</label>
        <input type="number" step="0.01" class="cur-input" value="${m.currentPrice != null && m.currentPrice !== '' ? esc(m.currentPrice) : ''}" placeholder="${ep.source === 'auto' ? esc(ep.price) : '手動入力'}">
        ${ep.source === 'auto' ? `<span class="src-badge auto">自動 ${esc(ep.date || '')}</span>` : ''}
        ${ep.source === 'manual' ? '<span class="src-badge manual">手動</span>' : ''}
        ${ep.source === null && s.qty > 0 ? '<span class="src-badge none">自動対象外</span>' : ''}
      </div>
      <div class="stock-row">
        <label>タグ</label>
        <input type="text" class="tag-input" value="${esc((m.tags || []).join(', '))}" placeholder="高配当, 長期">
      </div>
      <div class="memo-wrap">
        <textarea class="memo-input" rows="3" placeholder="投資メモ（注目ポイント・見通しなど）">${esc(m.memo || '')}</textarea>
        ${m.memo && m.memo.length > 60 ? '<button class="btn ghost small memo-toggle">▼ 全文表示</button>' : ''}
      </div>
      <div class="stock-row" style="justify-content:flex-end">
        <button class="btn primary small" data-save="${esc(tk)}">メモを保存</button>
      </div>
      <div class="history">
        <h4>取引履歴 (${db.trades.filter(t => t.ticker === tk).length}件)</h4>
        ${hist || '<div class="muted" style="font-size:13px">履歴なし</div>'}
      </div>
      <div class="chart-section">
        <div class="chart-toggle">
          <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1d">📈 日足</button>
          <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1wk">📊 週足</button>
          <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1mo">📅 月足</button>
        </div>
        <div class="chart-container" id="chart-${esc(tk)}"></div>
      </div>
    </div>`;
  }).join('');
}

/* ===== ダッシュボード検索 ===== */
function renderDashSearch(q) {
  const el = $('#dashSearchResult');
  if (!el) return;
  q = (q || ($('#dashSearch') && $('#dashSearch').value) || '').toLowerCase().trim();
  if (!q) { el.innerHTML = ''; return; }
  const hits = allTickers().filter(tk => {
    const m = db.memos[tk] || {};
    return tk.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q);
  });
  if (!hits.length) { el.innerHTML = '<div class="muted" style="padding:8px 0;font-size:13px">該当なし</div>'; return; }
  el.innerHTML = hits.map(tk => {
    const s = tickerStats(tk);
    const m = db.memos[tk] || {};
    const ep = effPrice(tk, m);
    const unreal = ep.price != null && s.qty > 0 ? (ep.price - s.avgCost) * s.qty : null;
    return `<div class="dash-hit-row">
      <div class="dash-hit" data-goto="${esc(tk)}">
        <span class="t-ticker">${esc(tk)}</span>
        <span class="t-name muted">${esc(m.name || '')}</span>
        <span style="margin-left:auto;font-size:13px">${s.qty > 0 ? fmt(s.qty) + '株保有' : '売却済'}</span>
        ${unreal != null ? `<span class="profit-badge ${unreal >= 0 ? 'profit' : 'loss'}" style="font-size:13px;font-weight:700">${signed(unreal)}</span>` : ''}
      </div>
      <div class="dash-hit-charts">
        <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1d" data-container="dash-chart-${esc(tk)}">📈 日足</button>
        <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1wk" data-container="dash-chart-${esc(tk)}">📊 週足</button>
        <button class="btn small ghost chart-btn" data-ticker="${esc(tk)}" data-interval="1mo" data-container="dash-chart-${esc(tk)}">📅 月足</button>
      </div>
      <div class="chart-container" id="dash-chart-${esc(tk)}"></div>
    </div>`;
  }).join('');
}

function emptyHTML(msg, withSample) {
  return `<div class="empty">
    <p>${esc(msg)}</p>
    ${withSample ? '<button class="btn" id="sampleBtn">サンプルデータを入れて試す</button>' : ''}
  </div>`;
}

/* ===== 全体描画 ===== */
function renderAll() {
  refreshTagFilter();
  renderDashboard();
  renderTrades();
  renderStocks();
}

/* ===== イベント ===== */
// タブ切替
$$('.tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  tab.classList.add('active');
  $('#' + tab.dataset.tab).classList.add('active');
}));

// 取引フォーム送信
$('#tradeForm').addEventListener('submit', e => {
  e.preventDefault();
  const ticker = $('#f_ticker').value.trim();
  if (!ticker) return;
  const name = $('#f_name').value.trim();
  const tags = parseTags($('#f_tags').value);
  const trade = {
    id: uid(),
    date: $('#f_date').value,
    side: $('#f_side').value,
    ticker,
    name,
    price: Number($('#f_price').value) || 0,
    qty: Number($('#f_qty').value) || 0,
    fee: Number($('#f_fee').value) || 0,
    tags,
    reason: $('#f_reason').value.trim(),
    reflection: $('#f_reflection').value.trim(),
    createdAt: Date.now()
  };
  db.trades.push(trade);
  if (!db.memos[ticker]) {
    db.memos[ticker] = { name, memo: '', tags, currentPrice: '', updatedAt: Date.now() };
  } else if (!db.memos[ticker].name && name) {
    db.memos[ticker].name = name;
  }
  save();
  renderAll();
  toast('取引を記録しました');
  e.target.reset();
  $('#f_date').value = today();
});

// フィルタ
['searchInput', 'sideFilter', 'tagFilter'].forEach(id =>
  $('#' + id).addEventListener('input', renderTrades));

// 削除・メモ保存・サンプル（イベント委譲）
document.addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    if (confirm('この取引を削除しますか？')) {
      db.trades = db.trades.filter(t => t.id !== del.dataset.del);
      save(); renderAll(); toast('削除しました');
    }
    return;
  }
  const sv = e.target.closest('[data-save]');
  if (sv) {
    const tk = sv.dataset.save;
    const card = sv.closest('.stock-card');
    db.memos[tk] = db.memos[tk] || { name: '' };
    db.memos[tk].memo = $('.memo-input', card).value.trim();
    db.memos[tk].currentPrice = $('.cur-input', card).value;
    db.memos[tk].tags = parseTags($('.tag-input', card).value);
    db.memos[tk].updatedAt = Date.now();
    save(); renderAll(); toast('銘柄メモを保存しました');
    return;
  }
  if (e.target.id === 'sampleBtn') loadSample();
  // チャートボタン
  const cb = e.target.closest('.chart-btn');
  if (cb) {
    e.stopPropagation();
    const ticker = cb.dataset.ticker, interval = cb.dataset.interval;
    const containerId = cb.dataset.container || ('chart-' + ticker);
    const container = document.getElementById(containerId);
    if (!container) return;
    const group = cb.closest('.chart-toggle') || cb.closest('.dash-hit-charts');
    if (group) group.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
    cb.classList.add('active');
    const trades = db.trades.filter(t => t.ticker === ticker);
    loadChart(ticker, interval, container, trades);
    return;
  }
  // メモ折りたたみ
  const mt = e.target.closest('.memo-toggle');
  if (mt) {
    const ta = mt.closest('.memo-wrap').querySelector('.memo-input');
    const expanded = ta.classList.toggle('memo-expanded');
    mt.textContent = expanded ? '▲ 閉じる' : '▼ 全文表示';
    return;
  }
  // ダッシュボード検索結果クリック → 銘柄メモへ
  const hit = e.target.closest('.dash-hit');
  if (hit) {
    const tk = hit.dataset.goto;
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    $('[data-tab="stocks"]').classList.add('active');
    $('#stocks').classList.add('active');
    setTimeout(() => {
      const card = document.querySelector(`.stock-card[data-ticker="${tk}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return;
  }
});

// バックアップ（JSON書き出し）
$('#exportBtn').addEventListener('click', () => {
  download(`kabu-note-backup-${today()}.json`, JSON.stringify(db, null, 2), 'application/json');
  toast('JSONを書き出しました');
});
// CSV書き出し
$('#csvBtn').addEventListener('click', () => {
  const head = ['日付', '売買', '銘柄コード', '銘柄名', '単価', '株数', '手数料', 'タグ', '理由', '振り返り'];
  const rows = db.trades.slice().sort(byDateAsc).map(t => [
    t.date, t.side === 'buy' ? '買い' : '売り', t.ticker, t.name, t.price, t.qty, t.fee,
    (t.tags || []).join(' '), t.reason, t.reflection
  ].map(csvCell).join(','));
  download(`kabu-note-${today()}.csv`, '﻿' + [head.join(','), ...rows].join('\r\n'), 'text/csv');
  toast('CSVを書き出しました');
});
// 復元（JSON読み込み）
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!Array.isArray(d.trades)) throw new Error('形式が不正です');
      if (!confirm('現在のデータを上書きして復元しますか？')) return;
      db = { trades: d.trades, memos: d.memos || {}, proxy: d.proxy || db.proxy || '' };
      save(); renderAll(); toast('復元しました');
    } catch (err) {
      alert('読み込みに失敗しました: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function csvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[",\r\n]/.test(s) ? `"${s}"` : s;
}
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function today() { return new Date().toISOString().slice(0, 10); }

/* ===== サンプルデータ ===== */
function loadSample() {
  const d = off => { const x = new Date(); x.setDate(x.getDate() - off); return x.toISOString().slice(0, 10); };
  db.trades = [
    { id: uid(), date: d(60), side: 'buy', ticker: '7203', name: 'トヨタ自動車', price: 2500, qty: 100, fee: 0, tags: ['高配当', '長期'], reason: '円安メリットと高配当狙い。決算good。', reflection: '', createdAt: Date.now() - 6000 },
    { id: uid(), date: d(20), side: 'sell', ticker: '7203', name: 'トヨタ自動車', price: 2780, qty: 100, fee: 0, tags: ['利確'], reason: '目標株価に到達。', reflection: 'もう少し持てたが、利確ルール通りでOK。', createdAt: Date.now() - 5000 },
    { id: uid(), date: d(45), side: 'buy', ticker: '6758', name: 'ソニーグループ', price: 2900, qty: 10, fee: 0, tags: ['グロース'], reason: 'ゲーム・半導体の成長期待。', reflection: '', createdAt: Date.now() - 4000 },
    { id: uid(), date: d(10), side: 'buy', ticker: '9984', name: 'ソフトバンクグループ', price: 6500, qty: 20, fee: 0, tags: ['AI'], reason: 'AI関連で出遅れ。Arm期待。', reflection: '', createdAt: Date.now() - 3000 }
  ];
  db.memos = {
    '7203': { name: 'トヨタ自動車', memo: '配当利回り重視。為替前提に注意。', tags: ['高配当', '長期'], currentPrice: '', updatedAt: Date.now() },
    '6758': { name: 'ソニーグループ', memo: 'ゲーム・イメージセンサー・金融の複合企業。', tags: ['グロース'], currentPrice: '', updatedAt: Date.now() },
    '9984': { name: 'ソフトバンクグループ', memo: 'NAVディスカウント。Armの動向次第。', tags: ['AI'], currentPrice: '', updatedAt: Date.now() }
  };
  save(); renderAll(); toast('サンプルデータを読み込みました');
}

/* ===== 株価の自動取得 ===== */
// 1) 同一オリジンの prices.json（GitHub Actionsが毎営業日更新・主要銘柄）
// 2) Workerが設定済みなら全保有銘柄をその場で取得して上書き
async function loadPrices() {
  _autoPricesReady = (async () => {
    try {
      const res = await fetch('prices.json?t=' + Date.now());
      if (res.ok) {
        const d = await res.json();
        autoPrices = d.prices || {};
        pricesUpdated = d.updated || null;
      }
    } catch (e) { /* オフライン等は無視（手動入力は使える） */ }
  })();
  await _autoPricesReady;
  await fetchLive();
  renderAll();
}

// Cloudflare Worker(プロキシ)経由で保有銘柄の株価をまとめて取得
async function fetchLive() {
  const proxy = (db.proxy || '').trim();
  const tickers = allTickers();
  if (!proxy || !tickers.length) return;
  const symMap = {};
  tickers.forEach(t => { symMap[toSymbol(t)] = t; });
  try {
    const url = proxy + (proxy.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(Object.keys(symMap).join(','));
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const got = d.prices || {};
    Object.keys(got).forEach(sym => {
      const t = symMap[sym];
      if (t && got[sym] && got[sym].price != null) livePrices[t] = got[sym];
    });
    if (d.updated) pricesUpdated = d.updated;
  } catch (e) {
    console.warn('live price fetch failed:', e.message);
  }
}

/* ===== 取引フォーム: 銘柄コード入力 → 銘柄名・現在値を自動入力 ===== */
async function fetchOneLive(code) {
  const proxy = (db.proxy || '').trim();
  if (!proxy) return null;
  try {
    const sym = toSymbol(code);
    const url = proxy + (proxy.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(sym);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const q = d.prices && d.prices[sym];
    if (q && q.price != null) { livePrices[code] = q; return q; }
  } catch (e) { console.warn('lookup failed:', e.message); }
  return null;
}

/* ===== チャートデータ取得 ===== */
async function fetchChart(code, interval) {
  const proxy = (db.proxy || '').trim();
  if (!proxy) return null;
  try {
    const sym = toSymbol(code);
    const url = proxy + (proxy.includes('?') ? '&' : '?') + 'chart=' + encodeURIComponent(sym) + '&interval=' + interval;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return d.candles || null;
  } catch (e) { console.warn('chart fetch failed:', e.message); return null; }
}

function renderCandlestick(candles, trades) {
  if (!candles || !candles.length) return '<div class="chart-empty">データなし</div>';
  const W = 600, H = 180;
  const pad = { t: 8, r: 6, b: 22, l: 52 };
  const cw = (W - pad.l - pad.r) / candles.length;
  const bw = Math.max(1, cw - 1);
  const hs = candles.map(c => c.h).filter(x => x != null);
  const ls = candles.map(c => c.l).filter(x => x != null);
  const maxP = Math.max(...hs), minP = Math.min(...ls);
  const rng = maxP - minP || 1;
  const ch = H - pad.t - pad.b;
  const ty = p => pad.t + ch - ((p - minP) / rng) * ch;
  const tx = i => pad.l + (i + 0.5) * cw;
  // 月足かどうかで日付ラベル形式を変える
  const avgMs = candles.length > 1
    ? (+new Date(candles[candles.length - 1].t) - +new Date(candles[0].t)) / (candles.length - 1)
    : 86400000;
  const dateLbl = c => avgMs > 20 * 86400000 ? c.t.slice(0, 7) : c.t.slice(5);
  let s = '';
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const price = minP + rng * f, y = ty(price);
    const lbl = price >= 1000 ? Math.round(price).toLocaleString() : price.toFixed(1);
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#2c3c63" stroke-width="0.5"/>`;
    s += `<text x="${pad.l - 3}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#93a2c4" font-size="9">${lbl}</text>`;
  });
  candles.forEach((c, i) => {
    if (c.o == null || c.c == null) return;
    const bull = c.c >= c.o;
    const col = bull ? '#2ecc8f' : '#ff6b7d';
    const x = tx(i), y1 = ty(Math.max(c.o, c.c)), y2 = ty(Math.min(c.o, c.c));
    const bh = Math.max(1, y2 - y1);
    if (c.h != null && c.l != null)
      s += `<line x1="${x.toFixed(1)}" y1="${ty(c.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${ty(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
  });
  [0, Math.floor(candles.length / 2), candles.length - 1].forEach(i => {
    if (!candles[i]) return;
    s += `<text x="${tx(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="#93a2c4" font-size="9">${dateLbl(candles[i])}</text>`;
  });
  // 売買マーカー（▲買い＝緑 ▼売り＝赤）
  if (trades && trades.length) {
    trades.forEach(t => {
      let closestIdx = -1, minDiff = Infinity;
      candles.forEach((c, i) => {
        const diff = Math.abs(+new Date(c.t) - +new Date(t.date));
        if (diff < minDiff) { minDiff = diff; closestIdx = i; }
      });
      if (closestIdx < 0 || minDiff > avgMs * 1.5) return;
      const p = Number(t.price);
      if (!isFinite(p)) return;
      const x = tx(closestIdx);
      const y = Math.max(pad.t + 6, Math.min(pad.t + ch - 6, ty(p)));
      const isBuy = t.side === 'buy';
      const col = isBuy ? '#2ecc8f' : '#ff6b7d';
      const sz = 5;
      const pts = isBuy
        ? `${x.toFixed(1)},${(y - sz).toFixed(1)} ${(x - sz).toFixed(1)},${(y + sz).toFixed(1)} ${(x + sz).toFixed(1)},${(y + sz).toFixed(1)}`
        : `${x.toFixed(1)},${(y + sz).toFixed(1)} ${(x - sz).toFixed(1)},${(y - sz).toFixed(1)} ${(x + sz).toFixed(1)},${(y - sz).toFixed(1)}`;
      s += `<polygon points="${pts}" fill="${col}" stroke="#0f1729" stroke-width="1.5" opacity="0.95"/>`;
    });
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">${s}</svg>`;
}

async function loadChart(code, interval, container, trades) {
  container.innerHTML = '<div class="chart-loading">読み込み中…</div>';
  const candles = await fetchChart(code, interval);
  container.innerHTML = candles ? renderCandlestick(candles, trades || []) : '<div class="chart-empty">Worker URL が未設定か取得に失敗しました</div>';
}

async function lookupTicker(code) {
  code = code.trim();
  if (!code) return null;
  if (_autoPricesReady) await _autoPricesReady;
  const m = db.memos[code];
  let name = m && m.name ? m.name : null;
  let price = null;
  const cached = livePrices[code] || autoPrices[code];
  if (cached) { name = name || cached.name || null; if (cached.price != null) price = cached.price; }
  if ((db.proxy || '').trim() && (price == null || !name)) {
    const live = await fetchOneLive(code);
    if (live) { if (live.price != null) price = live.price; name = name || live.name || null; }
  }
  return { name, price };
}

async function lookupAndFill() {
  const code = ($('#f_ticker').value || '').trim();
  const hint = $('#tickerHint');
  if (!code) { if (hint) hint.textContent = ''; return; }
  if (hint) hint.textContent = '🔎 ' + code + ' を照会中…';
  const info = await lookupTicker(code);
  const nameEl = $('#f_name'), priceEl = $('#f_price');
  if (!info || (info.name == null && info.price == null)) {
    if (hint) hint.innerHTML = '<span style="color:var(--loss)">⚠ ' + esc(code) + '：取得できませんでした（Worker URL を確認してください）</span>';
    toast('⚠ ' + code + '：取得できませんでした');
    return;
  }
  if (info.name) nameEl.value = info.name;
  if (info.price != null) priceEl.value = info.price;
  const msg = '✓ ' + (info.name || code) + (info.price != null ? '（¥' + fmt(info.price) + '）' : '');
  if (hint) hint.innerHTML = '<span style="color:var(--profit)">' + esc(msg) + '</span>';
  toast(msg);
}
const tickerInput = $('#f_ticker');
if (tickerInput) {
  let _tickerTimer;
  tickerInput.addEventListener('input', () => {
    clearTimeout(_tickerTimer);
    _tickerTimer = setTimeout(lookupAndFill, 600);
  });
  tickerInput.addEventListener('change', lookupAndFill);
}
const lookupBtn = $('#lookupBtn');
if (lookupBtn) lookupBtn.addEventListener('click', async () => {
  const code = ($('#f_ticker').value || '').trim();
  if (!code) { toast('銘柄コードを入力してください'); return; }
  toast('🔎 ' + code + ' を検索中...');
  $('#f_name').value = '';
  $('#f_price').value = '';
  await lookupAndFill();
});

const refreshBtn = $('#refreshPrices');
if (refreshBtn) refreshBtn.addEventListener('click', async () => {
  await loadPrices();
  toast(pricesUpdated ? '株価を更新しました（' + pricesUpdated.slice(0, 10) + '）' : '株価データがまだありません');
});

/* ===== 株価プロキシ(Cloudflare Worker)の設定 ===== */
function renderProxyStatus() {
  const el = $('#proxyStatus');
  if (!el) return;
  const p = (db.proxy || '').trim();
  el.innerHTML = p
    ? '✓ 設定済み（全銘柄を自動取得）: <span class="muted">' + esc(p) + '</span>'
    : '未設定（主要約78銘柄は自動／その他は手動入力）';
  const input = $('#proxyInput');
  if (input && !input.value) input.value = p;
}
const proxySaveBtn = $('#proxySave');
if (proxySaveBtn) proxySaveBtn.addEventListener('click', async () => {
  const v = ($('#proxyInput').value || '').trim();
  db.proxy = v; save(); renderProxyStatus();
  livePrices = {};
  if (v) { await fetchLive(); renderAll(); toast('保存しました（全銘柄を自動取得）'); }
  else { renderAll(); toast('プロキシを解除しました'); }
});
const proxyTestBtn = $('#proxyTest');
if (proxyTestBtn) proxyTestBtn.addEventListener('click', async () => {
  const v = ($('#proxyInput').value || '').trim();
  const el = $('#proxyStatus');
  if (!v) { toast('URLを入力してください'); return; }
  el.textContent = '接続テスト中…';
  try {
    const url = v + (v.includes('?') ? '&' : '?') + 's=7203.T';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const q = d.prices && d.prices['7203.T'];
    if (q && q.price != null) el.innerHTML = '✓ 接続OK（トヨタ7203 = ¥' + fmt(q.price) + '）';
    else throw new Error('価格を取得できませんでした');
  } catch (e) {
    el.innerHTML = '✗ 失敗: ' + esc(e.message) + '（URL／Workerのデプロイを確認）';
  }
});

/* ===== ダッシュボード検索 イベント ===== */
document.addEventListener('input', e => {
  if (e.target.id === 'dashSearch') renderDashSearch(e.target.value);
});

/* ===== 初期化 ===== */
$('#f_date').value = today();
renderProxyStatus();
renderAll();
loadPrices();
