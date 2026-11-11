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
  vtr2050: { label: 'Vanguard Target 2050 (88% מניות)', w: { vfifx: 1 } },
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
      case 'vfifx': return at(S.VFIFX, d) ?? at(S.GSPC, d);
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
  // Known real balances (annual reports etc.) + the latest balance. Between two real points: market path,
  // corrected linearly so it lands exactly on the next real point (this spreads deposits over the period).
  const points = (f) => {
    if (f._pts) return f._pts;
    const m = new Map((f.history || []).map((h) => [h.date, h.balance]));
    if (f.balance != null && f.balanceDate) m.set(f.balanceDate, f.balance);
    // Money transferred in from another fund existed before the transfer too: add it (market-adjusted)
    // to earlier points, so the chart shows the family's money, not a jump on the transfer date.
    const tr = Object.entries(f.transfers || {}).map(([y, amt]) => ({ date: `${y}-07-01`, amt }));
    return (f._pts = [...m.entries()].map(([date, balance]) => ({
      date, balance: balance + tr.filter((t) => date < t.date).reduce((a, t) => a + t.amt / growth(f.track, date, t.date), 0),
    })).sort((a, b) => (a.date < b.date ? -1 : 1)));
  };
  const native = (f, d) => {
    const pts = points(f);
    if (!pts.length) return null;
    if (f.startDate && d < f.startDate) return 0;
    if (d <= pts[0].date) return pts[0].balance * growth(f.track, pts[0].date, d);
    const last = pts[pts.length - 1];
    if (d >= last.date) return last.balance * growth(f.track, last.date, d);
    let k = 0; while (pts[k + 1].date <= d) k++;
    const p0 = pts[k], p1 = pts[k + 1];
    const e = p0.balance * growth(f.track, p0.date, d), e1 = p0.balance * growth(f.track, p0.date, p1.date);
    const frac = (Date.parse(d) - Date.parse(p0.date)) / (Date.parse(p1.date) - Date.parse(p0.date));
    return e + (p1.balance - e1) * frac;
  };
  // Investment return only (no deposits): reported yearly returns where known, market index otherwise.
  const returnBetween = (f, from, to) => {
    let r = 1;
    for (let Y = +from.slice(0, 4); Y <= +to.slice(0, 4); Y++) {
      const ys = `${Y - 1}-12-31`, ye = `${Y}-12-31`;
      const a = from > ys ? from : ys, b = to < ye ? to : ye;
      if (a >= b) continue;
      const rep = f.annualReturns && f.annualReturns[Y];
      if (rep != null && a === ys && b === ye) r *= 1 + rep / 100;
      else if (f.ytdReported != null && f.balanceDate && +f.balanceDate.slice(0, 4) === Y && a === ys && b >= f.balanceDate) r *= (1 + f.ytdReported / 100) * growth(f.track, f.balanceDate, b);
      else r *= growth(f.track, a, b);
    }
    return r;
  };
  const ils = (f, d) => { const n = native(f, d); return n == null ? null : n * fx(f.cur, d); };
  // Share of the fund's value that moves with a foreign currency (vs the shekel).
  // Abroad: the whole fund. Israeli tracks: the S&P 500 part (assumed unhedged) – an estimate.
  const exposure = (f) => {
    if (f.cur === 'USD') return { USD: 1, EUR: 0 };
    if (f.cur === 'EUR') return { USD: 0, EUR: 1 };
    const w = (TRACKS[f.track] || TRACKS.general).w, tot = Object.values(w).reduce((a, b) => a + b, 0);
    return { USD: (w.spx_ils || 0) / tot, EUR: 0 };
  };
  // Weighted currency change between two dates, e.g. -0.05 = the fund lost 5% just from the exchange rate.
  const fxChange = (e, a, b) => e.USD * (fx('USD', b) / fx('USD', a) - 1) + e.EUR * (fx('EUR', b) / fx('EUR', a) - 1);
  return { fx, native, ils, growth, returnBetween, exposure, fxChange, comp };
}

