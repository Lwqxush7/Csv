import { ALL_TF_NAMES, PAIRS, TF_SECONDS } from '../data/pairs';
import type { Candle, CsvTimeFormat, TfMeta, Timeframe } from '../types/market';

export const pad2 = (n: number | string): string => String(n).padStart(2, '0');

export const toYMD = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

export const isoUtc = (ts: number): string =>
  new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

export const ymdHmUtc = (ts: number): string => {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};

export const formatCsvTimestamp = (ts: number, fmt: CsvTimeFormat = 'iso'): string => {
  if (fmt === 'unix') return String(ts);
  if (fmt === 'ymdhm') return ymdHmUtc(ts);
  return isoUtc(ts);
};

export const shortDateUtc = (ts: number, withYear = false): string => {
  const d = new Date(ts * 1000);
  const base = `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}`;
  return withYear ? `${base}.${String(d.getUTCFullYear()).slice(-2)}` : base;
};

export const calcCalendarDays = (sStr: string, eStr: string): number => {
  const s = Date.parse(`${sStr}T00:00:00Z`);
  const e = Date.parse(`${eStr}T00:00:00Z`);
  return Number.isFinite(s) && Number.isFinite(e) && e >= s
    ? Math.round((e - s) / 86400000) + 1
    : 0;
};

export function getSymbolDecimals(sym: string, bars: Candle[] = []): number {
  if (PAIRS[sym]?.dec !== undefined) return PAIRS[sym].dec;
  let maxDec = 2;
  for (const b of bars.slice(0, 60)) {
    for (const v of [b.open, b.high, b.low, b.close]) {
      const s = String(v);
      const idx = s.indexOf('.');
      if (idx !== -1) maxDec = Math.max(maxDec, Math.min(5, s.length - idx - 1));
    }
  }
  return maxDec;
}

export function sanitizeBars(bars: Candle[], minTs = 0, maxTs = Infinity): Candle[] {
  if (!Array.isArray(bars) || !bars.length) return [];
  const map = new Map<number, Candle>();
  for (const b of bars) {
    const time = Math.floor(Number(b.time));
    const open = Number(b.open);
    const highRaw = Number(b.high);
    const lowRaw = Number(b.low);
    const close = Number(b.close);
    const volRaw = Number(b.volume);
    const volume = Number.isFinite(volRaw) && volRaw >= 0 ? volRaw : 0;

    if (!Number.isFinite(time) || time < 631152000 || time > 2208988800) continue;
    if (time < minTs || time > maxTs) continue;
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(highRaw) ||
      !Number.isFinite(lowRaw) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    if (open <= 0 || highRaw <= 0 || lowRaw <= 0 || close <= 0 || highRaw < lowRaw) continue;

    const high = Math.max(highRaw, open, close);
    const low = Math.min(lowRaw, open, close);
    map.set(time, { time, open, high, low, close, volume });
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export function getWeekMondayKey(dayMidnightTs: number): number {
  const d = new Date(dayMidnightTs * 1000);
  const day = d.getUTCDay();
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day === 0 ? 6 : day - 1)) / 1000,
  );
}

