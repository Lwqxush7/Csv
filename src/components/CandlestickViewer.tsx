import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import type { Candle, Timeframe } from '../types/market';
import { TF_SECONDS } from '../data/pairs';
import { findIndexAtOrBefore, getCandleSpanSec, getSymbolDecimals, isoUtc } from '../utils/candles';

interface LightweightChartsGlobal {
  createChart: (
    container: HTMLElement,
    options: Record<string, unknown>,
  ) => {
    addCandlestickSeries: (opts: Record<string, unknown>) => ChartSeries;
    addHistogramSeries: (opts: Record<string, unknown>) => HistogramSeries;
    subscribeClick: (cb: (param: { time?: number }) => void) => void;
    unsubscribeClick?: (cb: (param: { time?: number }) => void) => void;
    timeScale: () => { fitContent: () => void };
    priceScale: (id: string) => { applyOptions: (opts: Record<string, unknown>) => void };
    resize: (w: number, h: number) => void;
    remove: () => void;
  };
}

interface ChartSeries {
  setData: (data: unknown[]) => void;
  update: (bar: unknown) => void;
  applyOptions: (opts: Record<string, unknown>) => void;
  createPriceLine: (opts: Record<string, unknown>) => unknown;
  removePriceLine: (pl: unknown) => void;
}

interface HistogramSeries {
  setData: (data: unknown[]) => void;
  update: (bar: unknown) => void;
  applyOptions: (opts: Record<string, unknown>) => void;
}

interface Props {
  symbol: string;
  activeTf: Timeframe;
  csvTimeframes: Partial<Record<Timeframe, Candle[]>>;
  onSwitchTf: (tf: Timeframe) => void;
  onNotify: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  onVisibleBarsChange?: (bars: Candle[]) => void;
}

interface TestTrade {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTime: number;
  entryIndex: number;
}

