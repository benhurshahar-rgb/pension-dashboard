// Turns the private state + market series into the payload the page renders.
//
// Value estimate for a fund on date d:
//   balance_at_report × Σ weight_k × component_k(d) / component_k(report date)
// Components are market indices (in the fund's own currency). Between official reports this
// tracks the market; each new report (Mislaka / fund statement) resets the anchor to the truth.

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(new Date(s + 'T00:00:00Z').getTime() + n * DAY));

export const TRACKS = {
  sp500_ils: { label: 'S&P 500 (בשקלים)', w: { spx_ils: 1 } },
  sp500_usd: { label: 'S&P 500 (בדולרים)', w: { spx_usd: 1 } },
  equity_il: { label: 'מסלול מניות', w: { spx_ils: 0.6, ta125: 0.4 } },
  general: { label: 'מסלול כללי', w: { spx_ils: 0.35, ta125: 0.15, bonds: 0.5 } },
  world_eur: { label: 'מניות עולמי (ביורו)', w: { world_eur: 1 } },
  vtr2045: { label: 'Vanguard Target 2045 (81% מניות)', w: { vtivx: 1 } },
  irish_hg: { label: 'EMPOWER High Growth', w: { world_eur: 0.75, bonds: 0.25 } },
  irish_annuity: { label: 'EMPOWER Annuity Objective (אג״ח ארוכות)', w: { eur_long: 1 } },
};

function at(series, date) {
  if (!series || !series.length) return null;
  let lo = 0, hi = series.length - 1;
  if (date < series[0][0]) return series[0][1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= date) lo = mid; else hi = mid - 1;
  }
  return series[lo][1];
}

export function makeModel(market, fallbackFx) {
  const S = market?.series || {};
  const fx = (cur, d) => {
    if (cur === 'ILS') return 1;
    const v = at(S[cur === 'USD' ? 'USDILS' : 'EURILS'], d);
    return v ?? fallbackFx[cur];
  };
  const comp = (k, d) => {
    switch (k) {
      case 'spx_usd': return at(S.GSPC, d);
      case 'eur_long': return at(S.EURLONG, d);
      case 'vtivx': return at(S.VTIVX, d) ?? at(S.GSPC, d);
      case 'spx_ils': { const a = at(S.GSPC, d), b = at(S.USDILS, d); return a && b ? a * b : null; }
      case 'ta125': return at(S.TA125, d);
      case 'world_eur': { const a = at(S.URTH, d), u = at(S.USDILS, d), e = at(S.EURILS, d); return a && u && e ? a * u / e : null; }
      case 'bonds': return Math.exp(0.04 * (new Date(d) - new Date('2020-01-01')) / (365 * DAY));
      default: return null;
    }
  };
  const growth = (track, from, to) => {
    const t = TRACKS[track] || TRACKS.general;
    let g = 0, wsum = 0;
    for (const [k, w] of Object.entries(t.w)) {
      const a = comp(k, from), b = comp(k, to);
      if (a && b) { g += w * (b / a); wsum += w; }
    }
    return wsum ? g / wsum : 1;
  };
  const native = (f, d) => (f.balance == null ? null : f.balance * growth(f.track, f.balanceDate, d));
  const ils = (f, d) => { const n = native(f, d); return n == null ? null : n * fx(f.cur, d); };
  return { fx, native, ils };
}

const HEB_MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

function monthsUntil(ym, today) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  const t = new Date(today);
  return (y - t.getUTCFullYear()) * 12 + (m - 1 - t.getUTCMonth());
}