export function getMonthFirstKey(dayMidnightTs: number): number {
  const d = new Date(dayMidnightTs * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

export function getTfWindowStart(reqStart: number, tf: Timeframe): number {
  if (tf === 'W1') return getWeekMondayKey(reqStart);
  if (tf === 'MN1') return getMonthFirstKey(reqStart);
  return reqStart;
}

export function aggregateBars(bars: Candle[], bucketSec: number): Candle[] {
  if (!bars || !bars.length || bucketSec <= 0) return [];
  const map = new Map<number, Candle>();
  for (const b of sanitizeBars(bars)) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        time: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      });
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export function buildCalendarBarsFromDaily(d1Bars: Candle[], mode: 'W1' | 'MN1'): Candle[] {
  if (!d1Bars || !d1Bars.length) return [];
  const map = new Map<number, Candle>();
  for (const b of sanitizeBars(d1Bars)) {
    const key = mode === 'W1' ? getWeekMondayKey(b.time) : getMonthFirstKey(b.time);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        time: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      });
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export function mergeBarLists(
  primaryBars: Candle[] | undefined,
  secondaryBars: Candle[] | undefined,
  preferPrimary = true,
): Candle[] {
  const map = new Map<number, Candle>();
  const first = preferPrimary ? secondaryBars : primaryBars;
  const second = preferPrimary ? primaryBars : secondaryBars;
  for (const b of sanitizeBars(first || [])) map.set(b.time, b);
  for (const b of sanitizeBars(second || [])) map.set(b.time, b);
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export function checkPriceCompatibility(
  baseBars: Candle[] | undefined,
  patchBars: Candle[] | undefined,
  maxRelDiff = 0.002,
): { compatible: boolean; relDiff: number } {
  if (!baseBars?.length || !patchBars?.length) return { compatible: true, relDiff: 0 };
  const patchMap = new Map<number, Candle>();
  for (const b of patchBars) patchMap.set(b.time, b);

  const diffs: number[] = [];
  for (const b of baseBars) {
    const match = patchMap.get(b.time);
    if (match && b.close > 0) {
      diffs.push(Math.abs(match.close - b.close) / b.close);
      if (diffs.length >= 30) break;
    }
  }
  if (!diffs.length) {
    for (const anchor of [baseBars[0], baseBars[baseBars.length - 1]]) {
      let best: Candle | null = null;
      let bestDist = 4 * 86400;
      for (const p of patchBars) {
        const dist = Math.abs(p.time - anchor.time);
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      if (best && anchor.close > 0) {
        diffs.push(Math.abs(best.close - anchor.close) / anchor.close);
      }
    }
  }
  if (!diffs.length) return { compatible: true, relDiff: 0 };
  diffs.sort((a, b) => a - b);
  const medianDiff = diffs[Math.floor(diffs.length / 2)];
  return { compatible: medianDiff <= maxRelDiff, relDiff: medianDiff };
}

export function checkCrossTfBasisCompatibility(
  refBars: Candle[] | undefined,
  refTf: Timeframe,
  candBars: Candle[] | undefined,
  candTf: Timeframe,
  maxRelDiff = 0.008,
): { compatible: boolean; relDiff: number } {
  if (!refBars?.length || !candBars?.length) return { compatible: true, relDiff: 0 };
  if (refTf === candTf) return checkPriceCompatibility(refBars, candBars, Math.min(maxRelDiff, 0.002));

  const refSec = TF_SECONDS[refTf] || 86400;
  const candSec = TF_SECONDS[candTf] || 900;

  // Compare intraday bars against daily/weekly/monthly reference using same-period aggregates or opening price
  if (refSec > candSec) {
    if (refTf === 'D1') {
      const candDaily = aggregateBars(candBars, 86400);
      const refMap = new Map<number, Candle>();
      for (const b of refBars) refMap.set(b.time, b);
      const diffs: number[] = [];
      for (const cd of candDaily) {
        const rb = refMap.get(cd.time);
        if (rb && rb.close > 0) {
          diffs.push(Math.abs(cd.close - rb.close) / rb.close);
          diffs.push(Math.abs(cd.open - rb.open) / rb.open);
        }
      }
      if (diffs.length) {
        diffs.sort((a, b) => a - b);
        const med = diffs[Math.floor(diffs.length / 2)];
        return { compatible: med <= maxRelDiff, relDiff: med };
      }
    } else if (refTf !== 'W1' && refTf !== 'MN1') {
      const agg = aggregateBars(candBars, refSec);
      const res = checkPriceCompatibility(refBars, agg, maxRelDiff);
      if (res.relDiff > 0 || res.compatible) return res;
    }
  } else {
    if (candTf === 'D1') {
      const refDaily = aggregateBars(refBars, 86400);
      return checkPriceCompatibility(refDaily, candBars, maxRelDiff);
    } else if (candTf !== 'W1' && candTf !== 'MN1') {
      const agg = aggregateBars(refBars, candSec);
      return checkPriceCompatibility(agg, candBars, maxRelDiff);
    }
  }

  // Fallback: compare closest bar in time (or overall median closes within same window)
  const rLast = refBars[refBars.length - 1];
  const cLast = candBars[candBars.length - 1];
  if (Math.abs(rLast.time - cLast.time) <= 7 * 86400 && rLast.close > 0) {
    const relDiff = Math.abs(cLast.close - rLast.close) / rLast.close;
    return { compatible: relDiff <= maxRelDiff * 1.5, relDiff };
  }
  return { compatible: true, relDiff: 0 };
}

/**
 * Counts approximate TradFi market-open hours in [fromSec, toSec],
 * excluding Friday 22:00 UTC -> Sunday 22:00 UTC (48h weekend).
 */
export function countTradFiTradingHours(fromSec: number, toSec: number): number {
  if (toSec <= fromSec) return 0;
  const totalSec = toSec - fromSec;
  if (totalSec > 45 * 86400) {
    return (totalSec / 3600) * (5 / 7);
  }
  // Iterate hour-by-hour in chunks of 3600s for exact weekday coverage on ranges <= 45 days
  let openHours = 0;
  for (let t = fromSec; t < toSec; t += 3600) {
    const step = Math.min(3600, toSec - t);
    const d = new Date((t + step * 0.5) * 1000);
    const wd = d.getUTCDay();
    const hr = d.getUTCHours();
    const isWeekendClosed =
      wd === 6 ||
      (wd === 5 && hr >= 22) ||
      (wd === 0 && hr < 22);
    if (!isWeekendClosed) openHours += step / 3600;
  }
  return openHours;
}

export function getEffectiveMarketStart(reqStart: number, is247: boolean): number {
  if (is247) return reqStart;
  const wd = new Date(reqStart * 1000).getUTCDay();
  if (wd === 6) return reqStart + 2 * 86400;
  if (wd === 0) return reqStart + 86400;
  return reqStart;
}

export function getEffectiveMarketEnd(reqEnd: number, is247: boolean, tf: Timeframe = 'M15'): number {
  if (is247) return reqEnd;
  const d = new Date(reqEnd * 1000);
  const wd = d.getUTCDay();
  if (wd === 6) {
    return Math.floor(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, tf === 'D1' ? 0 : 21, 0, 0) / 1000,
    );
  }
  if (wd === 0 && d.getUTCHours() < 22) {
    return Math.floor(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, tf === 'D1' ? 0 : 21, 0, 0) / 1000,
    );
  }
  return reqEnd;
}

export function computeMissingRanges(
  bars: Candle[] | undefined,
  tf: Timeframe,
  reqStart: number,
  reqEnd: number,
  is247: boolean,
  extraBrokenRanges: Array<[number, number]> = [],
): Array<[number, number]> {
  const effStart = getEffectiveMarketStart(reqStart, is247);
  const effEnd = getEffectiveMarketEnd(reqEnd, is247, tf);
  if (effStart >= effEnd) return [];
  if (!bars || !bars.length) return [[reqStart, reqEnd]];

  const sorted = sanitizeBars(bars);
  if (!sorted.length) return [[reqStart, reqEnd]];

  const tfSec = TF_SECONDS[tf] || 900;
  const gaps: Array<[number, number]> = [];

  if (tf === 'W1' || tf === 'MN1') {
    const edgeTol = tf === 'W1' ? 10 * 86400 : 35 * 86400;
    if (sorted[0].time - effStart > edgeTol) {
      gaps.push([reqStart, Math.min(reqEnd, sorted[0].time - tfSec)]);
    }
    const lastTime = sorted[sorted.length - 1].time;
    if (effEnd - lastTime > edgeTol) {
      gaps.push([Math.max(reqStart, lastTime + tfSec), reqEnd]);
    }
  } else if (is247) {
    const startTol = Math.max(43200, tfSec * 6);
    const endTol = Math.max(21600, tfSec * 6);
    if (sorted[0].time - effStart > startTol) {
      gaps.push([reqStart, Math.min(reqEnd, sorted[0].time - tfSec)]);
    }
    const internalTol = Math.max(tfSec * 8, 4 * 3600);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].time - sorted[i - 1].time > internalTol) {
        const gs = Math.max(reqStart, sorted[i - 1].time + tfSec);
        const ge = Math.min(reqEnd, sorted[i].time - tfSec);
        if (ge > gs) gaps.push([gs, ge]);
      }
    }
    const lastTime = sorted[sorted.length - 1].time;
    if (effEnd - lastTime > endTol) {
      gaps.push([Math.max(reqStart, lastTime + tfSec), reqEnd]);
    }
  } else {
    // TradFi: ignore weekends (Fri 22:00 UTC -> Sun 22:00 UTC) and check real trading hours
    const maxEdgeHours = tf === 'D1' ? 40 : tf === 'H4' ? 20 : 14;
    if (countTradFiTradingHours(effStart, sorted[0].time) > maxEdgeHours) {
      gaps.push([reqStart, Math.min(reqEnd, sorted[0].time - tfSec)]);
    }
    const maxInternalHours = tf === 'D1' ? 52 : 20;
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i].time - sorted[i - 1].time;
      if (diff > Math.max(tfSec * 6, 43200) && countTradFiTradingHours(sorted[i - 1].time, sorted[i].time) > maxInternalHours) {
        const gs = Math.max(reqStart, sorted[i - 1].time + tfSec);
        const ge = Math.min(reqEnd, sorted[i].time - tfSec);
        if (ge > gs) gaps.push([gs, ge]);
      }
    }
    const lastTime = sorted[sorted.length - 1].time;
    if (countTradFiTradingHours(lastTime, effEnd) > maxEdgeHours) {
      gaps.push([Math.max(reqStart, lastTime + tfSec), reqEnd]);
    }
  }

  for (const r of extraBrokenRanges) {
    if (r && r[1] > r[0]) {
      gaps.push([Math.max(reqStart, r[0] - tfSec), Math.min(reqEnd, r[1] + tfSec)]);
    }
  }

  if (gaps.length <= 1) return gaps.filter(([a, b]) => b > a);
  gaps.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [gaps[0].slice() as [number, number]];
  for (let i = 1; i < gaps.length; i++) {
    const prev = merged[merged.length - 1];
    if (gaps[i][0] <= prev[1] + 86400) {
      prev[1] = Math.max(prev[1], gaps[i][1]);
    } else {
      merged.push(gaps[i].slice() as [number, number]);
    }
  }
  return merged.filter(([a, b]) => b > a);
}

