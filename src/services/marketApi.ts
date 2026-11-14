import {
  ALL_TF_NAMES,
  BINANCE_INTERVALS,
  BIQUOTE_INTERVALS,
  BITSTAMP_STEPS,
  BYBIT_INTERVALS,
  COINBASE_GRANULARITY,
  FMP_INTERVALS,
  KRAKEN_INTERVALS,
  OKX_INTERVALS,
  PAIRS,
  STORAGE_KEYS,
  TD_INTERVALS,
  TF_SECONDS,
  TIINGO_INTERVALS,
} from '../data/pairs';
import type {
  AppSettings,
  Candle,
  CfdPriorityPref,
  CryptoProviderPref,
  CsvTimeFormat,
  FetchProgress,
  PairConfig,
  TfMeta,
  Timeframe,
} from '../types/market';
import {
  aggregateBars,
  assessTfCoverage,
  buildCalendarBarsFromDaily,
  checkCrossTfBasisCompatibility,
  checkPriceCompatibility,
  computeMissingRanges,
  getTfWindowStart,
  isoUtc,
  mergeBarLists,
  parseTzDateTimeToUtcSec,
  sanitizeBars,
  toExchangeDateMidnight,
  toYMD,
} from '../utils/candles';

export class FetchCancelledError extends Error {
  constructor() {
    super('İşlem kullanıcı tarafından durduruldu');
  }
}

export function getSettings(): AppSettings {
  const cfdRaw = localStorage.getItem(STORAGE_KEYS.cfdPriority) || 'smart';
  const validCfd: CfdPriorityPref[] = ['smart', 'tiingo', 'twelvedata', 'yahoo', 'free'];
  const cfdPriority: CfdPriorityPref = validCfd.includes(cfdRaw as CfdPriorityPref)
    ? (cfdRaw as CfdPriorityPref)
    : cfdRaw === 'auto'
      ? 'smart'
      : 'smart';

  const cryptoRaw = localStorage.getItem(STORAGE_KEYS.cryptoProvider) || 'auto';
  const validCrypto: CryptoProviderPref[] = [
    'auto',
    'binance',
    'okx',
    'bybit',
    'coinbase',
    'kraken',
    'bitstamp',
  ];
  const cryptoProvider: CryptoProviderPref = validCrypto.includes(cryptoRaw as CryptoProviderPref)
    ? (cryptoRaw as CryptoProviderPref)
    : 'auto';

  const fmtRaw = localStorage.getItem(STORAGE_KEYS.csvTimeFormat) || 'iso';
  const csvTimeFormat: CsvTimeFormat =
    fmtRaw === 'unix' || fmtRaw === 'ymdhm' ? fmtRaw : 'iso';

  return {
    tdKey: (localStorage.getItem(STORAGE_KEYS.tdKey) || '').trim(),
    tiingoKey: (localStorage.getItem(STORAGE_KEYS.tiingoKey) || '').trim(),
    fmpKey: (localStorage.getItem(STORAGE_KEYS.fmpKey) || '').trim(),
    cryptoProvider,
    cfdPriority,
    includeVol: localStorage.getItem(STORAGE_KEYS.includeVol) !== '0',
    csvTimeFormat,
  };
}

export function humanizeProviderError(prov: string, rawMsg: string, pairCode: string): string {
  const m = String(rawMsg || '').replace(/\*+/g, '').trim();
  if (prov === 'twelvedata') {
    if (/grow|pro|ultra|plan|upgrade|permission|available starting|not available on|symbol or figi/i.test(m)) {
      return `Twelve Data ücretsiz planda ${pairCode} desteklemiyor`;
    }
    if (/daily|per day/i.test(m)) return 'Twelve Data günlük kredi limiti (800/gün) doldu';
    if (/apikey|api key|unauthorized/i.test(m)) return 'Twelve Data API anahtarı geçersiz';
    if (/credits|minute|limit/i.test(m)) return 'Twelve Data dakikalık limiti (8/dk) doldu';
  }
  if (prov === 'tiingo') {
    if (/allocation|limit|exceeded|throttled|429/i.test(m)) return 'Tiingo saatlik/günlük limiti doldu';
    if (/token|authorization|401|403/i.test(m)) return 'Tiingo API token geçersiz';
  }
  if (prov === 'fmp') {
    if (/upgrade|plan|premium|subscription|restricted|exclusive|402|403/i.test(m)) {
      return `FMP ücretsiz planda ${pairCode} desteklemiyor`;
    }
    if (/invalid api key|unauthorized|401/i.test(m)) return 'FMP API anahtarı geçersiz';
    if (/limit|429/i.test(m)) return 'FMP günlük limiti doldu';
  }
  return m;
}

class HttpApiError extends Error {
  httpStatus?: number;
  parsedBody?: unknown;
  isYahooApi?: boolean;
  isYahooEmpty?: boolean;
  tiingoBlocked?: boolean;
  tdPlanRestricted?: boolean;
  tdAuthError?: boolean;
  tdDailyLimit?: boolean;
}

async function fetchJsonRaw(url: string, timeoutMs = 15000, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // non-json response
    }
    if (!res.ok) {
      const chartErr = (parsed?.chart as { error?: { description?: string } } | undefined)?.error?.description;
      const detail =
        chartErr ||
        (parsed?.detail as string | undefined) ||
        (parsed?.message as string | undefined) ||
        (parsed?.msg as string | undefined) ||
        (parsed?.['Error Message'] as string | undefined) ||
        (parsed?.error as string | undefined) ||
        `HTTP ${res.status}`;
      const err = new HttpApiError(detail);
      err.httpStatus = res.status;
      err.parsedBody = parsed;
      throw err;
    }
    if (parsed === null) throw new HttpApiError('Geçersiz JSON yanıtı');
    return parsed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchApiJson(
  targetUrl: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new FetchCancelledError();
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  try {
    return await fetchJsonRaw(proxyUrl, timeoutMs, signal);
  } catch (err) {
    if (signal?.aborted) throw new FetchCancelledError();
    const apiErr = err as HttpApiError;
    // If the backend proxy exists and upstream returned a real HTTP error, propagate it directly.
    if (apiErr.httpStatus && apiErr.httpStatus !== 404 && apiErr.httpStatus !== 502) {
      throw apiErr;
    }
    // Fallback to direct browser fetch if running statically without Express /api/proxy
    try {
      return await fetchJsonRaw(targetUrl, timeoutMs, signal);
    } catch {
      throw apiErr;
    }
  }
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      if (signal?.aborted) return;
      const current = idx++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function sleepAbortable(ms: number, signal?: AbortSignal, onTick?: (remSec: number) => void): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal?.aborted) return false;
    const rem = Math.ceil((end - Date.now()) / 1000);
    onTick?.(rem);
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, end - Date.now()))));
  }
  return !signal?.aborted;
}

// ============================================================================
// YAHOO FINANCE
// ============================================================================

