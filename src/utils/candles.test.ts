import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateBars,
  buildCalendarBarsFromDaily,
  buildMergedCsv,
  checkCrossTfBasisCompatibility,
  checkPriceCompatibility,
  computeMissingRanges,
  getTfWindowStart,
  parseSingleOrMergedCsv,
  sanitizeBars,
} from './candles';
import type { Candle } from '../types/market';

test('sanitizeBars deduplicates, fixes OHLC envelope, and sorts ascending', () => {
  const raw: Candle[] = [
    { time: 1700000300, open: 100, high: 99, low: 98, close: 102, volume: 10 },
    { time: 1700000000, open: 95, high: 97, low: 94, close: 96, volume: 5 },
    { time: 1700000000, open: 95, high: 98, low: 93, close: 97, volume: 7 },
    { time: 1700000100, open: -1, high: 10, low: 5, close: 8, volume: 1 }, // invalid price
  ];
  const clean = sanitizeBars(raw);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].time, 1700000000);
  assert.equal(clean[0].close, 97);
  assert.equal(clean[1].time, 1700000300);
  assert.equal(clean[1].high, 102); // clamped to close
});

test('aggregateBars combines M1 candles into exact M5 OHLCV ascending', () => {
  const base = 1700006400; // divisible by 300
  const m1: Candle[] = [
    { time: base + 120, open: 102, high: 105, low: 101, close: 104, volume: 20 },
    { time: base, open: 100, high: 103, low: 99, close: 102, volume: 10 },
    { time: base + 240, open: 104, high: 104, low: 98, close: 101, volume: 30 },
  ];
  const m5 = aggregateBars(m1, 300);
  assert.equal(m5.length, 1);
  assert.deepEqual(m5[0], {
    time: base,
    open: 100,
    high: 105,
    low: 98,
    close: 101,
    volume: 60,
  });
});

test('computeMissingRanges detects internal middle gaps, not only boundaries', () => {
  const start = Date.parse('2026-10-01T00:00:00Z') / 1000;
  const end = Date.parse('2026-10-10T00:00:00Z') / 1000;
  const bars: Candle[] = [
    { time: start, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: start + 900, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    // Missing 8 days in the middle
    { time: end - 900, open: 105, high: 106, low: 104, close: 105, volume: 1 },
    { time: end, open: 105, high: 106, low: 104, close: 105, volume: 1 },
  ];
  const gaps = computeMissingRanges(bars, 'M15', start, end, true);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0][0] > start && gaps[0][1] < end);
});

test('checkPriceCompatibility rejects mismatched spot vs futures bases', () => {
  const spot: Candle[] = [
    { time: 1700000000, open: 2650, high: 2655, low: 2648, close: 2652, volume: 10 },
  ];
  const futures: Candle[] = [
    { time: 1700000000, open: 2680, high: 2685, low: 2678, close: 2682, volume: 10 },
  ];
  const res = checkPriceCompatibility(spot, futures, 0.002);
  assert.equal(res.compatible, false);
});

test('buildMergedCsv orders timeframes M1->MN1 and bars strictly ascending', () => {
  const csv = buildMergedCsv(
    'BTCUSD',
    {
      H1: [
        { time: 1700003600, open: 2, high: 3, low: 1, close: 2.5, volume: 20 },
        { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 10 },
      ],
      M1: [
        { time: 1700000060, open: 1.5, high: 2, low: 1, close: 1.8, volume: 5 },
        { time: 1700000000, open: 1, high: 1.6, low: 0.9, close: 1.5, volume: 4 },
      ],
    },
    2,
    true,
    'iso',
  );
  const rows = csv.split('\n');
  assert.equal(rows[0], 'symbol,timeframe,time,open,high,low,close,volume');
  assert.ok(rows[1].startsWith('BTCUSD,M1,2023-11-14T22:13:20Z'));
  assert.ok(rows[2].startsWith('BTCUSD,M1,2023-11-14T22:14:20Z'));
  assert.ok(rows[3].startsWith('BTCUSD,H1,2023-11-14T22:13:20Z'));
  assert.ok(rows[4].startsWith('BTCUSD,H1,2023-11-14T23:13:20Z'));
});

test('parseSingleOrMergedCsv parses descending/unsorted rows into sorted ascending by timeframe', () => {
  const rawCsv = [
    'symbol,timeframe,time,open,high,low,close,volume',
    'EURUSD,M15,2026-10-10T01:15:00Z,1.1010,1.1020,1.1005,1.1015,120',
    'EURUSD,M15,2026-10-10T01:00:00Z,1.1000,1.1015,1.0995,1.1010,100',
    'EURUSD,H1,2026-10-10T01:00:00Z,1.1000,1.1030,1.0990,1.1025,400',
  ].join('\n');
  const parsed = parseSingleOrMergedCsv(rawCsv, 'EURUSD_M15.csv');
  assert.equal(parsed.lockedSymbol, 'EURUSD');
  assert.equal(parsed.byTf.M15?.length, 2);
  assert.ok(parsed.byTf.M15![0].time < parsed.byTf.M15![1].time);
  assert.equal(parsed.byTf.H1?.length, 1);
});

