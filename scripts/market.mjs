// Fetches daily market series used to estimate each fund's value between official reports.
// Series are cached inside the (encrypted) state, so a failed fetch never breaks the page.

const SYMBOLS = {
  GSPC: '^GSPC',       // S&P 500 (USD)
  TA125: '^TA125.TA',  // Tel Aviv 125 (ILS)
  URTH: 'URTH',        // MSCI World ETF (USD)
  EURLONG: 'IBGL.AS',  // iShares Euro Govt Bond 15-30yr (proxy for Irish Life Annuity Objective)
  VTIVX: 'VTIVX',
  VFIFX: 'VFIFX',      // Vanguard Target Retirement 2050 (proxy for Lotem's Meta 401k trust)      // Vanguard Target Retirement 2045 (proxy for the 401k trust)
  USDILS: 'ILS=X',     // USD → ILS
  EURILS: 'EURILS=X',  // EUR → ILS
};

const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (pension-dashboard)' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const close = r?.indicators?.quote?.[0]?.close || [];
  const out = [];
  ts.forEach((t, i) => { if (close[i] != null && Number.isFinite(close[i])) out.push([day(t), close[i]]); });
  if (out.length < 20) throw new Error(`${symbol}: too few points`);
  return out;
}

async function fetchBoiRates() {
  // Bank of Israel representative rates (today only) – fallback for FX.
  const res = await fetch('https://boi.org.il/PublicApi/GetExchangeRates', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`BOI: HTTP ${res.status}`);
  const j = await res.json();
  const rates = {};
  for (const r of j.exchangeRates || []) rates[r.key] = { rate: r.currentExchangeRate / (r.unit || 1), date: String(r.lastUpdate).slice(0, 10) };
  return rates;
}

function merge(oldS = [], newS = []) {
  const m = new Map(oldS);
  for (const [d, v] of newS) m.set(d, v);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export async function updateMarket(cache = { series: {} }) {
  const series = { ...(cache.series || {}) };
  const log = [];
  for (const [key, sym] of Object.entries(SYMBOLS)) {
    try {
      series[key] = merge(series[key], await fetchYahoo(sym));
      log.push(`ok ${key}`);
    } catch (e) {
      log.push(`FAIL ${key}: ${e.message}`);
    }
  }
  try {
    const boi = await fetchBoiRates();
    for (const [cur, key] of [['USD', 'USDILS'], ['EUR', 'EURILS']]) {
      if (boi[cur]) series[key] = merge(series[key], [[boi[cur].date, boi[cur].rate]]);
    }
    log.push('ok BOI');
  } catch (e) {
    log.push(`FAIL BOI: ${e.message}`);
  }
  return { series, updatedAt: new Date().toISOString(), log };
}