export function CandlestickViewer({
  symbol,
  activeTf,
  csvTimeframes,
  onSwitchTf,
  onNotify,
  onVisibleBarsChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<LightweightChartsGlobal['createChart']> | null>(null);
  const candleSeriesRef = useRef<ChartSeries | null>(null);
  const volumeSeriesRef = useRef<HistogramSeries | null>(null);
  const priceLineRef = useRef<unknown | null>(null);

  const [chartLibMissing, setChartLibMissing] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [rpPicking, setRpPicking] = useState(false);
  const [rpActive, setRpActive] = useState(false);
  const [rpPlaying, setRpPlaying] = useState(false);
  const [rpSpeedMs, setRpSpeedMs] = useState(400);
  const [rpIndex, setRpIndex] = useState(-1);
  const [displayCandles, setDisplayCandles] = useState<Candle[]>([]);
  const [openTrade, setOpenTrade] = useState<TestTrade | null>(null);

  const rpStateRef = useRef({
    rpPicking: false,
    rpActive: false,
    rpIndex: -1,
    rpKnownTimeEnd: 0,
    formingBarIdx: -1,
    displayCandles: [] as Candle[],
    activeTf,
    csvTimeframes,
  });

  rpStateRef.current.rpPicking = rpPicking;
  rpStateRef.current.rpActive = rpActive;
  rpStateRef.current.rpIndex = rpIndex;
  rpStateRef.current.displayCandles = displayCandles;
  rpStateRef.current.activeTf = activeTf;
  rpStateRef.current.csvTimeframes = csvTimeframes;

  const dec = useMemo(() => getSymbolDecimals(symbol, displayCandles), [symbol, displayCandles]);

  // Mount chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const lw = (window as unknown as { LightweightCharts?: LightweightChartsGlobal }).LightweightCharts;
    if (!lw) {
      setChartLibMissing(true);
      return;
    }

    const chart = lw.createChart(el, {
      width: el.clientWidth || 800,
      height: 430,
      layout: {
        background: { type: 'solid', color: '#0b1222' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const handleClick = (param: { time?: number }) => {
      const snap = rpStateRef.current;
      if (!snap.rpPicking || !snap.displayCandles.length || param?.time === undefined) return;
      const idx = snap.displayCandles.findIndex((c) => c.time === param.time);
      if (idx === -1) return;

      const bar = snap.displayCandles[idx];
      rpStateRef.current.formingBarIdx = -1;
      rpStateRef.current.rpKnownTimeEnd = bar.time + getCandleSpanSec(snap.activeTf, bar.time) - 1;
      setRpPicking(false);
      setRpActive(true);
      setRpPlaying(false);
      setRpIndex(idx);
      setOpenTrade(null);
    };

    chart.subscribeClick(handleClick);
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) chart.resize(el.clientWidth, 430);
    });
    ro.observe(el);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Reset on symbol or dataset reload
  const prevTfRef = useRef<Timeframe>(activeTf);
  const prevSymRef = useRef<string>(symbol);

  useEffect(() => {
    const rawBars = csvTimeframes[activeTf] || [];
    if (prevSymRef.current !== symbol) {
      prevSymRef.current = symbol;
      prevTfRef.current = activeTf;
      rpStateRef.current.formingBarIdx = -1;
      setRpActive(false);
      setRpPicking(false);
      setRpPlaying(false);
      setRpIndex(-1);
      setOpenTrade(null);
      setDisplayCandles(rawBars);
      return;
    }

    if (prevTfRef.current !== activeTf) {
      const prevTf = prevTfRef.current;
      prevTfRef.current = activeTf;

      if (rpActive && !rpPicking && rpIndex >= 0 && displayCandles.length) {
        const knownEnd = rpStateRef.current.rpKnownTimeEnd;
        const nextSec = TF_SECONDS[activeTf] || 900;
        const prevSec = TF_SECONDS[prevTf] || 900;

        let closedIdx = -1;
        for (let i = 0; i < rawBars.length; i++) {
          if (rawBars[i].time + getCandleSpanSec(activeTf, rawBars[i].time) - 1 <= knownEnd) {
            closedIdx = i;
          } else {
            break;
          }
        }

        let builtDisplay = rawBars;
        let newReplayIdx = closedIdx;
        let nextFormingIdx = -1;

        if (nextSec > prevSec) {
          const fc = rawBars[closedIdx + 1];
          if (fc && fc.time <= knownEnd) {
            const sub = displayCandles
              .slice(0, rpIndex + 1)
              .filter((b) => b.time >= fc.time && b.time <= knownEnd);
            if (sub.length > 0) {
              const formingBar: Candle = {
                time: fc.time,
                open: sub[0].open,
                high: Math.max(...sub.map((b) => b.high)),
                low: Math.min(...sub.map((b) => b.low)),
                close: sub[sub.length - 1].close,
                volume: sub.reduce((acc, b) => acc + (b.volume || 0), 0),
              };
              builtDisplay = [
                ...rawBars.slice(0, closedIdx + 1),
                formingBar,
                ...rawBars.slice(closedIdx + 2),
              ];
              newReplayIdx = closedIdx + 1;
              nextFormingIdx = closedIdx + 1;
            }
          }
        }

        if (newReplayIdx < 0) {
          prevTfRef.current = prevTf;
          onSwitchTf(prevTf);
          onNotify(`${activeTf} diliminde bu tarihte henüz kapanmış mum yok.`, 'err');
          return;
        }

        rpStateRef.current.formingBarIdx = nextFormingIdx;
        setDisplayCandles(builtDisplay);
        setRpIndex(newReplayIdx);
        setOpenTrade((t) =>
          t ? { ...t, entryIndex: Math.min(newReplayIdx, Math.max(0, findIndexAtOrBefore(builtDisplay, t.entryTime))) } : null,
        );
        return;
      }
    }

    setDisplayCandles(rawBars);
    if (!rpActive) {
      setRpIndex(-1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, activeTf, csvTimeframes]);

  // Sync chart series data
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!cs || !vs || !chart) return;

    cs.applyOptions({
      priceFormat: {
        type: 'price',
        precision: dec,
        minMove: Number((1 / Math.pow(10, dec)).toFixed(dec)),
      },
    });

    const visible = rpActive && rpIndex >= 0 ? displayCandles.slice(0, rpIndex + 1) : displayCandles;
    cs.setData(visible);

    if (showVolume) {
      vs.setData(
        visible.map((b) => ({
          time: b.time,
          value: b.volume || 0,
          color: b.close >= b.open ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)',
        })),
      );
    } else {
      vs.setData([]);
    }

    if (!rpActive && visible.length) {
      chart.timeScale().fitContent();
    }

    onVisibleBarsChange?.(visible);
  }, [displayCandles, rpActive, rpIndex, dec, showVolume, onVisibleBarsChange]);

  // Trade entry price line
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;
    if (priceLineRef.current) {
      try {
        cs.removePriceLine(priceLineRef.current);
      } catch {
        // ignore
      }
      priceLineRef.current = null;
    }
    if (rpActive && openTrade) {
      priceLineRef.current = cs.createPriceLine({
        price: openTrade.entryPrice,
        color: openTrade.side === 'LONG' ? '#10b981' : '#f43f5e',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: openTrade.side === 'LONG' ? 'Long Giriş' : 'Short Giriş',
      });
    }
  }, [rpActive, openTrade]);

  // Step replay
  const stepReplay = (delta: number) => {
    if (!rpActive) return;
    const nextIdx = rpIndex + delta;
    if (nextIdx < 0 || nextIdx >= displayCandles.length) {
      setRpPlaying(false);
      return;
    }

    if (rpStateRef.current.formingBarIdx !== -1 && rpIndex === rpStateRef.current.formingBarIdx) {
      const realBar = csvTimeframes[activeTf]?.[rpIndex];
      if (realBar) {
        const nextList = displayCandles.slice();
        nextList[rpIndex] = realBar;
        setDisplayCandles(nextList);
      }
      rpStateRef.current.formingBarIdx = -1;
    }

    const bar = displayCandles[nextIdx];
    rpStateRef.current.rpKnownTimeEnd = bar.time + getCandleSpanSec(activeTf, bar.time) - 1;
    setRpIndex(nextIdx);
    if (openTrade && nextIdx < openTrade.entryIndex) setOpenTrade(null);
  };

  useEffect(() => {
    if (!rpPlaying || !rpActive) return;
    const id = setInterval(() => {
      stepReplay(1);
    }, rpSpeedMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpPlaying, rpActive, rpIndex, rpSpeedMs, displayCandles]);

  const currentBar = rpActive && rpIndex >= 0 ? displayCandles[rpIndex] : null;
  const pnl =
    openTrade && currentBar
      ? openTrade.side === 'LONG'
        ? currentBar.close - openTrade.entryPrice
        : openTrade.entryPrice - currentBar.close
      : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!displayCandles.length || chartLibMissing}
            onClick={() => {
              setRpPlaying(false);
              const nextPick = !rpPicking;
              setRpPicking(nextPick);
              if (nextPick) {
                setRpActive(false);
                setRpIndex(-1);
                setOpenTrade(null);
                rpStateRef.current.formingBarIdx = -1;
                setDisplayCandles(csvTimeframes[activeTf] || displayCandles);
              }
            }}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              rpPicking
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
            } disabled:opacity-40`}
          >
            <Crosshair className="h-3.5 w-3.5" />
            {rpPicking ? 'Muma Tıklayın...' : 'Replay Başlangıç Seç'}
          </button>

          <button
            type="button"
            aria-label="Önceki Mum"
            disabled={!rpActive || rpIndex <= 0}
            onClick={() => {
              setRpPlaying(false);
              stepReplay(-1);
            }}
            className="rounded-md border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-35"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>

          {rpPlaying ? (
            <button
              type="button"
              aria-label="Duraklat"
              onClick={() => setRpPlaying(false)}
              className="rounded-md border border-amber-500/50 bg-amber-500/15 p-1.5 text-amber-300 hover:bg-amber-500/25"
            >
              <Pause className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Oynat"
              disabled={!rpActive || rpIndex >= displayCandles.length - 1}
              onClick={() => setRpPlaying(true)}
              className="rounded-md border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-35"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            aria-label="Sonraki Mum"
            disabled={!rpActive || rpIndex >= displayCandles.length - 1}
            onClick={() => {
              setRpPlaying(false);
              stepReplay(1);
            }}
            className="rounded-md border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-35"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>

          <select
            aria-label="Replay Hızı"
            value={rpSpeedMs}
            onChange={(e) => setRpSpeedMs(Number(e.target.value))}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            <option value={800}>0.5x</option>
            <option value={400}>1x</option>
            <option value={180}>2x</option>
            <option value={80}>5x</option>
          </select>

          <button
            type="button"
            disabled={!rpActive}
            onClick={() => {
              setRpPlaying(false);
              setRpActive(false);
              setRpIndex(-1);
              setOpenTrade(null);
              rpStateRef.current.formingBarIdx = -1;
              setDisplayCandles(csvTimeframes[activeTf] || displayCandles);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-35 whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Tamamı
          </button>

          <span className="ml-1 text-xs text-slate-400 font-mono-num">
            {rpPicking
              ? 'Grafikten başlangıç mumuna tıklayın'
              : rpActive && currentBar
                ? `Replay ${rpIndex + 1}/${displayCandles.length} · ${isoUtc(currentBar.time)}`
                : `${displayCandles.length.toLocaleString('tr-TR')} mum`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-300 select-none">
            <input
              type="checkbox"
              checked={showVolume}
              onChange={(e) => setShowVolume(e.target.checked)}
              className="accent-blue-500"
            />
            Hacim
          </label>

          {rpActive && !openTrade && currentBar && (
            <>
              <button
                type="button"
                onClick={() =>
                  setOpenTrade({
                    side: 'LONG',
                    entryPrice: currentBar.close,
                    entryTime: currentBar.time,
                    entryIndex: rpIndex,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 whitespace-nowrap"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Test Long
              </button>
              <button
                type="button"
                onClick={() =>
                  setOpenTrade({
                    side: 'SHORT',
                    entryPrice: currentBar.close,
                    entryTime: currentBar.time,
                    entryIndex: rpIndex,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/25 whitespace-nowrap"
              >
                <TrendingDown className="h-3.5 w-3.5" />
                Test Short
              </button>
            </>
          )}

          {rpActive && openTrade && (
            <div className="flex items-center gap-2 text-xs font-mono-num">
              <span className={pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {openTrade.side} @ {openTrade.entryPrice.toFixed(dec)} · Fark:{' '}
                {pnl >= 0 ? '+' : ''}
                {pnl.toFixed(dec)}
              </span>
              <button
                type="button"
                onClick={() => setOpenTrade(null)}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-slate-300 hover:text-white"
              >
                <X className="h-3 w-3" />
                Kapat
              </button>
            </div>
          )}
        </div>
      </div>

      {chartLibMissing ? (
        <div className="flex h-[430px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-400">
          Grafik kütüphanesi yüklenemedi, ancak tüm CSV verileri hazırlanıp indirilebilir.
        </div>
      ) : (
        <div
          ref={containerRef}
          data-testid="candlestick-chart"
          className={`h-[430px] w-full overflow-hidden rounded-lg border bg-[#0b1222] ${
            rpPicking ? 'cursor-crosshair border-sky-500' : 'border-slate-800'
          }`}
        />
      )}
    </div>
  );
}