interface YahooChartResult {
  timestamp?: number[];
  meta?: { gmtoffset?: number; exchangeTimezoneName?: string };
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

async function fetchYahooChart(
  ticker: string,
  interval: string,
  p1: number,
  p2: number,
  signal?: AbortSignal,
): Promise<YahooChartResult> {
  const qs = `period1=${p1}&period2=${p2}&interval=${encodeURIComponent(interval)}&includePrePost=true`;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr: unknown = null;

  for (const host of hosts) {
    if (signal?.aborted) throw new FetchCancelledError();
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${qs}`;
    try {
      const json = (await fetchApiJson(url, 15000, signal)) as {
        chart?: { error?: { description?: string }; result?: YahooChartResult[] };
      };
      if (json?.chart?.error) {
        const err = new HttpApiError(json.chart.error.description || 'Yahoo API hatası');
        err.isYahooApi = true;
        throw err;
      }
      const res = json?.chart?.result?.[0];
      if (!res || !Array.isArray(res.timestamp) || !res.timestamp.length) {
        const err = new HttpApiError('Boş veri');
        err.isYahooEmpty = true;
        throw err;
      }
      return res;
    } catch (e) {
      const apiErr = e as HttpApiError;
      lastErr = apiErr;
      if (apiErr.isYahooApi || apiErr.isYahooEmpty || apiErr.httpStatus === 404 || apiErr.httpStatus === 400) {
        throw apiErr;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Yahoo Finance erişilemedi');
}

function extractYahooBars(
  res: YahooChartResult,
  minTs: number,
  maxTs: number,
  isDaily = false,
  intervalSec = 0,
): Candle[] {
  const tsArr = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const gmtoffset = Number(res.meta?.gmtoffset) || 0;
  const exchangeTz = res.meta?.exchangeTimezoneName || '';

  let h1Phase = 0;
  if (!isDaily && intervalSec === 3600) {
    let halfHourCount = 0;
    let wholeHourCount = 0;
    for (const t of tsArr) {
      if (!Number.isFinite(t) || t % 60 !== 0) continue;
      if (t % 3600 === 1800) halfHourCount++;
      else if (t % 3600 === 0) wholeHourCount++;
    }
    if (halfHourCount > wholeHourCount) h1Phase = 1800;
  }

  const map = new Map<number, Candle>();
  for (let i = 0; i < tsArr.length; i++) {
    let time = tsArr[i];
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    const volume = q.volume?.[i];

    if (
      typeof time !== 'number' ||
      typeof open !== 'number' ||
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof close !== 'number'
    ) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) continue;

    if (isDaily) {
      time = toExchangeDateMidnight(time, gmtoffset, exchangeTz);
    } else if (intervalSec > 0 && (time % 60 !== 0 || (time - h1Phase) % intervalSec !== 0)) {
      time = Math.floor((time - h1Phase) / intervalSec) * intervalSec + h1Phase;
    }

    if (time < minTs || time > maxTs) continue;
    const vol = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 ? volume : 0;
    const prev = map.get(time);
    if (!prev) {
      map.set(time, {
        time,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: vol,
      });
    } else {
      prev.high = Math.max(prev.high, high, open, close);
      prev.low = Math.min(prev.low, low, open, close);
      prev.close = close;
      prev.volume = isDaily ? Math.max(prev.volume, vol) : prev.volume + vol;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

async function fetchYahoo1mStitched(
  ticker: string,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<{ bars: Candle[]; failedRanges: Array<[number, number]> }> {
  const chunkSec = 6 * 86400;
  const chunks: Array<[number, number]> = [];
  for (let cursor = startSec; cursor < endSec; cursor += chunkSec) {
    chunks.push([cursor, Math.min(cursor + chunkSec, endSec)]);
  }

  const merged = new Map<number, Candle>();
  const failedRanges: Array<[number, number]> = [];

  await runWithConcurrency(
    chunks.map(([rawS, e]) => async () => {
      let s = rawS;
      let ok = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) return;
        try {
          const res = await fetchYahooChart(ticker, '1m', s, e + 60, signal);
          const bars = extractYahooBars(res, s, e, false, 60);
          for (const bar of bars) merged.set(bar.time, bar);
          ok = bars.length > 0;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (/within the last|not available for startTime/i.test(msg)) {
            s = Math.min(e - 3600, s + 86400);
            continue;
          }
          break;
        }
      }
      if (!ok) failedRanges.push([s, e]);
    }),
    3,
    signal,
  );

  return { bars: sanitizeBars(Array.from(merged.values())), failedRanges };
}

async function fetchYahooIntraday(
  ticker: string,
  yInt: string,
  sec: number,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  let s = startSec;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return [];
    try {
      const res = await fetchYahooChart(ticker, yInt, s, endSec + 60, signal);
      return extractYahooBars(res, s, endSec, false, sec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/within the last|not available for startTime/i.test(msg)) {
        s = Math.min(endSec - 3600, s + 2 * 86400);
        continue;
      }
      throw err;
    }
  }
  return [];
}

async function fetchYahooH1(
  ticker: string,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const span = endSec - startSec;
  if (span <= 190 * 86400) {
    return await fetchYahooIntraday(ticker, '1h', 3600, startSec, endSec, signal);
  }
  const chunkSec = 180 * 86400;
  const chunks: Array<[number, number]> = [];
  for (let cursor = startSec; cursor < endSec; cursor += chunkSec + 1) {
    chunks.push([cursor, Math.min(endSec, cursor + chunkSec)]);
  }
  const map = new Map<number, Candle>();
  await runWithConcurrency(
    chunks.map(([s, e]) => async () => {
      try {
        const bars = await fetchYahooIntraday(ticker, '1h', 3600, s, e, signal);
        for (const b of bars) map.set(b.time, b);
      } catch {
        // ignore single chunk fail
      }
    }),
    3,
    signal,
  );
  return sanitizeBars(Array.from(map.values()));
}

// ============================================================================
// BITSTAMP & KRAKEN (KEYLESS FOREX + CRYPTO WITH REAL VOLUME)
// ============================================================================

async function fetchBitstampRange(
  bsSym: string,
  stepSec: number,
  reqStart: number,
  reqEnd: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const spanPerReq = stepSec * 950;
  const chunks: Array<[number, number]> = [];
  for (let cursor = reqStart; cursor <= reqEnd; cursor += spanPerReq) {
    chunks.push([cursor, Math.min(reqEnd, cursor + spanPerReq - 1)]);
  }

  const map = new Map<number, Candle>();
  await runWithConcurrency(
    chunks.slice(0, 60).map(([s, e]) => async () => {
      if (signal?.aborted) return;
      const url = `https://www.bitstamp.net/api/v2/ohlc/${encodeURIComponent(bsSym)}/?step=${stepSec}&start=${s}&end=${e}&limit=1000`;
      try {
        const json = (await fetchApiJson(url, 12000, signal)) as {
          data?: { ohlc?: Array<{ timestamp: string; open: string; high: string; low: string; close: string; volume: string }> };
        };
        const rows = json?.data?.ohlc || [];
        for (const r of rows) {
          const time = Number(r.timestamp);
          if (time >= reqStart && time <= reqEnd) {
            map.set(time, {
              time,
              open: Number(r.open),
              high: Number(r.high),
              low: Number(r.low),
              close: Number(r.close),
              volume: Number(r.volume) || 0,
            });
          }
        }
      } catch {
        // ignore chunk error
      }
    }),
    4,
    signal,
  );

  return sanitizeBars(Array.from(map.values()), reqStart, reqEnd);
}

async function fetchKrakenRange(
  krakenSym: string,
  intervalMin: number,
  reqStart: number,
  reqEnd: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(krakenSym)}&interval=${intervalMin}&since=${Math.max(0, reqStart - 60)}`;
  const json = (await fetchApiJson(url, 12000, signal)) as {
    error?: string[];
    result?: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
  };
  if (json?.error?.length) throw new Error(json.error.join(', '));
  const result = json?.result || {};
  const pairKey = Object.keys(result).find((k) => k !== 'last');
  if (!pairKey || !Array.isArray(result[pairKey])) return [];

  const bars: Candle[] = [];
  for (const r of result[pairKey]) {
    const time = Number(r[0]);
    if (time >= reqStart && time <= reqEnd) {
      bars.push({
        time,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[6]) || 0,
      });
    }
  }
  return sanitizeBars(bars, reqStart, reqEnd);
}

// ============================================================================
// CRYPTO EXCHANGES (BINANCE, OKX, BYBIT, COINBASE) — PARALLEL CHUNKING
// ============================================================================

async function fetchBinanceRange(
  binanceSym: string,
  interval: string,
  intervalSec: number,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const hosts = ['https://data-api.binance.vision/api/v3/klines', 'https://api.binance.com/api/v3/klines'];
  const spanSec = intervalSec * 990;
  const chunks: Array<[number, number]> = [];
  for (let cursor = startSec; cursor <= endSec; cursor += spanSec) {
    chunks.push([cursor, Math.min(endSec, cursor + spanSec - 1)]);
  }

  const map = new Map<number, Candle>();
  await runWithConcurrency(
    chunks.map(([s, e]) => async () => {
      if (signal?.aborted) return;
      for (const host of hosts) {
        try {
          const url = `${host}?symbol=${encodeURIComponent(binanceSym)}&interval=${encodeURIComponent(interval)}&startTime=${s * 1000}&endTime=${e * 1000}&limit=1000`;
          const rows = (await fetchApiJson(url, 12000, signal)) as Array<[number, string, string, string, string, string]>;
          if (!Array.isArray(rows)) continue;
          for (const k of rows) {
            const time = Math.floor(Number(k[0]) / 1000);
            if (time >= startSec && time <= endSec) {
              map.set(time, {
                time,
                open: Number(k[1]),
                high: Number(k[2]),
                low: Number(k[3]),
                close: Number(k[4]),
                volume: Number(k[5]) || 0,
              });
            }
          }
          return;
        } catch {
          // try next host
        }
      }
    }),
    4,
    signal,
  );

  return sanitizeBars(Array.from(map.values()), startSec, endSec);
}

async function fetchOkxRange(
  okxSym: string,
  bar: string,
  intervalSec: number,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;
  const nowSec = Math.floor(Date.now() / 1000);
  const map = new Map<number, Candle>();
  let cursorMs = endMs + 1;

  if (endSec >= nowSec - intervalSec * 3) {
    try {
      const liveJson = (await fetchApiJson(
        `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(okxSym)}&bar=${encodeURIComponent(bar)}&limit=300`,
        12000,
        signal,
      )) as { code?: string; data?: string[][] };
      if (liveJson?.code === '0' && Array.isArray(liveJson.data)) {
        let minLive = Infinity;
        for (const r of liveJson.data) {
          const ms = Number(r[0]);
          const time = Math.floor(ms / 1000);
          if (time >= startSec && time <= endSec) {
            map.set(time, {
              time,
              open: Number(r[1]),
              high: Number(r[2]),
              low: Number(r[3]),
              close: Number(r[4]),
              volume: Number(r[5]) || 0,
            });
          }
          if (ms < minLive) minLive = ms;
        }
        if (Number.isFinite(minLive)) cursorMs = Math.min(cursorMs, minLive);
      }
    } catch {
      // ignore live pass error
    }
  }

  const maxPages = Math.min(400, Math.max(5, Math.ceil((endSec - startSec) / (intervalSec * 100)) + 4));
  for (let page = 0; page < maxPages && cursorMs > startMs; page++) {
    if (signal?.aborted) break;
    const json = (await fetchApiJson(
      `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(okxSym)}&bar=${encodeURIComponent(bar)}&after=${cursorMs}&limit=100`,
      12000,
      signal,
    )) as { code?: string; msg?: string; data?: string[][] };
    if (json?.code && json.code !== '0') throw new Error(json.msg || 'OKX API hatası');
    const rows = json?.data || [];
    if (!Array.isArray(rows) || !rows.length) break;
    let minPageMs = Infinity;
    for (const r of rows) {
      const ms = Number(r[0]);
      const time = Math.floor(ms / 1000);
      if (time >= startSec && time <= endSec) {
        map.set(time, {
          time,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]) || 0,
        });
      }
      if (ms < minPageMs) minPageMs = ms;
    }
    if (rows.length < 100 || !Number.isFinite(minPageMs) || minPageMs >= cursorMs || minPageMs <= startMs) break;
    cursorMs = minPageMs;
  }

  return sanitizeBars(Array.from(map.values()), startSec, endSec);
}

async function fetchBybitRange(
  bybitSym: string,
  bInt: string,
  intervalSec: number,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const spanSec = intervalSec * 980;
  const chunks: Array<[number, number]> = [];
  for (let cursor = startSec; cursor <= endSec; cursor += spanSec) {
    chunks.push([cursor, Math.min(endSec, cursor + spanSec - 1)]);
  }

  const map = new Map<number, Candle>();
  await runWithConcurrency(
    chunks.map(([s, e]) => async () => {
      if (signal?.aborted) return;
      const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(bybitSym)}&interval=${encodeURIComponent(bInt)}&start=${s * 1000}&end=${e * 1000}&limit=1000`;
      const json = (await fetchApiJson(url, 12000, signal)) as {
        retCode?: number;
        retMsg?: string;
        result?: { list?: string[][] };
      };
      if (json?.retCode !== 0) throw new Error(json?.retMsg || 'Bybit API hatası');
      for (const r of json?.result?.list || []) {
        const time = Math.floor(Number(r[0]) / 1000);
        if (time >= startSec && time <= endSec) {
          map.set(time, {
            time,
            open: Number(r[1]),
            high: Number(r[2]),
            low: Number(r[3]),
            close: Number(r[4]),
            volume: Number(r[5]) || 0,
          });
        }
      }
    }),
    4,
    signal,
  );

  return sanitizeBars(Array.from(map.values()), startSec, endSec);
}