const HEB_MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

function monthsUntil(ym, today) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  const t = new Date(today);
  return (y - t.getUTCFullYear()) * 12 + (m - 1 - t.getUTCMonth());
}

// Typical fees in the market, for the fee comparison. Public data – sources shown on the page.
export const BENCHMARKS = {
  pension: { acc: 0.144, dep: 1.54, label: 'ממוצע קרנות פנסיה חדשות', src: 'סופרמרקר, דיווחי הקרנות לרשות שוק ההון, אוגוסט 2026', srcUrl: 'https://www.supermarker.themarker.com/Calculators/Fees/ManagementFeesCalculator.aspx', tip: 'קרנות ברירת המחדל גובות 1% מההפקדה ו־0.22% מהצבירה – נקודת פתיחה טובה למו״מ.' },
  bm: { acc: 0.77, dep: 1.84, label: 'חציון ביטוח מנהלים (פוליסות מ־2004)', src: 'סופרמרקר על נתוני ביטוח נט, יולי 2026', srcUrl: 'https://www.supermarker.themarker.com/MenahalimInsurance/MenahalimVsPensionFund.aspx', tip: '' },
  hish: { acc: 0.6, dep: 0, label: 'טווח מקובל בקרנות השתלמות: 0.55%–0.63%', src: 'השוואת קרנות השתלמות, גמל נט 2026', srcUrl: 'https://www.supermarker.themarker.com/Gemel/CompareHishtalmutFunds.aspx', tip: '' },
  gemel: { acc: 0.6, dep: 0, label: 'הערכה לקופות גמל; 1.05% היא התקרה החוקית', src: 'הערכה לפי קרנות השתלמות דומות', srcUrl: '', tip: '' },
  k401: { acc: 0.05, dep: 0, label: 'Vanguard Target Retirement Trust: 0.045%–0.055%', src: 'Vanguard fact sheets, 2026', srcUrl: 'https://workplace.vanguard.com/assets/corp/fund_communications/pdf_publish/us-products/fact-sheet/F1681.pdf', tip: '' },
  ireland: { acc: 0.8, dep: 0, label: 'ממוצע דמי ניהול בפנסיות באירלנד ~0.8%', src: 'Insurance Ireland, דרך Irish Times', srcUrl: 'https://www.irishtimes.com/business/2023/06/16/irish-pension-charges-good-value-at-08-says-insurance-ireland', tip: '' },
};

export const CATEGORIES = [
  ['pension', 'קרן פנסיה'], ['bm', 'ביטוח מנהלים'], ['hish', 'קרן השתלמות'], ['gemel', 'קופת גמל'], ['k401', '401k בארה״ב'], ['ireland', 'פנסיה באירלנד'],
];