export function assessTfCoverage(
  tf: Timeframe,
  bars: Candle[] | undefined,
  reqStart: number,
  reqEnd: number,
  is247: boolean,
  sourceName: string,
  explicitIssue = '',
): TfMeta {
  if (!bars || !bars.length) {
    return {
      status: 'error',
      source: sourceName || '',
      note: explicitIssue || 'Bu aralıkta veri alınamadı',
    };
  }

  const gaps = computeMissingRanges(bars, tf, reqStart, reqEnd, is247);
  if (gaps.length > 0 && tf !== 'W1' && tf !== 'MN1') {
    const baseMsg = `Kısmi veri (${sourceName}: ${shortDateUtc(bars[0].time, true)}–${shortDateUtc(bars[bars.length - 1].time, true)})`;
    return {
      status: 'partial',
      source: sourceName,
      note: explicitIssue ? `${baseMsg} • ${explicitIssue}` : baseMsg,
    };
  }
  if (explicitIssue) {
    return { status: 'partial', source: sourceName, note: explicitIssue };
  }
  return { status: 'ok', source: sourceName, note: 'Tam aralık' };
}

export function normalizeTf(raw: string): Timeframe | '' {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const map: Record<string, Timeframe> = {
    M1: 'M1',
    '1M': 'M1',
    '1MIN': 'M1',
    M3: 'M3',
    '3M': 'M3',
    '3MIN': 'M3',
    M5: 'M5',
    '5M': 'M5',
    '5MIN': 'M5',
    M15: 'M15',
    '15M': 'M15',
    '15MIN': 'M15',
    M30: 'M30',
    '30M': 'M30',
    '30MIN': 'M30',
    H1: 'H1',
    '1H': 'H1',
    '60M': 'H1',
    '60': 'H1',
    '1HOUR': 'H1',
    H2: 'H2',
    '2H': 'H2',
    '120M': 'H2',
    '120': 'H2',
    '2HOUR': 'H2',
    H4: 'H4',
    '4H': 'H4',
    '240M': 'H4',
    '240': 'H4',
    '4HOUR': 'H4',
    D1: 'D1',
    '1D': 'D1',
    '1DAY': 'D1',
    DAILY: 'D1',
    W1: 'W1',
    '1W': 'W1',
    '1WK': 'W1',
    '1WEEK': 'W1',
    MN1: 'MN1',
    '1MO': 'MN1',
    '1MONTH': 'MN1',
  };
  return map[s] || '';
}