async function fetchCoinbaseRange(
  cbSym: string,
  granSec: number,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const winSpan = granSec * 280;
  const chunks: Array<[number, number]> = [];
  for (let cursor = startSec; cursor <= endSec; cursor += winSpan) {
    chunks.push([cursor, Math.min(endSec, cursor + winSpan - 1)]);
  }

  const map = new Map<number, Candle>();
  await runWithConcurrency(
    chunks.slice(0, 120).map(([s, e]) => async () => {
      if (signal?.aborted) return;
      const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(cbSym)}/candles?granularity=${granSec}&start=${encodeURIComponent(isoUtc(s))}&end=${encodeURIComponent(isoUtc(e))}`;
      try {
        const rows = (await fetchApiJson(url, 12000, signal)) as number[][];
        if (!Array.isArray(rows)) return;
        for (const r of rows) {
          const time = Number(r[0]);
          if (time >= startSec && time <= endSec) {
            map.set(time, {
              time,
              open: Number(r[3]),
              high: Number(r[2]),
              low: Number(r[1]),
              close: Number(r[4]),
              volume: Number(r[5]) || 0,
            });
          }
        }
      } catch {
        // ignore chunk error
      }
    }),
    3,
    signal,
  );

  return sanitizeBars(Array.from(map.values()), startSec, endSec);
}

// ============================================================================
// BIQUOTE.IO, FRANKFURTER, TIINGO FX, TWELVE DATA, FMP
// ============================================================================

let biquoteSymbolsCache: Set<string> | null = null;

async function resolveBiquoteSymbol(pairCfg: PairConfig, signal?: AbortSignal): Promise<string | null> {
  if (!pairCfg.biquote) return null;
  if (!biquoteSymbolsCache) {
    try {
      const list = (await fetchApiJson('https://biquote.io/api/symbols?quotedWithinDays=30', 10000, signal)) as Array<{
        name?: string;
      }>;
      if (Array.isArray(list)) {
        biquoteSymbolsCache = new Set(list.map((x) => String(x.name || '').toUpperCase()));
      }
    } catch {
      biquoteSymbolsCache = new Set();
    }
  }
  const candidates = [pairCfg.biquote, ...(pairCfg.biquoteAlt || [])];
  if (biquoteSymbolsCache && biquoteSymbolsCache.size > 0) {
    for (const c of candidates) {
      if (biquoteSymbolsCache.has(c.toUpperCase())) return c;
    }
  }
  return candidates[0];
}

async function fetchBiquoteOhlcRange(
  pairCfg: PairConfig,
  tf: Timeframe,
  reqStart: number,
  reqEnd: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const bInt = BIQUOTE_INTERVALS[tf];
  if (!bInt) return [];
  const sym = await resolveBiquoteSymbol(pairCfg, signal);
  if (!sym) return [];

  const map = new Map<number, Candle>();
  let cursorEnd = reqEnd;
  for (let page = 0; page < 4 && cursorEnd > reqStart; page++) {
    if (signal?.aborted) break;
    const url = `https://biquote.io/api/${encodeURIComponent(sym)}/ohlc?interval=${encodeURIComponent(bInt)}&limit=1000&from=${encodeURIComponent(isoUtc(reqStart))}&to=${encodeURIComponent(isoUtc(cursorEnd))}`;
    const json = (await fetchApiJson(url, 12000, signal)) as {
      bars?: Array<{
        isOpen?: boolean;
        openTime: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number;
        tickVolume?: number;
      }>;
    };
    const rows = json?.bars || [];
    if (!Array.isArray(rows) || !rows.length) break;

    let minPageTs = Infinity;
    for (const r of rows) {
      if (r.isOpen) continue;
      const ms = Date.parse(r.openTime);
      const time = Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
      const open = Number(r.open);
      const high = Number(r.high);
      const low = Number(r.low);
      const close = Number(r.close);
      const volume = Number(r.volume) || Number(r.tickVolume) || 0;
      if (Number.isFinite(time) && open > 0 && high > 0 && low > 0 && close > 0 && high >= low) {
        if (time >= reqStart && time <= reqEnd) {
          map.set(time, {
            time,
            open,
            high: Math.max(high, open, close),
            low: Math.min(low, open, close),
            close,
            volume,
          });
        }
        if (time < minPageTs) minPageTs = time;
      }
    }
    if (rows.length < 950 || !Number.isFinite(minPageTs) || minPageTs >= cursorEnd) break;
    cursorEnd = minPageTs - 1;
  }
  return sanitizeBars(Array.from(map.values()), reqStart, reqEnd);
}

async function fetchFrankfurterFxDaily(
  pairCfg: PairConfig,
  startStr: string,
  endStr: string,
  reqStart: number,
  reqEnd: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  if (!pairCfg.fxBase || !pairCfg.fxQuote) return [];
  const path = startStr === endStr ? startStr : `${startStr}..${endStr}`;
  const url = `https://api.frankfurter.dev/v1/${path}?base=${encodeURIComponent(pairCfg.fxBase)}&symbols=${encodeURIComponent(pairCfg.fxQuote)}`;
  const json = (await fetchApiJson(url, 12000, signal)) as {
    date?: string;
    rates?: Record<string, number | Record<string, number>>;
  };
  const rates = json?.rates || {};
  const out: Candle[] = [];

  if (typeof rates[pairCfg.fxQuote] === 'number' && json.date) {
    const ts = Math.floor(Date.parse(`${json.date}T00:00:00Z`) / 1000);
    const v = Number(rates[pairCfg.fxQuote]);
    if (Number.isFinite(ts) && Number.isFinite(v)) {
      out.push({ time: ts, open: v, high: v, low: v, close: v, volume: 0 });
    }
  } else {
    for (const [dStr, obj] of Object.entries(rates)) {
      const rec = obj as Record<string, number>;
      const v = Number(rec?.[pairCfg.fxQuote]);
      const ts = Math.floor(Date.parse(`${dStr}T00:00:00Z`) / 1000);
      if (Number.isFinite(ts) && Number.isFinite(v)) {
        out.push({ time: ts, open: v, high: v, low: v, close: v, volume: 0 });
      }
    }
  }
  return sanitizeBars(out, reqStart, reqEnd);
}

async function fetchTiingoFxRange(
  tiingoSym: string,
  freq: string,
  reqStart: number,
  reqEnd: number,
  token: string,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<{ bars: Candle[]; issue: string; blocked: boolean }> {
  // Keep chunks under 5000 points so Tiingo never truncates rows silently!
  const chunkDaysMap: Record<string, number> = {
    '1min': 3,
    '3min': 9,
    '5min': 14,
    '15min': 42,
    '30min': 85,
    '1hour': 180,
    '2hour': 365,
    '4hour': 730,
    '1day': 1825,
  };
  const chunkSec = (chunkDaysMap[freq] || 30) * 86400;
  const map = new Map<number, Candle>();
  let cursor = freq === '1day' ? reqStart - 86400 : reqStart;
  let issue = '';
  let step = 0;
  let blocked = false;

  while (cursor <= reqEnd) {
    if (signal?.aborted) {
      issue = 'Kullanıcı tarafından durduruldu';
      break;
    }
    step++;
    onProgress?.(`Tiingo FX ${freq} (parça ${step})`);
    const next = Math.min(reqEnd, cursor + chunkSec - 1);
    const url = `https://api.tiingo.com/tiingo/fx/${encodeURIComponent(tiingoSym)}/prices?startDate=${toYMD(new Date(cursor * 1000))}&endDate=${toYMD(new Date((next + 86400) * 1000))}&resampleFreq=${encodeURIComponent(freq)}&token=${encodeURIComponent(token)}`;

    try {
      const rows = (await fetchApiJson(url, 15000, signal)) as Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
      if (!Array.isArray(rows)) {
        const detail = (rows as unknown as { detail?: string })?.detail || 'Tiingo FX geçersiz yanıt';
        const err = new HttpApiError(humanizeProviderError('tiingo', detail, tiingoSym));
        if (/limit|exceeded|allocation|throttled|token|authorization|429|401|403/i.test(detail)) {
          err.tiingoBlocked = true;
        }
        throw err;
      }

      let maxChunkTs = 0;
      for (const r of rows) {
        const ms = Date.parse(r.date);
        const time = Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
        const open = Number(r.open);
        const high = Number(r.high);
        const low = Number(r.low);
        const close = Number(r.close);
        if (Number.isFinite(time) && open > 0 && high > 0 && low > 0 && close > 0 && high >= low) {
          if (time >= reqStart && time <= reqEnd) {
            map.set(time, {
              time,
              open,
              high: Math.max(high, open, close),
              low: Math.min(low, open, close),
              close,
              volume: 0,
            });
          }
          if (time > maxChunkTs) maxChunkTs = time;
        }
      }
      if (rows.length >= 4950 && maxChunkTs > cursor && next - maxChunkTs > 2 * 86400) {
        cursor = maxChunkTs + 1;
        continue;
      }
    } catch (err) {
      const e = err as HttpApiError;
      const isLimit =
        e.httpStatus === 429 ||
        e.httpStatus === 401 ||
        e.httpStatus === 403 ||
        e.tiingoBlocked ||
        /limit|exceeded|allocation|throttled|token/i.test(e.message || '');
      const cleanMsg = humanizeProviderError('tiingo', e.message, tiingoSym);
      if (map.size === 0) {
        const e2 = new HttpApiError(cleanMsg);
        e2.tiingoBlocked = isLimit;
        throw e2;
      }
      blocked = isLimit;
      issue = cleanMsg;
      break;
    }

    if (next >= reqEnd) break;
    cursor = next + 1;
  }

  return { bars: sanitizeBars(Array.from(map.values()), reqStart, reqEnd), issue, blocked };
}

const tdCallTimes: number[] = [];

async function waitForTdSlot(signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<boolean> {
  const windowMs = 63000;
  while (!signal?.aborted) {
    const now = Date.now();
    while (tdCallTimes.length && now - tdCallTimes[0] >= windowMs) tdCallTimes.shift();
    if (tdCallTimes.length < 7) return true;
    const waitMs = Math.max(1200, windowMs - (now - tdCallTimes[0]) + 600);
    const ok = await sleepAbortable(waitMs, signal, (rem) =>
      onProgress?.(`Twelve Data 8/dk limiti bekleniyor (${rem} sn)`),
    );
    if (!ok) return false;
  }
  return false;
}

async function fetchTwelveDataPaginated(
  pairCfg: PairConfig,
  tdInterval: string,
  reqStart: number,
  reqEnd: number,
  apiKey: string,
  maxPages = 24,
  refPrice: number | null = null,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<{ bars: Candle[]; issue: string }> {
  let cursorEnd = reqEnd;
  let issue = '';
  let lastErr: Error | null = null;
  const map = new Map<number, Candle>();
  const symbol = pairCfg.td;
  if (!symbol) return { bars: [], issue: '' };

  for (let page = 0; page < maxPages && cursorEnd > reqStart; page++) {
    if (signal?.aborted) {
      issue = 'Kullanıcı tarafından durduruldu';
      break;
    }
    if (!(await waitForTdSlot(signal, onProgress))) {
      issue = 'Kullanıcı tarafından durduruldu';
      break;
    }

    onProgress?.(`Twelve Data ${tdInterval} (sayfa ${page + 1})`);
    const sStr = isoUtc(reqStart).replace('T', ' ').replace('Z', '');
    const eStr = isoUtc(cursorEnd).replace('T', ' ').replace('Z', '');
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tdInterval)}&start_date=${encodeURIComponent(sStr)}&end_date=${encodeURIComponent(eStr)}&outputsize=5000&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`;

    type TdResponse = {
      status?: string;
      message?: string;
      code?: number;
      values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>;
    };
    let json: TdResponse | null = null;
    let retryMinute = false;

    try {
      tdCallTimes.push(Date.now());
      json = (await fetchApiJson(url, 15000, signal)) as TdResponse;
    } catch (err) {
      const e = err as HttpApiError;
      const msg = String(e.message || '');
      if ((e.httpStatus === 429 || /credits|minute|too many/i.test(msg)) && !/daily|day/i.test(msg)) {
        retryMinute = true;
      } else {
        lastErr = new Error(humanizeProviderError('twelvedata', msg, pairCfg.code));
        break;
      }
    }

    if (!retryMinute && json?.status === 'error') {
      const msg = String(json.message || 'Twelve Data hatası');
      const code = Number(json.code || 0);
      const friendly = humanizeProviderError('twelvedata', msg, pairCfg.code);

      if (/grow|pro|ultra|plan|upgrade|permission|available starting|not available on|symbol or figi/i.test(msg) || code === 403 || code === 404) {
        const err = new HttpApiError(friendly);
        err.tdPlanRestricted = true;
        throw err;
      }
      if (/apikey|api key|invalid|unauthorized/i.test(msg) || code === 401) {
        const err = new HttpApiError(friendly);
        err.tdAuthError = true;
        throw err;
      }
      if (/daily|per day/i.test(msg)) {
        const err = new HttpApiError(friendly);
        err.tdDailyLimit = true;
        throw err;
      }
      if (code === 429 || /credits|minute|limit/i.test(msg)) {
        retryMinute = true;
      } else {
        lastErr = new Error(friendly);
        break;
      }
    }

    if (retryMinute) {
      const ok = await sleepAbortable(62000, signal, (rem) =>
        onProgress?.(`Twelve Data dakikalık kota yenileniyor (${rem} sn)`),
      );
      if (!ok) {
        issue = 'Kullanıcı tarafından durduruldu';
        break;
      }
      page--;
      continue;
    }

    const vals = json?.values || [];
    if (!Array.isArray(vals) || !vals.length) break;

    if (refPrice && Number.isFinite(refPrice) && refPrice > 0) {
      const sc = parseFloat(vals[0].close);
      if (Number.isFinite(sc) && Math.abs(sc - refPrice) / refPrice > 0.35) {
        lastErr = new Error(`${symbol} fiyatı (${sc}) referans fiyatla (${refPrice}) uyuşmadı`);
        break;
      }
    }

    let minPageTs = Infinity;
    for (const row of vals) {
      const iso = row.datetime.includes(' ')
        ? row.datetime.replace(' ', 'T') + 'Z'
        : row.datetime + 'T00:00:00Z';
      const time = Math.floor(Date.parse(iso) / 1000);
      const open = parseFloat(row.open);
      const high = parseFloat(row.high);
      const low = parseFloat(row.low);
      const close = parseFloat(row.close);
      const volume = parseFloat(row.volume || '0') || 0;
      if (Number.isFinite(time) && open > 0 && high > 0 && low > 0 && close > 0 && high >= low) {
        if (time >= reqStart && time <= reqEnd) {
          map.set(time, {
            time,
            open,
            high: Math.max(high, open, close),
            low: Math.min(low, open, close),
            close,
            volume,
          });
        }
        if (time < minPageTs) minPageTs = time;
      }
    }
    if (vals.length < 4990 || !Number.isFinite(minPageTs) || minPageTs >= cursorEnd) break;
    if (page === maxPages - 1) {
      issue = 'Twelve Data sayfa sınırı nedeniyle başlangıç tarihi tam alınamadı';
      break;
    }
    cursorEnd = minPageTs - 1;
  }

  const cleanBars = sanitizeBars(Array.from(map.values()), reqStart, reqEnd);
  if (cleanBars.length > 0) return { bars: cleanBars, issue };
  if (lastErr) throw lastErr;
  return { bars: [], issue: 'Twelve Data veri döndürmedi' };
}

async function fetchFmpRange(
  pairCfg: PairConfig,
  tf: Timeframe,
  reqStart: number,
  reqEnd: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ bars: Candle[]; issue: string }> {
  const fInt = FMP_INTERVALS[tf];
  if (!fInt || !pairCfg.fmp) return { bars: [], issue: '' };
  const sym = pairCfg.fmp;

  if (tf === 'D1') {
    const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${encodeURIComponent(sym)}&from=${toYMD(new Date(reqStart * 1000))}&to=${toYMD(new Date(reqEnd * 1000))}&apikey=${encodeURIComponent(apiKey)}`;
    const rows = (await fetchApiJson(url, 15000, signal)) as Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
    }>;
    if (!Array.isArray(rows)) {
      const obj = rows as unknown as { 'Error Message'?: string; message?: string };
      throw new Error(humanizeProviderError('fmp', obj?.['Error Message'] || obj?.message || 'FMP yanıt hatası', pairCfg.code));
    }
    const bars: Candle[] = rows.map((r) => ({
      time: Math.floor(Date.parse(`${r.date}T00:00:00Z`) / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume) || 0,
    }));
    return { bars: sanitizeBars(bars, reqStart, reqEnd), issue: '' };
  }

  const chunkDays = tf === 'M1' ? 10 : tf === 'M5' ? 30 : 90;
  const chunkSec = chunkDays * 86400;
  const map = new Map<number, Candle>();
  const tz = pairCfg.fmpTz || (pairCfg.binance ? 'UTC' : 'America/New_York');
  let cursor = reqStart;
  let issue = '';

  while (cursor <= reqEnd) {
    if (signal?.aborted) {
      issue = 'Kullanıcı tarafından durduruldu';
      break;
    }
    const next = Math.min(reqEnd, cursor + chunkSec - 1);
    const url = `https://financialmodelingprep.com/stable/historical-chart/${encodeURIComponent(fInt)}?symbol=${encodeURIComponent(sym)}&from=${toYMD(new Date(cursor * 1000))}&to=${toYMD(new Date((next + 86400) * 1000))}&apikey=${encodeURIComponent(apiKey)}`;
    try {
      const rows = (await fetchApiJson(url, 15000, signal)) as Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number;
      }>;
      if (!Array.isArray(rows)) {
        const obj = rows as unknown as { 'Error Message'?: string; message?: string };
        throw new Error(obj?.['Error Message'] || obj?.message || 'FMP yanıt hatası');
      }
      for (const r of rows) {
        const time = parseTzDateTimeToUtcSec(r.date, tz);
        if (time !== null && time >= reqStart && time <= reqEnd) {
          map.set(time, {
            time,
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: Number(r.volume) || 0,
          });
        }
      }
    } catch (err) {
      const clean = humanizeProviderError('fmp', err instanceof Error ? err.message : String(err), pairCfg.code);
      if (map.size === 0) throw new Error(clean);
      issue = clean;
      break;
    }
    if (next >= reqEnd) break;
    cursor = next + 1;
  }
  return { bars: sanitizeBars(Array.from(map.values()), reqStart, reqEnd), issue };
}