export function computePayload(state, market, today) {
  const model = makeModel(market, state.fallbackFx || { USD: 3.7, EUR: 4.0 });
  const monthAgo = addDays(today, -30);
  const threeY = addDays(today, -1096);
  const yearStart = `${Number(today.slice(0, 4)) - 1}-12-31`;
  const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

  const fam = { total: 0, ytd: 0, m: 0, fxY: 0, usd: 0, eur: 0 };
  const feeRows = [];
  const people = state.people.map((p) => {
    let total = 0, ytd = 0, mm = 0, fxImpact = 0, usdNow = 0, eurNow = 0;
    let pW = p.socialSecurity || 0, pWo = p.socialSecurity || 0;
    const funds = p.funds.map((f) => {
      const now = model.ils(f, today);
      const mAgo = model.ils(f, monthAgo);
      const r3 = now != null ? model.returnBetween(f, threeY, today) : null;
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

      const b = BENCHMARKS[f.category] || null;
      const depNum = typeof f.depositFee === 'string' && /^[\d.]+%$/.test(f.depositFee) ? parseFloat(f.depositFee) : null;
      const yearlyDeposits = f.monthlyDeposit ? f.monthlyDeposit * 12 : 0;
      const accCost = f.accFee != null && now != null ? now * f.accFee / 100 : null;
      const depCost = depNum != null && yearlyDeposits ? yearlyDeposits * depNum / 100 : null;
      if (now != null) {
        // Same rule as the page's status badge: only clearly above the market counts (10% + 0.01pt tolerance on savings fee, 0.05pt on deposit fee).
        const accHigh = b && f.accFee != null && f.accFee > b.acc * 1.1 + 0.01;
        const depHigh = b && depNum != null && yearlyDeposits && b.dep && depNum > b.dep + 0.05;
        const accOver = accHigh ? (f.accFee - b.acc) / 100 * now : 0;
        const depOver = depHigh ? (depNum - b.dep) / 100 * yearlyDeposits : 0;
        feeRows.push({
          id: f.id, person: p.id, personName: p.name, category: f.category, kind: f.kind, provider: f.provider,
          acc: f.accFee, accApprox: !!f.accFeeApprox, accAvg: b ? b.acc : null,
          dep: depNum, depAvg: b && b.dep ? b.dep : null, active: !f.inactive, yearlyDeposits,
          cost: (accCost || 0) + (depCost || 0), accCost, depCost, saving: accOver + depOver, value: now,
        });
      }

      const ex = model.exposure(f);
      const fxM = model.fxChange(ex, monthAgo, today), fxY = model.fxChange(ex, yearStart, today), fx3 = model.fxChange(ex, threeY, today);
      // How many shekels of this year's change came only from the exchange rate.
      const fxYAmt = now != null ? now - now / (1 + fxY) : 0;
      fxImpact += fxYAmt; usdNow += (now || 0) * ex.USD; eurNow += (now || 0) * ex.EUR;
      const mu = monthsUntil(f.liquidityDate, today);
      return {
        id: f.id, category: f.category, kind: f.kind, provider: f.provider, url: f.url, cur: f.cur, inactive: !!f.inactive,
        track: (TRACKS[f.track] || TRACKS.general).label,
        reported: f.balance == null ? null : { amount: f.balance, cur: f.cur, date: f.balanceDate },
        value: now, mPct: pct(now, mAgo), mAmt: now != null ? now - mAgo : null,
        yPct: pct(now, y0), yAmt: now != null ? now - y0 : null,
        y3Pct: r3 != null ? (r3 - 1) * 100 : null, y3Amt: r3 != null ? now - now / r3 : null,
        realSince: (f.history || []).length ? f.history.map((h) => h.date).sort()[0] : null,
        y3Real: !!(f.annualReturns && Object.keys(f.annualReturns).length),
        years: (f.history || []).length ? [...(f.history || []).map((h) => ({ year: h.date.slice(0, 4), date: h.date, balance: h.balance })), ...(f.balance != null ? [{ year: f.balanceDate.slice(0, 4), date: f.balanceDate, balance: f.balance, partial: true }] : [])]
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .map((r) => ({ ...r, deposits: f.yearlyDeposits ? f.yearlyDeposits[r.year] ?? null : null, transfer: f.transfers ? f.transfers[r.year] ?? null : null, ret: r.partial ? f.ytdReported ?? null : (f.annualReturns ? f.annualReturns[r.year] ?? null : null) })) : null,
        depositFee: f.depositFee ?? '?', accFee: f.accFee, accFeeApprox: !!f.accFeeApprox, feeYear: accCost, pension,
        pensionNative: f.pensionCur && f.pensionWith != null ? { amount: f.pensionWith, cur: f.pensionCur } : null,
        exp: ex, fxM, fxY, fx3, fxYAmt,
        liquidity: f.liquidity || '—',
        liquidityNote: mu == null ? null : mu <= 0 ? 'נזילה עכשיו' : mu <= 12 ? `נזילה בעוד ${mu} חודשים` : null,
        note: f.note || null,
      };
    });
    fam.total += total; fam.ytd += ytd; fam.m += mm; fam.fxY += fxImpact; fam.usd += usdNow; fam.eur += eurNow;
    return { id: p.id, name: p.name, total, ytd, m: mm, fxY: fxImpact, usd: usdNow, eur: eurNow, pensionWith: pW, pensionWithout: pWo, funds, footnote: p.footnote || '', depositsPaused: !!p.depositsPaused, resumeNote: p.resumeNote || '' };
  });

  const cumDeposits = (f, d) => {
    if (!f.yearlyDeposits || !(f.history || []).length) return 0;
    let sum = 0;
    for (const [y, amt] of Object.entries(f.yearlyDeposits)) {
      if (!amt) continue;
      const ys = Date.parse(`${+y - 1}-12-31`);
      let ye = `${y}-12-31`;
      if (f.balanceDate && f.balanceDate.slice(0, 4) === y && f.balanceDate < ye) ye = f.balanceDate;
      const fr = Math.min(1, Math.max(0, (Date.parse(d) - ys) / (Date.parse(ye) - ys)));
      sum += amt * fr;
    }
    return sum;
  };
  // growth: every trading day in the last 5 years (+ today), per person, in ILS.
  const fiveY = addDays(today, -1830);
  const days = ((market?.series?.GSPC) || []).map((x) => x[0]).filter((d) => d >= fiveY && d < today);
  days.push(today);
  const growth = {
    dates: days,
    people: state.people.map((p) => ({
      id: p.id, name: p.name,
      values: days.map((d) => Math.round(p.funds.reduce((a, f) => a + (model.ils(f, d) || 0), 0))),
      usd: days.map((d) => Math.round(p.funds.reduce((a, f) => a + (model.ils(f, d) || 0) * model.exposure(f).USD, 0))),
      eur: days.map((d) => Math.round(p.funds.reduce((a, f) => a + (model.ils(f, d) || 0) * model.exposure(f).EUR, 0))),
      // Cumulative deposits (from annual reports), spread evenly over each year up to the last real balance.
      dep: days.map((d) => Math.round(p.funds.reduce((a, f) => a + cumDeposits(f, d) * model.fx(f.cur, d), 0))),
    })),
    fx: { USD: days.map((d) => +model.fx('USD', d).toFixed(4)), EUR: days.map((d) => +model.fx('EUR', d).toFixed(4)) },
  };

  // Currency box: S&P 500 in dollars vs in shekels, per period.
  const chg = (k, a, b) => { const x = model.comp(k, a), y = model.comp(k, b); return x && y ? (y / x - 1) * 100 : null; };
  const fxPct = (c, a, b) => (model.fx(c, b) / model.fx(c, a) - 1) * 100;
  const currency = [['1m', 'חודש', monthAgo], ['ytd', `מתחילת ${today.slice(0, 4)}`, yearStart], ['1y', 'שנה', addDays(today, -365)], ['3y', '3 שנים', threeY], ['5y', '5 שנים', fiveY]]
    .map(([id, label, from]) => ({ id, label, from, spxUsd: chg('spx_usd', from, today), usd: fxPct('USD', from, today), spxIls: chg('spx_ils', from, today), eur: fxPct('EUR', from, today) }));

  feeRows.sort((a, b) => b.cost - a.cost);

  return {
    generatedAt: new Date().toISOString(),
    today,
    fx: { USD: model.fx('USD', today), EUR: model.fx('EUR', today) },
    family: { total: fam.total, ytd: fam.ytd, ytdPct: pct(fam.total, fam.total - fam.ytd), m: fam.m, mPct: pct(fam.total, fam.total - fam.m), fxY: fam.fxY, usd: fam.usd, eur: fam.eur },
    currency,
    people,
    categories: CATEGORIES,
    benchmarks: BENCHMARKS,
    growth,
    fees: { rows: feeRows },
    insurance: state.insurance || [],
    coverage: state.coverage || [],
    marketLog: market?.log || [],
  };
}