export function inferTfFromFilename(name: string): Timeframe | '' {
  const up = String(name || '').toUpperCase();
  const order: Timeframe[] = ['MN1', 'M30', 'M15', 'M5', 'M3', 'M1', 'H4', 'H2', 'H1', 'D1', 'W1'];
  for (const tf of order) {
    if (new RegExp(`(^|[^A-Z0-9])${tf}([^A-Z0-9]|$)`).test(up)) return tf;
  }
  return '';
}

export function inferSymbolFromFilename(name: string): string {
  const up = String(name || '').toUpperCase();
  for (const sym of Object.keys(PAIRS)) {
    if (up.includes(sym)) return sym;
  }
  const aliases: Record<string, string> = {
    DAX: 'GER40',
    GER30: 'GER40',
    FTSE: 'UK100',
    WTI: 'USOIL',
    BRENT: 'UKOIL',
    BTCUSDT: 'BTCUSD',
    ETHUSDT: 'ETHUSD',
    SOLUSDT: 'SOLUSD',
    XRPUSDT: 'XRPUSD',
    BNBUSDT: 'BNBUSD',
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (up.includes(k)) return v;
  }
  return '';
}

export function detectBaseTf(candles: Candle[]): Timeframe {
  if (!candles || candles.length < 2) return 'M15';
  const counts = new Map<number, number>();
  for (let i = 1; i < Math.min(candles.length, 150); i++) {
    const d = candles[i].time - candles[i - 1].time;
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let bestDiff = 900;
  let bestCnt = -1;
  for (const [d, c] of counts.entries()) {
    if (c > bestCnt || (c === bestCnt && d < bestDiff)) {
      bestCnt = c;
      bestDiff = d;
    }
  }
  if (bestDiff <= 90) return 'M1';
  if (bestDiff <= 210) return 'M3';
  if (bestDiff <= 450) return 'M5';
  if (bestDiff <= 1200) return 'M15';
  if (bestDiff <= 2400) return 'M30';
  if (bestDiff <= 5400) return 'H1';
  if (bestDiff <= 10800) return 'H2';
  if (bestDiff <= 36000) return 'H4';
  if (bestDiff <= 259200) return 'D1';
  if (bestDiff <= 1296000) return 'W1';
  return 'MN1';
}

const tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function getTzParts(ts: number, tz: string) {
  if (!tzFmtCache.has(tz)) {
    tzFmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      }),
    );
  }
  const out: Record<string, string> = {};
  for (const p of tzFmtCache.get(tz)!.formatToParts(new Date(ts * 1000))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second || 0),
    weekday: out.weekday,
  };
}

