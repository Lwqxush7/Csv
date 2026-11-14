import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  Download,
  FileSpreadsheet,
  FolderUp,
  Loader2,
  Play,
  Search,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { CandlestickViewer } from './components/CandlestickViewer';
import { SettingsView } from './components/SettingsView';
import { ALL_TF_NAMES, CATEGORIES, PAIRS, STORAGE_KEYS } from './data/pairs';
import { FetchCancelledError, fetchAllTimeframesFromMarket, getSettings } from './services/marketApi';
import type {
  AppSettings,
  Candle,
  CategoryId,
  CsvTimeFormat,
  FetchProgress,
  TfMeta,
  Timeframe,
} from './types/market';
import {
  buildCsvHeader,
  buildMergedCsv,
  buildSingleTfCsv,
  calcCalendarDays,
  formatCsvTimestamp,
  getSymbolDecimals,
  inferSymbolFromFilename,
  parseSingleOrMergedCsv,
  sanitizeBars,
  shortDateUtc,
  toYMD,
} from './utils/candles';

interface ToastItem {
  id: number;
  msg: string;
  type: 'ok' | 'err' | 'info';
}

function getQuickDates(days: number | 'month'): { start: string; end: string } {
  const now = new Date();
  const end = toYMD(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const start =
    days === 'month'
      ? toYMD(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
      : toYMD(
          new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate() - (Math.max(1, days) - 1),
            ),
          ),
        );
  return { start, end };
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function App() {
  const initialDates = useMemo(() => getQuickDates(29), []);

  const [tab, setTab] = useState<'hub' | 'settings'>('hub');
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [selectedPair, setSelectedPair] = useState<string>('BTCUSD');
  const [categoryFilter, setCategoryFilter] = useState<'all' | CategoryId>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [startDate, setStartDate] = useState(initialDates.start);
  const [endDate, setEndDate] = useState(initialDates.end);
  const [activeQuick, setActiveQuick] = useState<string>('29');
  const [selectedTfs, setSelectedTfs] = useState<Timeframe[]>(ALL_TF_NAMES);

  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);

  const [loadedSymbol, setLoadedSymbol] = useState<string>('');
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [csvTimeframes, setCsvTimeframes] = useState<Partial<Record<Timeframe, Candle[]>>>({});
  const [tfMeta, setTfMeta] = useState<Partial<Record<Timeframe, TfMeta>>>({});
  const [activeTf, setActiveTf] = useState<Timeframe>('M15');
  const [visibleChartBars, setVisibleChartBars] = useState<Candle[]>([]);
  const [tableDescending, setTableDescending] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const notify = useCallback((msg: string, type: 'ok' | 'err' | 'info' = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const reloadSettings = useCallback(() => {
    setSettings(getSettings());
  }, []);

  const filteredPairs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return Object.values(PAIRS).filter((p) => {
      if (categoryFilter !== 'all' && p.cat !== categoryFilter) return false;
      if (!q) return true;
      return `${p.code} ${p.name} ${p.keywords} ${CATEGORIES[p.cat].title}`.toLowerCase().includes(q);
    });
  }, [categoryFilter, searchQuery]);

  const activePairObj = PAIRS[selectedPair];
  const calDays = calcCalendarDays(startDate, endDate);

  const availableTfs = useMemo(
    () => ALL_TF_NAMES.filter((tf) => (csvTimeframes[tf]?.length || 0) > 0),
    [csvTimeframes],
  );

  const totalRows = useMemo(
    () => availableTfs.reduce((sum, tf) => sum + (csvTimeframes[tf]?.length || 0), 0),
    [availableTfs, csvTimeframes],
  );

  const loadDataset = (
    symbol: string,
    tfMap: Partial<Record<Timeframe, Candle[]>>,
    meta: Partial<Record<Timeframe, TfMeta>>,
    sStr: string,
    eStr: string,
  ) => {
    const avail = ALL_TF_NAMES.filter((k) => (tfMap[k]?.length || 0) > 0);
    if (!avail.length) return;
    const initialTf = avail.includes('M15') ? 'M15' : avail.includes('H1') ? 'H1' : avail[0];
    setLoadedSymbol(symbol);
    setLoadedRange({ start: sStr, end: eStr });
    setCsvTimeframes(tfMap);
    setTfMeta(meta);
    setActiveTf(initialTf);
    setVisibleChartBars(tfMap[initialTf] || []);
  };

  const handlePrepare = async () => {
    if (fetching) return;
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    setFetching(true);
    setProgress({
      message: `${selectedPair} verileri hazırlanıyor...`,
      completedSteps: 0,
      totalSteps: selectedTfs.length,
    });

    try {
      const result = await fetchAllTimeframesFromMarket(
        selectedPair,
        startDate,
        endDate,
        selectedTfs,
        ctrl.signal,
        (p) => setProgress(p),
      );
      loadDataset(selectedPair, result.out, result.meta, startDate, endDate);

      const readyCount = selectedTfs.filter((k) => (result.out[k]?.length || 0) > 0).length;
      const partialCount = selectedTfs.filter((k) => result.meta[k]?.status === 'partial').length;
      if (ctrl.signal.aborted) {
        notify(`İşlem durduruldu; alınan ${readyCount}/${selectedTfs.length} zaman dilimi yüklendi.`, 'info');
      } else if (partialCount > 0 || readyCount < selectedTfs.length) {
        notify(`${selectedPair}: ${readyCount}/${selectedTfs.length} dilim alındı. Detayları kartlarda görebilirsiniz.`, 'info');
      } else {
        notify(`${selectedPair} için ${readyCount} zaman dilimi eksiksiz ve kronolojik sırada hazırlandı.`, 'ok');
      }
    } catch (err) {
      if (!(err instanceof FetchCancelledError)) {
        notify(`Hata: ${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    } finally {
      abortCtrlRef.current = null;
      setFetching(false);
      setProgress(null);
    }
  };

  const handleStopFetch = () => {
    abortCtrlRef.current?.abort();
  };

  const handleUploadCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;

    const mergedByTf: Partial<Record<Timeframe, Map<number, Candle>>> = {};
    let lockedSym = '';
    let droppedTotal = 0;

    for (const f of files) {
      const text = await f.text();
      const parsed = parseSingleOrMergedCsv(text, f.name);
      const fileSym = parsed.lockedSymbol || inferSymbolFromFilename(f.name) || selectedPair;
      if (!lockedSym) lockedSym = fileSym;
      else if (fileSym !== lockedSym) {
        notify(`Tek Sembol Koruması: "${f.name}" (${fileSym}) dosyası ${lockedSym} ile karışmaması için atlandı.`, 'err');
        continue;
      }
      droppedTotal += parsed.droppedRows;
      for (const tf of Object.keys(parsed.byTf) as Timeframe[]) {
        if (!mergedByTf[tf]) mergedByTf[tf] = new Map();
        for (const bar of parsed.byTf[tf] || []) {
          mergedByTf[tf]!.set(bar.time, bar);
        }
      }
    }

    const finalMap: Partial<Record<Timeframe, Candle[]>> = {};
    const finalMeta: Partial<Record<Timeframe, TfMeta>> = {};
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (const tf of Object.keys(mergedByTf) as Timeframe[]) {
      const arr = sanitizeBars(Array.from(mergedByTf[tf]!.values()));
      if (arr.length) {
        finalMap[tf] = arr;
        finalMeta[tf] = { status: 'ok', source: 'CSV Dosyası', note: 'Dosyadan yüklendi' };
        if (arr[0].time < minTs) minTs = arr[0].time;
        if (arr[arr.length - 1].time > maxTs) maxTs = arr[arr.length - 1].time;
      }
    }

    if (!Object.keys(finalMap).length) {
      notify('Yüklenen dosyalarda geçerli OHLC verisi bulunamadı.', 'err');
      return;
    }

    const sStr = Number.isFinite(minTs) ? toYMD(new Date(minTs * 1000)) : startDate;
    const eStr = Number.isFinite(maxTs) ? toYMD(new Date(maxTs * 1000)) : endDate;
    loadDataset(lockedSym || selectedPair, finalMap, finalMeta, sStr, eStr);
    notify(
      droppedTotal > 0
        ? `Tek Sembol Koruması: Farklı sembole ait ${droppedTotal} satır elendi.`
        : `${Object.keys(finalMap).length} zaman dilimi tek birleşik CSV olarak hazırlandı.`,
      droppedTotal > 0 ? 'info' : 'ok',
    );
  };

  const toggleTimeframeSelection = (tf: Timeframe) => {
    setSelectedTfs((prev) => {
      if (prev.includes(tf)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== tf);
      }
      return ALL_TF_NAMES.filter((x) => x === tf || prev.includes(x));
    });
  };

  const activeBars = csvTimeframes[activeTf] || [];
  const activeDec = getSymbolDecimals(loadedSymbol || selectedPair, activeBars);
  const tableRows = useMemo(() => {
    const source = visibleChartBars.length ? visibleChartBars : activeBars;
    const slice = source.slice(-100);
    return tableDescending ? [...slice].reverse() : slice;
  }, [visibleChartBars, activeBars, tableDescending]);

  const activeApiList = useMemo(() => {
    if (settings.cfdPriority === 'free') return 'Sadece Ücretsiz Kaynaklar';
    const list: string[] = [];
    if (settings.tiingoKey) list.push('Tiingo FX');
    if (settings.tdKey) list.push('Twelve Data');
    if (settings.fmpKey) list.push('FMP');
    return list.length ? `Ücretsiz + ${list.join(', ')}` : 'Ücretsiz Kaynaklar (API anahtarı yok)';
  }, [settings]);

  return (
    <div className="min-h-screen bg-[#090e1a] text-slate-100">
      {/* Top Bar (Clean 3-Zone Contract) */}
      <header className="border-b border-slate-800/90 bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2.5 px-3.5 py-3 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-3.5">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <FileSpreadsheet className="h-5 w-5 text-blue-400 shrink-0" />
            <span className="text-sm font-semibold tracking-tight text-white sm:text-base">
              CFD &amp; Kripto CSV Merkezi
            </span>
          </div>

          <nav className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1 shrink-0">
            <button
              type="button"
              onClick={() => setTab('hub')}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap sm:px-3.5 ${
                tab === 'hub' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Veri Merkezi
            </button>
            <button
              type="button"
              onClick={() => setTab('settings')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap sm:px-3.5 ${
                tab === 'settings' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              Ayarlar &amp; API
            </button>
          </nav>

          <div className="hidden text-xs text-slate-400 md:block whitespace-nowrap shrink-0">
            {fetching && progress ? (
              <span className="text-amber-300">{progress.message}</span>
            ) : loadedSymbol ? (
              <span className="text-emerald-400">
                {loadedSymbol} · {availableTfs.length} Dilim Hazır
              </span>
            ) : (
              <span>{activeApiList}</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === 'settings' ? (
          <SettingsView
            settings={settings}
            onSettingsChange={reloadSettings}
            onBackToHub={() => setTab('hub')}
            onNotify={notify}
          />
        ) : (
          <div className="space-y-8">
            {/* Step 1 & 2: Setup Panel */}
            <section className="space-y-6 rounded-xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
              {/* Step 1: Instrument */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">1. Enstrüman Seçimi</h2>
                    <p className="text-xs text-slate-400">
                      Seçili: <span className="font-medium text-white">{selectedPair}</span> —{' '}
                      {activePairObj?.name}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                      {(['all', 'forex', 'index', 'commodity', 'crypto'] as const).map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setCategoryFilter(cat)}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                            categoryFilter === cat
                              ? 'bg-slate-800 text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {cat === 'all' ? 'Tümü' : CATEGORIES[cat].shortTitle}
                        </button>
                      ))}
                    </div>

                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        aria-label="Enstrüman ara"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Ara (BTC, Altın, EUR...)"
                        className="w-48 rounded-lg border border-slate-800 bg-slate-950 py-1.5 pl-8 pr-7 text-xs text-white placeholder-slate-500 outline-none focus:border-blue-500"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          aria-label="Aramayı temizle"
                          onClick={() => setSearchQuery('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {filteredPairs.length === 0 ? (
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-center text-xs text-slate-400">
                    "{searchQuery}" ile eşleşen enstrüman bulunamadı.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                    {filteredPairs.map((item) => {
                      const active = selectedPair === item.code;
                      return (
                        <button
                          key={item.code}
                          type="button"
                          onClick={() => setSelectedPair(item.code)}
                          className={`flex flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors ${
                            active
                              ? 'border-blue-500 bg-blue-500/10 text-white'
                              : 'border-slate-800 bg-slate-950/60 text-slate-300 hover:border-slate-700 hover:bg-slate-900'
                          }`}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="text-sm font-semibold tracking-tight text-white">
                              {item.code}
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {CATEGORIES[item.cat].shortTitle}
                            </span>
                          </div>
                          <span className="mt-0.5 w-full truncate text-[11px] text-slate-400">
                            {item.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <hr className="border-slate-800" />

              {/* Step 2: Date Range & Timeframe Selection */}
              <div className="grid gap-6 lg:grid-cols-12">
                <div className="space-y-3 lg:col-span-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-white">2. Tarih Aralığı</h2>
                    <span className="text-xs text-slate-400 font-mono-num">
                      {calDays > 0 ? `${calDays} takvim günü` : 'Geçersiz aralık'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="startDateInput" className="mb-1 block text-xs text-slate-400">
                        Başlangıç
                      </label>
                      <input
                        id="startDateInput"
                        type="date"
                        value={startDate}
                        onChange={(e) => {
                          setStartDate(e.target.value);
                          setActiveQuick('');
                        }}
                        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white font-mono-num outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label htmlFor="endDateInput" className="mb-1 block text-xs text-slate-400">
                        Bitiş
                      </label>
                      <input
                        id="endDateInput"
                        type="date"
                        value={endDate}
                        onChange={(e) => {
                          setEndDate(e.target.value);
                          setActiveQuick('');
                        }}
                        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white font-mono-num outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ['7', '7 Gün'],
                        ['15', '15 Gün'],
                        ['29', '29 Gün'],
                        ['59', '2 Ay'],
                        ['180', '6 Ay'],
                        ['365', '1 Yıl'],
                        ['month', 'Ay Başı'],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => {
                          const d = getQuickDates(val === 'month' ? 'month' : Number(val));
                          setStartDate(d.start);
                          setEndDate(d.end);
                          setActiveQuick(val);
                        }}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                          activeQuick === val
                            ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                            : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 lg:col-span-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-white">
                      3. Çekilecek Zaman Dilimleri ({selectedTfs.length}/11)
                    </h2>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedTfs(ALL_TF_NAMES)}
                        className="text-xs text-blue-400 hover:underline"
                      >
                        Tümü (11)
                      </button>
                      <span className="text-slate-600">·</span>
                      <button
                        type="button"
                        onClick={() => setSelectedTfs(['M15', 'H1', 'H4', 'D1'])}
                        className="text-xs text-slate-400 hover:text-white"
                      >
                        Hızlı (M15, H1, H4, D1)
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {ALL_TF_NAMES.map((tf) => {
                      const active = selectedTfs.includes(tf);
                      return (
                        <button
                          key={tf}
                          type="button"
                          onClick={() => toggleTimeframeSelection(tf)}
                          className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold font-mono-num transition-colors ${
                            active
                              ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                              : 'border-slate-800 bg-slate-950 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {tf}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-4 pt-1">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={settings.includeVol}
                        onChange={(e) => {
                          localStorage.setItem(STORAGE_KEYS.includeVol, e.target.checked ? '1' : '0');
                          reloadSettings();
                        }}
                        className="accent-blue-500"
                      />
                      Volume sütunu ekle
                    </label>

                    <div className="flex items-center gap-1.5">
                      <label htmlFor="hubTimeFmt" className="text-xs text-slate-400">
                        Zaman:
                      </label>
                      <select
                        id="hubTimeFmt"
                        value={settings.csvTimeFormat}
                        onChange={(e) => {
                          localStorage.setItem(STORAGE_KEYS.csvTimeFormat, e.target.value as CsvTimeFormat);
                          reloadSettings();
                        }}
                        className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                      >
                        <option value="iso">ISO UTC</option>
                        <option value="ymdhm">YYYY-MM-DD HH:MM:SS</option>
                        <option value="unix">Unix Saniye</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <hr className="border-slate-800" />

              {/* Action Row */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={fetching}
                    onClick={handlePrepare}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
                  >
                    {fetching ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Çekiliyor...
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4" />
                        Verileri Çek &amp; Birleştir
                      </>
                    )}
                  </button>

                  {fetching && (
                    <button
                      type="button"
                      onClick={handleStopFetch}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
                    >
                      <Square className="h-3.5 w-3.5" />
                      Durdur
                    </button>
                  )}

                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap">
                    <FolderUp className="h-4 w-4 text-slate-300" />
                    Elindeki CSV&apos;leri Yükle &amp; Birleştir
                    <input
                      type="file"
                      accept=".csv,.txt"
                      multiple
                      onChange={handleUploadCsv}
                      className="hidden"
                    />
                  </label>
                </div>

                <span className="text-xs text-slate-400">
                  Kaynak Modu: <span className="text-slate-200">{activeApiList}</span>
                </span>
              </div>

              {/* Progress Strip */}
              {fetching && progress && (
                <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-200">{progress.message}</span>
                    <span className="text-slate-400 font-mono-num">
                      {progress.completedSteps}/{progress.totalSteps}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(8, Math.round((progress.completedSteps / Math.max(1, progress.totalSteps)) * 100)),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </section>

            {/* Results Section */}
            {loadedSymbol && availableTfs.length > 0 && (
              <section className="space-y-6 rounded-xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
                {/* Export Header */}
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      {loadedSymbol} · Birleşik Veri Hazır ({availableTfs.length} Zaman Dilimi)
                    </h2>
                    <p className="mt-1 text-xs text-slate-400 font-mono-num">
                      Sütunlar: {buildCsvHeader(settings.includeVol)} · Toplam{' '}
                      {totalRows.toLocaleString('tr-TR')} mum · Eskiden yeniye sıralı
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const csv = buildMergedCsv(
                          loadedSymbol,
                          csvTimeframes,
                          activeDec,
                          settings.includeVol,
                          settings.csvTimeFormat,
                          ALL_TF_NAMES,
                        );
                        const fname = `${loadedSymbol}_BIRLESIK_${availableTfs.length}TF_${loadedRange.start}_${loadedRange.end}.csv`;
                        triggerDownload(fname, csv);
                        notify(`${fname} indirildi.`, 'ok');
                      }}
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                    >
                      <Download className="h-4 w-4" />
                      Tek Birleşik CSV İndir
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        let cnt = 0;
                        for (const tf of availableTfs) {
                          const bars = csvTimeframes[tf];
                          if (!bars?.length) continue;
                          triggerDownload(
                            `${loadedSymbol}_${tf}_${loadedRange.start}_${loadedRange.end}.csv`,
                            buildSingleTfCsv(
                              loadedSymbol,
                              tf,
                              bars,
                              activeDec,
                              settings.includeVol,
                              settings.csvTimeFormat,
                            ),
                          );
                          cnt++;
                          await new Promise((r) => setTimeout(r, 150));
                        }
                        notify(`${cnt} adet ayrı CSV dosyası indirildi.`, 'ok');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Tümünü Ayrı İndir
                    </button>
                  </div>
                </div>

                {/* 11-Timeframe Grid */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-300">
                      Zaman Dilimleri (Grafiği açmak için tıklayın)
                    </span>
                    <select
                      aria-label="Grafik zaman dilimi"
                      value={activeTf}
                      onChange={(e) => setActiveTf(e.target.value as Timeframe)}
                      className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-white font-mono-num"
                    >
                      {ALL_TF_NAMES.map((tf) => (
                        <option key={tf} value={tf} disabled={!csvTimeframes[tf]?.length}>
                          {tf}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                    {ALL_TF_NAMES.filter((tf) => selectedTfs.includes(tf) || csvTimeframes[tf]?.length).map(
                      (tf) => {
                        const bars = csvTimeframes[tf] || [];
                        const has = bars.length > 0;
                        const meta = tfMeta[tf] || {
                          status: has ? 'ok' : 'error',
                          source: '',
                          note: has ? 'Tam aralık' : 'Veri alınamadı',
                        };
                        const isActive = tf === activeTf;
                        const spanText = has
                          ? `${shortDateUtc(bars[0].time, true)} – ${shortDateUtc(
                              bars[bars.length - 1].time,
                              true,
                            )}`
                          : '';

                        return (
                          <div
                            key={tf}
                            className={`flex items-start justify-between gap-2 rounded-lg border p-3 transition-colors ${
                              isActive
                                ? 'border-blue-500 bg-blue-500/10'
                                : !has
                                  ? 'border-rose-900/50 bg-rose-950/15 opacity-75'
                                  : meta.status === 'partial'
                                    ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-400/60'
                                    : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                            }`}
                          >
                            <button
                              type="button"
                              disabled={!has}
                              onClick={() => has && setActiveTf(tf)}
                              className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-white font-mono-num">
                                  {tf}
                                </span>
                                <span className="text-xs text-slate-400 font-mono-num">
                                  {has ? `${bars.length.toLocaleString('tr-TR')} mum` : 'Veri yok'}
                                </span>
                              </div>
                              {has && (
                                <div className="mt-0.5 text-[11px] text-sky-300 font-mono-num">
                                  {spanText}
                                </div>
                              )}
                              <div
                                className={`mt-1 text-[11px] leading-snug ${
                                  !has
                                    ? 'text-rose-400'
                                    : meta.status === 'partial'
                                      ? 'text-amber-300'
                                      : 'text-emerald-400'
                                }`}
                              >
                                {!has
                                  ? meta.note
                                  : meta.status === 'partial'
                                    ? meta.note
                                    : `${meta.source || 'Doğrulandı'} · Tam`}
                              </div>
                            </button>

                            {has && (
                              <button
                                type="button"
                                aria-label={`${tf} CSV indir`}
                                onClick={() =>
                                  triggerDownload(
                                    `${loadedSymbol}_${tf}_${loadedRange.start}_${loadedRange.end}.csv`,
                                    buildSingleTfCsv(
                                      loadedSymbol,
                                      tf,
                                      bars,
                                      activeDec,
                                      settings.includeVol,
                                      settings.csvTimeFormat,
                                    ),
                                  )
                                }
                                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 shrink-0"
                              >
                                CSV
                              </button>
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                </div>

                {/* Chart & Replay */}
                <CandlestickViewer
                  symbol={loadedSymbol}
                  activeTf={activeTf}
                  csvTimeframes={csvTimeframes}
                  onSwitchTf={(next) => setActiveTf(next)}
                  onNotify={notify}
                  onVisibleBarsChange={setVisibleChartBars}
                />

                {/* OHLCV Data Table */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-300">
                      Veri Önizleme ({activeTf} — son {tableRows.length} mum,{' '}
                      {tableDescending ? 'Yeniden Eskiye' : 'Eskiden Yeniye / CSV Sırası'})
                    </span>
                    <button
                      type="button"
                      onClick={() => setTableDescending((v) => !v)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
                    >
                      <ArrowDownUp className="h-3.5 w-3.5" />
                      Sırayı Değiştir
                    </button>
                  </div>

                  <div className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950/70">
                    <table className="w-full border-collapse text-left text-xs font-mono-num">
                      <thead className="sticky top-0 bg-slate-900 text-[11px] uppercase text-slate-400">
                        <tr className="border-b border-slate-800">
                          <th className="px-3 py-2">symbol</th>
                          <th className="px-3 py-2">timeframe</th>
                          <th className="px-3 py-2">time</th>
                          <th className="px-3 py-2 text-right">open</th>
                          <th className="px-3 py-2 text-right">high</th>
                          <th className="px-3 py-2 text-right">low</th>
                          <th className="px-3 py-2 text-right">close</th>
                          <th className="px-3 py-2 text-right">volume</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70 text-slate-300">
                        {tableRows.map((b) => (
                          <tr key={b.time} className="hover:bg-slate-900/60">
                            <td className="px-3 py-1.5 font-medium text-amber-300">{loadedSymbol}</td>
                            <td className="px-3 py-1.5 font-medium text-sky-300">{activeTf}</td>
                            <td className="px-3 py-1.5 text-slate-100">
                              {formatCsvTimestamp(b.time, settings.csvTimeFormat)}
                            </td>
                            <td className="px-3 py-1.5 text-right">{b.open.toFixed(activeDec)}</td>
                            <td className="px-3 py-1.5 text-right">{b.high.toFixed(activeDec)}</td>
                            <td className="px-3 py-1.5 text-right">{b.low.toFixed(activeDec)}</td>
                            <td className="px-3 py-1.5 text-right font-semibold text-white">
                              {b.close.toFixed(activeDec)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-400">
                              {Math.round(b.volume || 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg border px-4 py-2.5 text-xs font-medium shadow-xl ${
              t.type === 'ok'
                ? 'border-emerald-500/60 bg-slate-900 text-emerald-200'
                : t.type === 'err'
                  ? 'border-rose-500/60 bg-slate-900 text-rose-200'
                  : 'border-sky-500/60 bg-slate-900 text-sky-100'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