// ============================================================================
// SAFE DERIVATION & TIMEFRAME PIPELINE
// ============================================================================

function stripDerivedTag(label: string): string {
  return label
    .replace(/\s*\([^)]*→[^)]*\)/g, '')
    .replace(/\s*\(türetilmiş\)/g, '')
    .trim();
}

function cleanSourceList(list: string[] | undefined): string[] {
  if (!list?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function deriveMissingFromFinerTfs(
  out: Partial<Record<Timeframe, Candle[]>>,
  sources: Partial<Record<Timeframe, string[]>>,
  issues: Partial<Record<Timeframe, string>>,
  reqStart: number,
  reqEnd: number,
  is247: boolean,
) {
  const tryDerive = (targetTf: Timeframe, fromTf: Timeframe, bucketSec: number) => {
    const srcBars = out[fromTf];
    if (!srcBars?.length) return;
    const derived = aggregateBars(srcBars, bucketSec);
    if (!derived.length) return;

    const baseFromSources = cleanSourceList((sources[fromTf] || []).map(stripDerivedTag));
    const derivedTags = baseFromSources.map((s) => `${s} (türetilmiş)`);

    const curBars = out[targetTf];
    if (!curBars?.length) {
      out[targetTf] = derived;
      sources[targetTf] = derivedTags;
      if (issues[fromTf]) issues[targetTf] = issues[fromTf];
      else delete issues[targetTf];
      return;
    }

    const gaps = computeMissingRanges(curBars, targetTf, reqStart, reqEnd, is247);
    if (!gaps.length) return;
    const compat = checkPriceCompatibility(curBars, derived, 0.0025);
    if (!compat.compatible) return;

    const beforeLen = curBars.length;
    out[targetTf] = mergeBarLists(curBars, derived, true);
    if ((out[targetTf]?.length || 0) > beforeLen) {
      sources[targetTf] = cleanSourceList([...(sources[targetTf] || []), ...derivedTags]);
      if (computeMissingRanges(out[targetTf], targetTf, reqStart, reqEnd, is247).length === 0) {
        delete issues[targetTf];
      }
    }
  };

  tryDerive('M3', 'M1', 180);
  tryDerive('M5', 'M1', 300);
  tryDerive('M15', 'M5', 900);
  tryDerive('M30', 'M15', 1800);
  tryDerive('H1', 'M30', 3600);
  tryDerive('H2', 'H1', 7200);
  tryDerive('H4', 'H1', 14400);

  if (out.D1?.length) {
    const d1BaseSources = cleanSourceList((sources.D1 || []).map(stripDerivedTag));
    if (!out.W1?.length || computeMissingRanges(out.W1, 'W1', reqStart, reqEnd, is247).length > 0) {
      const derivedW1 = buildCalendarBarsFromDaily(out.D1, 'W1');
      if (!out.W1?.length) {
        out.W1 = derivedW1;
        sources.W1 = d1BaseSources.map((s) => `${s} (türetilmiş)`);
        if (!issues.D1) delete issues.W1;
      } else if (checkPriceCompatibility(out.W1, derivedW1, 0.004).compatible) {
        out.W1 = mergeBarLists(out.W1, derivedW1, true);
      }
    }
    if (!out.MN1?.length || computeMissingRanges(out.MN1, 'MN1', reqStart, reqEnd, is247).length > 0) {
      const derivedMn1 = buildCalendarBarsFromDaily(out.D1, 'MN1');
      if (!out.MN1?.length) {
        out.MN1 = derivedMn1;
        sources.MN1 = d1BaseSources.map((s) => `${s} (türetilmiş)`);
        if (!issues.D1) delete issues.MN1;
      } else if (checkPriceCompatibility(out.MN1, derivedMn1, 0.004).compatible) {
        out.MN1 = mergeBarLists(out.MN1, derivedMn1, true);
      }
    }
  }
}

function expandRequiredTfs(selectedTfs: Timeframe[]): Set<Timeframe> {
  const needed = new Set<Timeframe>(selectedTfs);
  if (needed.has('M3')) needed.add('M1');
  if (needed.has('H2')) needed.add('H1');
  if (needed.has('W1') || needed.has('MN1')) needed.add('D1');
  return needed;
}

// ============================================================================
// CRYPTO ORCHESTRATOR
// ============================================================================

async function fetchCryptoSingleRange(
  provider: CryptoProviderPref,
  pairCfg: PairConfig,
  tf: Timeframe,
  sSec: number,
  eSec: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  if (provider === 'binance' && pairCfg.binance && BINANCE_INTERVALS[tf]) {
    return await fetchBinanceRange(pairCfg.binance, BINANCE_INTERVALS[tf]!, TF_SECONDS[tf], sSec, eSec, signal);
  }
  if (provider === 'okx' && pairCfg.okx && OKX_INTERVALS[tf]) {
    return await fetchOkxRange(pairCfg.okx, OKX_INTERVALS[tf]!, TF_SECONDS[tf], sSec, eSec, signal);
  }
  if (provider === 'bybit' && pairCfg.bybit && BYBIT_INTERVALS[tf]) {
    return await fetchBybitRange(pairCfg.bybit, BYBIT_INTERVALS[tf]!, TF_SECONDS[tf], sSec, eSec, signal);
  }
  if (provider === 'coinbase' && pairCfg.coinbase && COINBASE_GRANULARITY[tf]) {
    return await fetchCoinbaseRange(pairCfg.coinbase, COINBASE_GRANULARITY[tf]!, sSec, eSec, signal);
  }
  if (provider === 'bitstamp' && pairCfg.bitstamp && BITSTAMP_STEPS[tf]) {
    return await fetchBitstampRange(pairCfg.bitstamp, BITSTAMP_STEPS[tf]!, sSec, eSec, signal);
  }
  if (provider === 'kraken' && pairCfg.kraken && KRAKEN_INTERVALS[tf]) {
    return await fetchKrakenRange(pairCfg.kraken, KRAKEN_INTERVALS[tf]!, sSec, eSec, signal);
  }
  return [];
}

async function fetchCryptoTimeframes(
  pairCfg: PairConfig,
  reqStart: number,
  reqEnd: number,
  selectedTfs: Timeframe[],
  cfg: AppSettings,
  signal?: AbortSignal,
  onProgress?: (p: FetchProgress) => void,
): Promise<{ out: Partial<Record<Timeframe, Candle[]>>; meta: Partial<Record<Timeframe, TfMeta>> }> {
  const defaultOrder: CryptoProviderPref[] = ['binance', 'bybit', 'okx', 'bitstamp', 'coinbase', 'kraken'];
  const order =
    cfg.cryptoProvider !== 'auto'
      ? [cfg.cryptoProvider, ...defaultOrder.filter((x) => x !== cfg.cryptoProvider)]
      : defaultOrder;

  const out: Partial<Record<Timeframe, Candle[]>> = {};
  const sources: Partial<Record<Timeframe, string[]>> = {};
  const issues: Partial<Record<Timeframe, string>> = {};
  const needed = expandRequiredTfs(selectedTfs);

  const addSource = (tf: Timeframe, label: string) => {
    if (!sources[tf]) sources[tf] = [];
    if (!sources[tf]!.includes(label)) sources[tf]!.push(label);
  };

  // Optimal fetch order: native higher TFs first (fast, 1 call each), then M5/M1
  const tfOrder: Timeframe[] = ['MN1', 'W1', 'D1', 'H4', 'H2', 'H1', 'M30', 'M15', 'M5', 'M3', 'M1'];
  const activeTfs = tfOrder.filter((tf) => needed.has(tf));
  let stepCounter = 0;

  for (const prov of order) {
    if (signal?.aborted) break;
    if (!pairCfg[prov as keyof PairConfig]) continue;
    const label = prov.toUpperCase();
    const isSmallWin = prov === 'okx' || prov === 'coinbase';
    const m1LimitDays = isSmallWin ? 31 : 90;
    const m3LimitDays = isSmallWin ? 60 : 185;

    for (const tf of activeTfs) {
      if (signal?.aborted) break;
      const tfStart = getTfWindowStart(reqStart, tf);
      const gaps = computeMissingRanges(out[tf], tf, tfStart, reqEnd, true);
      if (!gaps.length) continue;

      stepCounter++;
      onProgress?.({
        message: `${pairCfg.code} • ${label} ${tf} çekiliyor...`,
        completedSteps: Math.min(activeTfs.length - 1, stepCounter),
        totalSteps: activeTfs.length,
        activeTf: tf,
        activeSource: label,
      });

      for (const [gs, ge] of gaps) {
        if (signal?.aborted) break;
        let effGs = gs;
        if (tf === 'M1') effGs = Math.max(gs, ge - m1LimitDays * 86400);
        if (tf === 'M3') effGs = Math.max(gs, ge - m3LimitDays * 86400);
        if (effGs >= ge) continue;

        try {
          const bars = await fetchCryptoSingleRange(prov, pairCfg, tf, effGs, ge, signal);
          if (bars.length > 0 && checkPriceCompatibility(out[tf], bars, 0.004).compatible) {
            out[tf] = mergeBarLists(out[tf], bars, true);
            addSource(tf, label);
            delete issues[tf];
          }
        } catch (err) {
          if (err instanceof FetchCancelledError) break;
          if (!issues[tf]) issues[tf] = `${label}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, true);
    }

    if (selectedTfs.every((k) => computeMissingRanges(out[k], k, getTfWindowStart(reqStart, k), reqEnd, true).length === 0)) break;
  }

  deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, true);

  if (!selectedTfs.some((k) => (out[k]?.length || 0) > 0)) {
    throw new Error('Kripto borsalarına erişilemedi veya bu aralıkta veri bulunamadı.');
  }

  const finalOut: Partial<Record<Timeframe, Candle[]>> = {};
  const meta: Partial<Record<Timeframe, TfMeta>> = {};
  for (const tf of selectedTfs) {
    const tfStart = getTfWindowStart(reqStart, tf);
    if (out[tf]?.length) finalOut[tf] = sanitizeBars(out[tf]!, tfStart, reqEnd);
    const srcLabel = cleanSourceList(sources[tf]).join(' + ');
    let noteIssue = issues[tf] || '';
    if (
      tf === 'M1' &&
      reqEnd - reqStart > 92 * 86400 &&
      (!finalOut.M1 || finalOut.M1[0].time - reqStart > 5 * 86400)
    ) {
      noteIssue = noteIssue || 'M1 geçmişi hız/kota korumasıyla son ~90 günle sınırlandı';
    }
    meta[tf] = assessTfCoverage(tf, finalOut[tf], tfStart, reqEnd, true, srcLabel, noteIssue);
  }

  return { out: finalOut, meta };
}

// ============================================================================
// TRADFI (FOREX, METALS, INDICES, ENERGY) ORCHESTRATOR
// ============================================================================

async function fetchYahooTickerForTfs(
  ticker: string,
  pairKey: string,
  neededTfs: Set<Timeframe>,
  reqStart: number,
  reqEnd: number,
  endDateEnd: number,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
) {
  const out: Partial<Record<Timeframe, Candle[]>> = {};
  const sources: Partial<Record<Timeframe, string[]>> = {};
  const issues: Partial<Record<Timeframe, string>> = {};
  const brokenM1Ranges: Array<[number, number]> = [];
  const nowSec = Math.floor(Date.now() / 1000);

  const addSrc = (tf: Timeframe) => {
    if (!sources[tf]) sources[tf] = [];
    if (!sources[tf]!.includes('Yahoo Finance')) sources[tf]!.push('Yahoo Finance');
  };

  if (neededTfs.has('D1')) {
    try {
      onProgress?.(`${pairKey} Yahoo Finance D1 çekiliyor...`);
      const r1d = await fetchYahooChart(
        ticker,
        '1d',
        reqStart - 2 * 86400,
        Math.min(endDateEnd + 2 * 86400, nowSec + 3600),
        signal,
      );
      const bars = extractYahooBars(r1d, reqStart, endDateEnd, true, 0);
      if (bars.length) {
        out.D1 = bars;
        addSrc('D1');
      }
    } catch (e) {
      issues.D1 = `Yahoo D1: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (neededTfs.has('W1')) {
    try {
      const r1w = await fetchYahooChart(
        ticker,
        '1wk',
        reqStart - 10 * 86400,
        Math.min(endDateEnd + 7 * 86400, nowSec + 3600),
        signal,
      );
      const bars = extractYahooBars(r1w, reqStart - 7 * 86400, endDateEnd, true, 0);
      if (bars.length) {
        out.W1 = bars;
        addSrc('W1');
      }
    } catch {
      // derived from D1 later
    }
  }

  if (neededTfs.has('MN1')) {
    try {
      const r1mo = await fetchYahooChart(
        ticker,
        '1mo',
        reqStart - 35 * 86400,
        Math.min(endDateEnd + 31 * 86400, nowSec + 3600),
        signal,
      );
      const bars = extractYahooBars(r1mo, reqStart - 31 * 86400, endDateEnd, true, 0);
      if (bars.length) {
        out.MN1 = bars;
        addSrc('MN1');
      }
    } catch {
      // derived from D1 later
    }
  }

  if (neededTfs.has('H1') || neededTfs.has('H2') || neededTfs.has('H4')) {
    const min1h = nowSec - 720 * 86400;
    const s1h = Math.max(reqStart, min1h);
    if (reqEnd > s1h && !signal?.aborted) {
      try {
        onProgress?.(`${pairKey} Yahoo Finance H1 çekiliyor...`);
        const h1 = await fetchYahooH1(ticker, s1h, reqEnd, signal);
        if (h1.length) {
          out.H1 = h1;
          addSrc('H1');
          if (s1h > reqStart) issues.H1 = 'Yahoo H1 en fazla son 720 günü verir';
        }
      } catch (e) {
        issues.H1 = `Yahoo H1: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  const min5m = nowSec - (58 * 86400 + 43200);
  const s5m = Math.max(reqStart, min5m);
  if (reqEnd > s5m) {
    const intraDefs: Array<[Timeframe, string, number]> = [
      ['M5', '5m', 300],
      ['M15', '15m', 900],
      ['M30', '30m', 1800],
    ];
    for (const [tfKey, yInt, sec] of intraDefs) {
      if (!neededTfs.has(tfKey) || signal?.aborted) continue;
      try {
        onProgress?.(`${pairKey} Yahoo Finance ${tfKey} çekiliyor...`);
        const bars = await fetchYahooIntraday(ticker, yInt, sec, s5m, reqEnd, signal);
        if (bars.length) {
          out[tfKey] = bars;
          addSrc(tfKey);
          if (s5m > reqStart) issues[tfKey] = 'Yahoo M5–M30 en fazla son ~59 günü verir';
        }
      } catch (e) {
        issues[tfKey] = `Yahoo ${tfKey}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  if (neededTfs.has('M1') || neededTfs.has('M3')) {
    const min1m = nowSec - (28 * 86400 + 43200);
    if (reqEnd > min1m && !signal?.aborted) {
      const s1m = Math.max(reqStart, min1m);
      try {
        onProgress?.(`${pairKey} Yahoo Finance M1 çekiliyor...`);
        const m1Res = await fetchYahoo1mStitched(ticker, s1m, reqEnd, signal);
        if (m1Res.bars.length) {
          out.M1 = m1Res.bars;
          addSrc('M1');
          if (m1Res.failedRanges.length) brokenM1Ranges.push(...m1Res.failedRanges);
          else if (s1m > reqStart) issues.M1 = 'Yahoo M1 en fazla son ~29 günü verir';
        }
      } catch (e) {
        issues.M1 = `Yahoo M1: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  return { out, sources, issues, brokenM1Ranges };
}

export async function fetchAllTimeframesFromMarket(
  pairKey: string,
  startStr: string,
  endStr: string,
  selectedTfs: Timeframe[] = ALL_TF_NAMES,
  signal?: AbortSignal,
  onProgress?: (p: FetchProgress) => void,
): Promise<{ out: Partial<Record<Timeframe, Candle[]>>; meta: Partial<Record<Timeframe, TfMeta>> }> {
  const pair = PAIRS[pairKey];
  if (!pair) throw new Error(`Bilinmeyen parite: ${pairKey}`);
  const cfg = getSettings();

  const reqStart = Math.floor(Date.parse(`${startStr}T00:00:00Z`) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const endDateEnd = Math.floor(Date.parse(`${endStr}T23:59:59Z`) / 1000);
  const reqEnd = Math.min(endDateEnd, nowSec);
  if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd) || reqStart >= reqEnd) {
    throw new Error('Geçersiz tarih aralığı. Bitiş tarihi başlangıç tarihinden sonra olmalıdır.');
  }

  if (pair.binance) {
    return await fetchCryptoTimeframes(pair, reqStart, reqEnd, selectedTfs, cfg, signal, onProgress);
  }

  const out: Partial<Record<Timeframe, Candle[]>> = {};
  const sources: Partial<Record<Timeframe, string[]>> = {};
  const issues: Partial<Record<Timeframe, string>> = {};
  const brokenM1Ranges: Array<[number, number]> = [];
  const needed = expandRequiredTfs(selectedTfs);
  const is247 = false;

  const addSource = (tf: Timeframe, label: string) => {
    if (!sources[tf]) sources[tf] = [];
    if (!sources[tf]!.includes(label)) sources[tf]!.push(label);
  };

  const getRefSeries = (): { tf: Timeframe; bars: Candle[] } | null => {
    for (const k of ['H1', 'H4', 'M15', 'M5', 'D1', 'M1'] as Timeframe[]) {
      if (out[k]?.length) return { tf: k, bars: out[k]! };
    }
    return null;
  };

  const getRefPrice = (): number | null => {
    const ref = getRefSeries();
    return ref ? ref.bars[ref.bars.length - 1].close : null;
  };

  const isGloballyCompatible = (bars: Candle[], candTf: Timeframe): boolean => {
    const ref = getRefSeries();
    if (!ref) return true;
    return checkCrossTfBasisCompatibility(ref.bars, ref.tf, bars, candTf, 0.008).compatible;
  };

  const blocked = { tiingo: '', td: '', fmp: '' };

  type ProviderKey = 'tiingo' | 'twelvedata' | 'fmp' | 'bitstamp' | 'kraken' | 'biquote' | 'yahoo' | 'frankfurter';

  const buildProviderQueue = (): ProviderKey[] => {
    const hasTiingo = cfg.cfdPriority !== 'free' && Boolean(cfg.tiingoKey && pair.tiingo);
    const hasTd = cfg.cfdPriority !== 'free' && Boolean(cfg.tdKey && pair.td);
    const hasFmp = cfg.cfdPriority !== 'free' && Boolean(cfg.fmpKey && pair.fmp);

    if (cfg.cfdPriority === 'free') {
      return pair.isSpotMetal
        ? ['biquote', 'yahoo']
        : ['yahoo', 'biquote', 'bitstamp', 'kraken', 'frankfurter'];
    }
    if (cfg.cfdPriority === 'tiingo') {
      const q: ProviderKey[] = [];
      if (hasTiingo) q.push('tiingo');
      if (hasTd) q.push('twelvedata');
      if (hasFmp) q.push('fmp');
      q.push('yahoo', 'biquote', 'bitstamp', 'kraken', 'frankfurter');
      return q;
    }
    if (cfg.cfdPriority === 'twelvedata') {
      const q: ProviderKey[] = [];
      if (hasTd) q.push('twelvedata');
      if (hasTiingo) q.push('tiingo');
      if (hasFmp) q.push('fmp');
      q.push('yahoo', 'biquote', 'bitstamp', 'kraken', 'frankfurter');
      return q;
    }
    if (cfg.cfdPriority === 'yahoo') {
      const q: ProviderKey[] = ['yahoo', 'biquote', 'bitstamp', 'kraken'];
      if (hasTiingo) q.push('tiingo');
      if (hasTd) q.push('twelvedata');
      if (hasFmp) q.push('fmp');
      q.push('frankfurter');
      return q;
    }
    // 'smart': Keyed APIs first when configured, then Yahoo (true 5-day TradFi market hours + 29d M1), then biquote/Bitstamp/Kraken
    const q: ProviderKey[] = [];
    if (hasTiingo) q.push('tiingo');
    if (hasTd) q.push('twelvedata');
    if (!pair.isSpotMetal) q.push('yahoo');
    if (hasFmp) q.push('fmp');
    q.push('biquote');
    if (pair.cat === 'forex' && pair.bitstamp) q.push('bitstamp');
    q.push('kraken');
    if (pair.isSpotMetal) q.push('yahoo');
    q.push('frankfurter');
    return Array.from(new Set(q));
  };

  const queue = buildProviderQueue();
  const totalSteps = Math.max(1, selectedTfs.length);
  const completedCount = () =>
    selectedTfs.filter((tf) => computeMissingRanges(out[tf], tf, reqStart, reqEnd, is247).length === 0).length;

  for (const prov of queue) {
    if (signal?.aborted) break;
    if (selectedTfs.every((tf) => computeMissingRanges(out[tf], tf, reqStart, reqEnd, is247).length === 0)) {
      break;
    }

    if (prov === 'yahoo') {
      // Only fetch TFs that still have gaps!
      const tfsNeedingYahoo = new Set<Timeframe>();
      for (const tf of needed) {
        if (computeMissingRanges(out[tf], tf, reqStart, reqEnd, is247).length > 0) {
          tfsNeedingYahoo.add(tf);
        }
      }
      if (!tfsNeedingYahoo.size) continue;

      const tickerToUse = pair.isSpotMetal ? pair.futuresFallback || pair.primary : pair.primary;
      const yRes = await fetchYahooTickerForTfs(
        tickerToUse,
        pairKey,
        tfsNeedingYahoo,
        reqStart,
        reqEnd,
        endDateEnd,
        signal,
        (msg) =>
          onProgress?.({
            message: msg,
            completedSteps: completedCount(),
            totalSteps,
            activeSource: pair.isSpotMetal ? `Yahoo Vadeli (${tickerToUse})` : 'Yahoo Finance',
          }),
      );
      const yLabel = pair.isSpotMetal ? `Yahoo Vadeli (${tickerToUse})` : 'Yahoo Finance';
      for (const tf of ALL_TF_NAMES) {
        const yBars = yRes.out[tf];
        if (!yBars?.length) continue;
        // Never mix Futures (GC=F) into a TF that already has Spot data with a >0.18% basis gap
        if (!out[tf]?.length && isGloballyCompatible(yBars, tf)) {
          out[tf] = yBars;
          addSource(tf, yLabel);
          if (yRes.issues[tf]) issues[tf] = yRes.issues[tf];
        } else if (out[tf]?.length && checkPriceCompatibility(out[tf], yBars, 0.0018).compatible) {
          if (computeMissingRanges(out[tf], tf, reqStart, reqEnd, is247).length > 0) {
            out[tf] = mergeBarLists(out[tf], yBars, true);
            addSource(tf, yLabel);
          }
        }
      }
      brokenM1Ranges.push(...yRes.brokenM1Ranges);
      deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, is247);

      // If Yahoo primary had missing TFs and a fallback ticker exists (e.g. ^NDX vs NQ=F), only use it for completely empty TFs that match price basis
      if (pair.fallback && !signal?.aborted) {
        const stillEmpty = new Set<Timeframe>();
        for (const tf of needed) {
          if (!out[tf]?.length) stillEmpty.add(tf);
        }
        if (stillEmpty.size) {
          const fbRes = await fetchYahooTickerForTfs(
            pair.fallback,
            pairKey,
            stillEmpty,
            reqStart,
            reqEnd,
            endDateEnd,
            signal,
          );
          for (const tf of ALL_TF_NAMES) {
            const fbBars = fbRes.out[tf];
            if (!fbBars?.length || out[tf]?.length) continue;
            if (isGloballyCompatible(fbBars, tf)) {
              out[tf] = fbBars;
              addSource(tf, `Yahoo (${pair.fallback})`);
              if (fbRes.issues[tf]) issues[tf] = fbRes.issues[tf];
            }
          }
          deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, is247);
        }
      }
      continue;
    }

    // External API providers: fetch in clean dependency order (D1 -> H1 -> M1 -> remaining)
    // When M1 succeeds for full range, M3/M5/M15/M30 are derived in 1ms with zero extra API calls!
    const tfOrder: Timeframe[] =
      prov === 'tiingo'
        ? ['D1', 'H1', 'H4', 'M1', 'M5', 'M15', 'M30']
        : ['MN1', 'W1', 'D1', 'H4', 'H2', 'H1', 'M15', 'M5', 'M30', 'M3', 'M1'];

    for (const tf of tfOrder) {
      if (!needed.has(tf) || signal?.aborted) continue;
      if (prov === 'tiingo' && (blocked.tiingo || !cfg.tiingoKey || !pair.tiingo || !TIINGO_INTERVALS[tf])) continue;
      if (prov === 'twelvedata' && (blocked.td || !cfg.tdKey || !pair.td || !TD_INTERVALS[tf])) continue;
      if (prov === 'fmp' && (blocked.fmp || !cfg.fmpKey || !pair.fmp || !FMP_INTERVALS[tf])) continue;
      if (prov === 'bitstamp' && (!pair.bitstamp || !BITSTAMP_STEPS[tf])) continue;
      if (prov === 'kraken' && (!pair.kraken || !KRAKEN_INTERVALS[tf])) continue;
      if (prov === 'biquote' && (!pair.biquote || !BIQUOTE_INTERVALS[tf])) continue;
      if (prov === 'frankfurter' && (tf !== 'D1' || !pair.fxBase)) continue;

      const gaps = computeMissingRanges(out[tf], tf, reqStart, reqEnd, is247, tf === 'M1' ? brokenM1Ranges : []);
      if (!gaps.length) continue;

      for (const [gs, ge] of gaps) {
        if (signal?.aborted) break;
        try {
          let bars: Candle[] = [];
          let issue = '';
          let label = '';

          if (prov === 'tiingo') {
            label = 'Tiingo FX';
            const res = await fetchTiingoFxRange(
              pair.tiingo!,
              TIINGO_INTERVALS[tf]!,
              gs,
              ge,
              cfg.tiingoKey,
              signal,
              (msg) =>
                onProgress?.({
                  message: `${pairKey} ${msg}`,
                  completedSteps: completedCount(),
                  totalSteps,
                  activeTf: tf,
                  activeSource: label,
                }),
            );
            bars = res.bars;
            issue = res.issue;
            if (res.blocked && res.issue) blocked.tiingo = res.issue;
          } else if (prov === 'twelvedata') {
            label = 'Twelve Data';
            const estDays = Math.max(1, (ge - gs) / 86400);
            const maxPages =
              tf === 'M1'
                ? Math.min(85, Math.max(8, Math.ceil(estDays * 0.25) + 4))
                : tf === 'M5'
                  ? Math.min(25, Math.max(4, Math.ceil(estDays * 0.06) + 3))
                  : 10;
            const res = await fetchTwelveDataPaginated(
              pair,
              TD_INTERVALS[tf]!,
              gs,
              ge,
              cfg.tdKey,
              maxPages,
              getRefPrice(),
              signal,
              (msg) =>
                onProgress?.({
                  message: `${pairKey} ${msg}`,
                  completedSteps: completedCount(),
                  totalSteps,
                  activeTf: tf,
                  activeSource: label,
                }),
            );
            bars = res.bars;
            issue = res.issue;
          } else if (prov === 'fmp') {
            label = 'FMP';
            onProgress?.({
              message: `${pairKey} FMP ${tf} çekiliyor...`,
              completedSteps: completedCount(),
              totalSteps,
              activeTf: tf,
              activeSource: label,
            });
            const res = await fetchFmpRange(pair, tf, gs, ge, cfg.fmpKey, signal);
            bars = res.bars;
            issue = res.issue;
          } else if (prov === 'bitstamp') {
            label = 'Bitstamp';
            onProgress?.({
              message: `${pairKey} Bitstamp ${tf} çekiliyor...`,
              completedSteps: completedCount(),
              totalSteps,
              activeTf: tf,
              activeSource: label,
            });
            bars = await fetchBitstampRange(pair.bitstamp!, BITSTAMP_STEPS[tf]!, gs, ge, signal);
          } else if (prov === 'kraken') {
            label = 'Kraken';
            onProgress?.({
              message: `${pairKey} Kraken ${tf} çekiliyor...`,
              completedSteps: completedCount(),
              totalSteps,
              activeTf: tf,
              activeSource: label,
            });
            bars = await fetchKrakenRange(pair.kraken!, KRAKEN_INTERVALS[tf]!, gs, ge, signal);
          } else if (prov === 'biquote') {
            label = 'biquote MT5';
            onProgress?.({
              message: `${pairKey} biquote.io ${tf} çekiliyor...`,
              completedSteps: completedCount(),
              totalSteps,
              activeTf: tf,
              activeSource: label,
            });
            bars = await fetchBiquoteOhlcRange(pair, tf, gs, ge, signal);
          } else if (prov === 'frankfurter') {
            label = 'Frankfurter ECB';
            onProgress?.({
              message: `${pairKey} Frankfurter D1 çekiliyor...`,
              completedSteps: completedCount(),
              totalSteps,
              activeTf: tf,
              activeSource: label,
            });
            bars = await fetchFrankfurterFxDaily(pair, startStr, endStr, gs, ge, signal);
          }

          if (bars.length > 0) {
            if (!out[tf]?.length ? isGloballyCompatible(bars, tf) : checkPriceCompatibility(out[tf], bars, 0.0018).compatible) {
              out[tf] = mergeBarLists(out[tf], bars, true);
              addSource(tf, label);
              if (issue) issues[tf] = issue;
              else delete issues[tf];
            }
          } else if (issue && !issues[tf]) {
            issues[tf] = issue;
          }
        } catch (err) {
          if (err instanceof FetchCancelledError) break;
          const e = err as HttpApiError;
          if (prov === 'tiingo' && e.tiingoBlocked) blocked.tiingo = e.message;
          if (prov === 'twelvedata' && (e.tdPlanRestricted || e.tdAuthError || e.tdDailyLimit)) blocked.td = e.message;
          if (prov === 'fmp' && /desteklemiyor|geçersiz|limiti/i.test(e.message)) blocked.fmp = e.message;
          if (!issues[tf]) issues[tf] = e.message;
        }
      }

      deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, is247);
    }
  }

  deriveMissingFromFinerTfs(out, sources, issues, reqStart, reqEnd, is247);

  const finalOut: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of selectedTfs) {
    const tfStart = getTfWindowStart(reqStart, tf);
    if (out[tf]?.length) finalOut[tf] = sanitizeBars(out[tf]!, tfStart, endDateEnd);
  }

  const nonEmpty = selectedTfs.filter((k) => (finalOut[k]?.length || 0) > 0);
  if (nonEmpty.length === 0) {
    const reasons = [blocked.tiingo, blocked.td, blocked.fmp, ...Object.values(issues)].filter(Boolean);
    throw new Error(reasons[0] || 'Seçilen tarih aralığında mum verisi bulunamadı.');
  }

  const meta: Partial<Record<Timeframe, TfMeta>> = {};
  for (const tf of selectedTfs) {
    const tfStart = getTfWindowStart(reqStart, tf);
    const srcLabel = cleanSourceList(sources[tf]).join(' + ');
    let finalNote = issues[tf] || '';
    if (computeMissingRanges(finalOut[tf], tf, tfStart, reqEnd, is247).length > 0) {
      const notes: string[] = [];
      if (finalNote) notes.push(finalNote);
      if (pair.cat === 'index' && !cfg.fmpKey) {
        notes.push('Ücretsiz kaynaklarda endeks M1–M30 derinliği 29/59 gün ile sınırlıdır');
      }
      if (blocked.tiingo) notes.push(blocked.tiingo);
      if (blocked.td) notes.push(blocked.td);
      if (blocked.fmp) notes.push(blocked.fmp);
      finalNote = Array.from(new Set(notes)).join(' • ');
    }
    meta[tf] = assessTfCoverage(tf, finalOut[tf], tfStart, reqEnd, is247, srcLabel, finalNote);
  }

  return { out: finalOut, meta };
}