export function parseTzDateTimeToUtcSec(dateTimeStr: string, tz = 'UTC'): number | null {
  const m = String(dateTimeStr || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  if (!h) return Math.floor(Date.UTC(+y, +mo - 1, +d, 0, 0, 0) / 1000);
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  if (!tz || tz === 'UTC') return Math.floor(naiveUtcMs / 1000);
  try {
    const p = getTzParts(Math.floor(naiveUtcMs / 1000), tz);
    const tzRenderedMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetMs = tzRenderedMs - naiveUtcMs;
    return Math.floor((naiveUtcMs - offsetMs) / 1000);
  } catch {
    return Math.floor(naiveUtcMs / 1000);
  }
}

export function toExchangeDateMidnight(ts: number, gmtoffsetSec = 0, exchangeTz = ''): number {
  if (exchangeTz) {
    try {
      let p = getTzParts(ts, exchangeTz);
      if (p.hour >= 22 && p.minute === 0 && p.weekday !== 'Fri' && p.weekday !== 'Sat') {
        p = getTzParts(ts + 7200, exchangeTz);
      }
      return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 1000);
    } catch {
      // fallback below
    }
  }
  const localTs = ts + (Number.isFinite(gmtoffsetSec) ? gmtoffsetSec : 0);
  const d = new Date(localTs * 1000);
  const wd = d.getUTCDay();
  if (d.getUTCHours() >= 22 && d.getUTCMinutes() === 0 && wd !== 5 && wd !== 6) {
    const next = new Date((localTs + 7200) * 1000);
    return Math.floor(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()) / 1000);
  }
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export function parseTimeSec(raw: string): number | null {
  const s = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const m = s.match(
    /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i,
  );
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', tz] = m;
    if (tz) {
      const ms = Date.parse(`${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(se)}${tz}`);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    return Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000);
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function parseSingleOrMergedCsv(text: string, filename = '') {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    return { byTf: {} as Partial<Record<Timeframe, Candle[]>>, lockedSymbol: '', symbolsFound: [] as string[], droppedRows: 0 };
  }

  const delim = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const head = lines[0].split(delim).map((c) => c.trim().replace(/^["'<]+|["'>]+$/g, '').toLowerCase());
  const hasHeader = head.some((h) =>
    ['symbol', 'timeframe', 'time', 'date', 'open', 'high', 'low', 'close'].includes(h),
  );

  let symIdx = -1;
  let tfIdx = -1;
  let dateIdx = -1;
  let timeIdx = -1;
  let oIdx = 0;
  let hIdx = 1;
  let lIdx = 2;
  let cIdx = 3;
  let vIdx = -1;
  let startRow = 0;

  if (hasHeader) {
    startRow = 1;
    symIdx = head.findIndex((h) => h === 'symbol' || h === 'pair' || h === 'ticker');
    tfIdx = head.findIndex((h) => h === 'timeframe' || h === 'tf' || h === 'interval');
    dateIdx = head.indexOf('date');
    timeIdx = head.findIndex((h) => h === 'time' || h === 'datetime' || h === 'timestamp');
    if (timeIdx === -1 && dateIdx !== -1) {
      timeIdx = dateIdx;
      dateIdx = -1;
    }
    oIdx = head.indexOf('open');
    hIdx = head.indexOf('high');
    lIdx = head.indexOf('low');
    cIdx = head.indexOf('close');
    vIdx = head.findIndex((h) => h === 'volume' || h === 'tickvol' || h === 'vol');
  } else {
    timeIdx = 0;
    oIdx = 1;
    hIdx = 2;
    lIdx = 3;
    cIdx = 4;
    vIdx = lines[0].split(delim).length > 5 ? 5 : -1;
  }

  if (hasHeader && (timeIdx < 0 || oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0)) {
    return { byTf: {} as Partial<Record<Timeframe, Candle[]>>, lockedSymbol: '', symbolsFound: [] as string[], droppedRows: 0 };
  }

  const tfMaps: Record<string, Map<number, Candle>> = {};
  const symbolsSet = new Set<string>();
  let lockedSymbol = '';
  let droppedRows = 0;

  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length <= Math.max(symIdx, tfIdx, dateIdx, timeIdx, oIdx, hIdx, lIdx, cIdx)) continue;
    if (symIdx !== -1) {
      const rowSym = (cols[symIdx] || '').trim().toUpperCase();
      if (rowSym) {
        symbolsSet.add(rowSym);
        if (!lockedSymbol) lockedSymbol = rowSym;
        if (rowSym !== lockedSymbol) {
          droppedRows++;
          continue;
        }
      }
    }
    const rawTf = tfIdx !== -1 ? normalizeTf(cols[tfIdx]) : '';
    const tfKey = rawTf || '__AUTO__';
    const time = parseTimeSec(dateIdx !== -1 ? `${cols[dateIdx]} ${cols[timeIdx]}` : cols[timeIdx]);
    const open = Number(cols[oIdx]);
    const high = Number(cols[hIdx]);
    const low = Number(cols[lIdx]);
    const close = Number(cols[cIdx]);
    const volume = vIdx !== -1 ? Number(cols[vIdx]) || 0 : 0;

    if (time === null || !Number.isFinite(time) || open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) {
      continue;
    }
    if (!tfMaps[tfKey]) tfMaps[tfKey] = new Map();
    tfMaps[tfKey].set(time, { time, open, high, low, close, volume });
  }

  const byTf: Partial<Record<Timeframe, Candle[]>> = {};
  for (const k of Object.keys(tfMaps)) {
    const arr = sanitizeBars(Array.from(tfMaps[k].values()));
    if (!arr.length) continue;
    const resolvedTf: Timeframe = k === '__AUTO__' ? inferTfFromFilename(filename) || detectBaseTf(arr) : (k as Timeframe);
    byTf[resolvedTf] = mergeBarLists(byTf[resolvedTf], arr, true);
  }
  if (!lockedSymbol) lockedSymbol = inferSymbolFromFilename(filename);
  return { byTf, lockedSymbol, symbolsFound: Array.from(symbolsSet), droppedRows };
}

export function buildCsvHeader(includeVol: boolean): string {
  return includeVol
    ? 'symbol,timeframe,time,open,high,low,close,volume'
    : 'symbol,timeframe,time,open,high,low,close';
}

export function formatCsvRow(
  sym: string,
  tf: Timeframe,
  b: Candle,
  dec: number,
  includeVol: boolean,
  timeFmt: CsvTimeFormat = 'iso',
): string {
  const base = `${sym},${tf},${formatCsvTimestamp(b.time, timeFmt)},${b.open.toFixed(dec)},${b.high.toFixed(dec)},${b.low.toFixed(dec)},${b.close.toFixed(dec)}`;
  return includeVol ? `${base},${Math.round(b.volume || 0)}` : base;
}

export function buildSingleTfCsv(
  sym: string,
  tf: Timeframe,
  bars: Candle[],
  dec: number,
  includeVol: boolean,
  timeFmt: CsvTimeFormat = 'iso',
): string {
  const sorted = sanitizeBars(bars);
  const lines = [buildCsvHeader(includeVol)];
  for (const b of sorted) lines.push(formatCsvRow(sym, tf, b, dec, includeVol, timeFmt));
  return lines.join('\n');
}

export function buildMergedCsv(
  sym: string,
  tfMap: Partial<Record<Timeframe, Candle[]>>,
  dec: number,
  includeVol: boolean,
  timeFmt: CsvTimeFormat = 'iso',
  selectedTfs: Timeframe[] = ALL_TF_NAMES,
): string {
  const lines = [buildCsvHeader(includeVol)];
  for (const tf of ALL_TF_NAMES) {
    if (!selectedTfs.includes(tf)) continue;
    const bars = tfMap[tf];
    if (!bars || !bars.length) continue;
    const sorted = sanitizeBars(bars);
    for (const b of sorted) lines.push(formatCsvRow(sym, tf, b, dec, includeVol, timeFmt));
  }
  return lines.join('\n');
}

export function findIndexAtOrBefore(candles: Candle[], targetTime: number): number {
  if (!candles || !candles.length) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= targetTime) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function getCandleSpanSec(tf: Timeframe, ts: number): number {
  if (tf === 'MN1') {
    const d = new Date((ts + 43200) * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000) - ts;
  }
  return TF_SECONDS[tf] || 900;
}