export function computePayload(state, market, today) {
  const model = makeModel(market, state.fallbackFx || { USD: 3.7, EUR: 4.0 });
  const monthAgo = addDays(today, -30);
  const yearStart = `${Number(today.slice(0, 4)) - 1}-12-31`;
  const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

  const fam = { total: 0, ytd: 0, m: 0 };
  const feeRows = [];
  const people = state.people.map((p) => {
    let total = 0, ytd = 0, mm = 0;
    let pW = p.socialSecurity || 0, pWo = p.socialSecurity || 0;
    const funds = p.funds.map((f) => {
      const now = model.ils(f, today);
      const mAgo = model.ils(f, monthAgo);
      // YTD: if the report gave this year's return, start from it and estimate only the time since the report.
      const y0 = f.ytdReported != null && f.balanceDate && f.balanceDate.slice(0, 4) === today.slice(0, 4)
        ? model.ils(f, f.balanceDate) / (1 + f.ytdReported / 100)
        : model.ils(f, yearStart);
      const pfx = f.pensionCur ? model.fx(f.pensionCur, today) : 1;
      const pension = f.pensionWith != null ? f.pensionWith * pfx : null;
      const pensionWo = f.pensionWithout != null ? f.pensionWithout * pfx : null;
      if (pension) pW += pension;
      if (pensionWo) pWo += pensionWo;
      if (now != null) { total += now; ytd += now - y0; mm += now - mAgo; }
      const fee = f.accFee != null && now != null ? now * f.accFee / 100 : null;
      if (fee) feeRows.push({ label: `${p.name} · ${f.kind} ${f.provider} (${f.accFee.toFixed(2)}%)`, v: fee, person: p.id });
      const mu = monthsUntil(f.liquidityDate, today);
      return {
        id: f.id, kind: f.kind, provider: f.provider, url: f.url, cur: f.cur, inactive: !!f.inactive,
        track: (TRACKS[f.track] || TRACKS.general).label,
        reported: f.balance == null ? null : { amount: f.balance, cur: f.cur, date: f.balanceDate },
        value: now, mPct: pct(now, mAgo), mAmt: now != null ? now - mAgo : null,
        yPct: pct(now, y0), yAmt: now != null ? now - y0 : null,
        depositFee: f.depositFee ?? '?', accFee: f.accFee, feeYear: fee, pension,
        pensionNative: f.pensionCur && f.pensionWith != null ? { amount: f.pensionWith, cur: f.pensionCur } : null,
        liquidity: f.liquidity || '—',
        liquidityNote: mu == null ? null : mu <= 0 ? 'נזילה עכשיו' : mu <= 12 ? `נזילה בעוד ${mu} חודשים` : null,
        note: f.note || null,
      };
    });
    fam.total += total; fam.ytd += ytd; fam.m += mm;
    return { id: p.id, name: p.name, total, ytd, m: mm, pensionWith: pW, pensionWithout: pWo, funds, footnote: p.footnote || '', depositsPaused: !!p.depositsPaused, resumeNote: p.resumeNote || '' };
  });

  // growth: month-ends for the last 11 months + today
  const points = [];
  const t = new Date(today + 'T00:00:00Z');
  for (let k = 11; k >= 1; k--) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - k + 1, 0));
    points.push({ date: iso(d), label: HEB_MONTHS[d.getUTCMonth()] });
  }
  points.push({ date: today, label: 'היום' });
  const growth = {
    labels: points.map((x) => x.label),
    people: state.people.map((p) => ({
      id: p.id, name: p.name,
      values: points.map((x) => p.funds.reduce((a, f) => a + (model.ils(f, x.date) || 0), 0)),
    })),
  };

  feeRows.sort((a, b) => b.v - a.v);

  return {
    generatedAt: new Date().toISOString(),
    today,
    fx: { USD: model.fx('USD', today), EUR: model.fx('EUR', today) },
    family: { total: fam.total, ytd: fam.ytd, ytdPct: pct(fam.total, fam.total - fam.ytd), m: fam.m, mPct: pct(fam.total, fam.total - fam.m) },
    people,
    growth,
    fees: { rows: feeRows, total: feeRows.reduce((a, r) => a + r.v, 0) },
    insurance: state.insurance || [],
    marketLog: market?.log || [],
    history: (state.history || []).slice(-400),
  };
}