test('buildCalendarBarsFromDaily aggregates W1 starting Monday', () => {
  const mon = Date.parse('2026-11-09T00:00:00Z') / 1000;
  const tue = Date.parse('2026-11-10T00:00:00Z') / 1000;
  const w1 = buildCalendarBarsFromDaily(
    [
      { time: tue, open: 105, high: 110, low: 102, close: 108, volume: 20 },
      { time: mon, open: 100, high: 106, low: 98, close: 105, volume: 15 },
    ],
    'W1',
  );
  assert.equal(w1.length, 1);
  assert.equal(w1[0].time, mon);
  assert.equal(w1[0].open, 100);
  assert.equal(w1[0].high, 110);
  assert.equal(w1[0].low, 98);
  assert.equal(w1[0].close, 108);
  assert.equal(w1[0].volume, 35);
});

test('getTfWindowStart aligns MN1 and W1 so mid-month 7-day queries retain active monthly candle', () => {
  const reqStart = Date.parse('2026-11-08T00:00:00Z') / 1000;
  const reqEnd = Date.parse('2026-11-14T23:59:59Z') / 1000;
  const nov1 = Date.parse('2026-11-01T00:00:00Z') / 1000;
  const mnWindow = getTfWindowStart(reqStart, 'MN1');
  assert.equal(mnWindow, nov1);
  const kept = sanitizeBars(
    [{ time: nov1, open: 69000, high: 76000, low: 65000, close: 65500, volume: 1000 }],
    mnWindow,
    reqEnd,
  );
  assert.equal(kept.length, 1);
});

test('computeMissingRanges detects missing Mon-Wed TradFi weekdays while ignoring Fri-Sun weekend', () => {
  const reqStart = Date.parse('2026-11-08T00:00:00Z') / 1000; // Sun
  const reqEnd = Date.parse('2026-11-14T20:00:00Z') / 1000; // Sat
  const thuStart = Date.parse('2026-11-12T00:00:00Z') / 1000;
  const friEnd = Date.parse('2026-11-13T20:00:00Z') / 1000;
  const onlyThuFri: Candle[] = [];
  for (let t = thuStart; t <= friEnd; t += 3600 * 6) {
    onlyThuFri.push({ time: t, open: 2650, high: 2660, low: 2645, close: 2655, volume: 10 });
  }
  const gaps = computeMissingRanges(onlyThuFri, 'M5', reqStart, reqEnd, false);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0][1] < thuStart);

  // Full Mon->Fri should report zero missing ranges over Sat
  const monStart = Date.parse('2026-11-09T00:00:00Z') / 1000;
  const fullWeek: Candle[] = [];
  for (let t = monStart; t <= friEnd; t += 3600 * 6) {
    fullWeek.push({ time: t, open: 2650, high: 2660, low: 2645, close: 2655, volume: 10 });
  }
  const fullGaps = computeMissingRanges(fullWeek, 'M5', reqStart, reqEnd, false);
  assert.equal(fullGaps.length, 0);
});

test('checkCrossTfBasisCompatibility accepts same-asset D1 vs intraday move, rejects different contract basis', () => {
  const dayStart = Date.parse('2026-11-13T00:00:00Z') / 1000;
  // Daily bar closes 0.45% lower at end of day than open
  const d1: Candle[] = [
    { time: dayStart, open: 1.106, high: 1.1065, low: 1.1005, close: 1.101, volume: 1000 },
  ];
  const h12_1: Candle = { time: dayStart, open: 1.106, high: 1.1065, low: 1.103, close: 1.1035, volume: 500 };
  const h12_2: Candle = { time: dayStart + 43200, open: 1.1035, high: 1.104, low: 1.1005, close: 1.101, volume: 500 };
  const ok = checkCrossTfBasisCompatibility(d1, 'D1', [h12_1, h12_2], 'H1', 0.008);
  assert.equal(ok.compatible, true);

  // 2% different contract (spot vs distant futures) rejected
  const diff: Candle[] = [
    { time: dayStart, open: 1.13, high: 1.131, low: 1.125, close: 1.126, volume: 500 },
  ];
  const bad = checkCrossTfBasisCompatibility(d1, 'D1', diff, 'H1', 0.008);
  assert.equal(bad.compatible, false);
});

