import { useState } from 'react';
import { ArrowLeft, CheckCircle2, KeyRound, RotateCcw, Server, ShieldAlert } from 'lucide-react';
import { STORAGE_KEYS } from '../data/pairs';
import { fetchApiJson, humanizeProviderError } from '../services/marketApi';
import type { AppSettings, CfdPriorityPref, CryptoProviderPref, CsvTimeFormat } from '../types/market';
import { toYMD } from '../utils/candles';

interface Props {
  settings: AppSettings;
  onSettingsChange: () => void;
  onBackToHub: () => void;
  onNotify: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}

export function SettingsView({ settings, onSettingsChange, onBackToHub, onNotify }: Props) {
  const [tiingoInput, setTiingoInput] = useState(settings.tiingoKey);
  const [tdInput, setTdInput] = useState(settings.tdKey);
  const [fmpInput, setFmpInput] = useState(settings.fmpKey);

  const [tiingoMsg, setTiingoMsg] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [tdMsg, setTdMsg] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [fmpMsg, setFmpMsg] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const testTiingo = async () => {
    const key = tiingoInput.trim();
    if (!key) {
      setTiingoMsg({ type: 'err', text: 'Önce Tiingo API token girin.' });
      return;
    }
    setTiingoMsg({ type: 'info', text: 'Bağlantı test ediliyor...' });
    try {
      const fromDate = toYMD(new Date(Date.now() - 5 * 86400000));
      const rows = (await fetchApiJson(
        `https://api.tiingo.com/tiingo/fx/eurusd/prices?startDate=${fromDate}&resampleFreq=1hour&token=${encodeURIComponent(key)}`,
        12000,
      )) as Array<{ date: string }>;
      if (!Array.isArray(rows)) throw new Error('Geçersiz yanıt');
      localStorage.setItem(STORAGE_KEYS.tiingoKey, key);
      onSettingsChange();
      setTiingoMsg({ type: 'ok', text: `Doğrulandı: ${rows.length} saatlik örnek mum alındı.` });
    } catch (err) {
      setTiingoMsg({
        type: 'err',
        text: humanizeProviderError('tiingo', err instanceof Error ? err.message : String(err), 'EURUSD'),
      });
    }
  };

  const testTd = async () => {
    const key = tdInput.trim();
    if (!key) {
      setTdMsg({ type: 'err', text: 'Önce Twelve Data API anahtarı girin.' });
      return;
    }
    setTdMsg({ type: 'info', text: 'Bağlantı test ediliyor...' });
    try {
      const json = (await fetchApiJson(
        `https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1h&outputsize=2&apikey=${encodeURIComponent(key)}`,
        12000,
      )) as { status?: string; message?: string; values?: Array<{ datetime: string }> };
      if (json.status === 'error') throw new Error(json.message || 'Geçersiz anahtar');
      if (!Array.isArray(json.values) || !json.values.length) throw new Error('Veri alınamadı');
      localStorage.setItem(STORAGE_KEYS.tdKey, key);
      onSettingsChange();
      setTdMsg({ type: 'ok', text: `Doğrulandı: EUR/USD son bar ${json.values[0].datetime}` });
    } catch (err) {
      setTdMsg({
        type: 'err',
        text: humanizeProviderError('twelvedata', err instanceof Error ? err.message : String(err), 'EURUSD'),
      });
    }
  };

  const testFmp = async () => {
    const key = fmpInput.trim();
    if (!key) {
      setFmpMsg({ type: 'err', text: 'Önce FMP API anahtarı girin.' });
      return;
    }
    setFmpMsg({ type: 'info', text: 'Bağlantı test ediliyor...' });
    try {
      const rows = (await fetchApiJson(
        `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=EURUSD&from=${toYMD(new Date(Date.now() - 7 * 86400000))}&to=${toYMD(new Date())}&apikey=${encodeURIComponent(key)}`,
        12000,
      )) as Array<{ date: string }>;
      if (!Array.isArray(rows) || !rows.length) throw new Error('Veri alınamadı');
      localStorage.setItem(STORAGE_KEYS.fmpKey, key);
      onSettingsChange();
      setFmpMsg({ type: 'ok', text: `Doğrulandı: FMP EOD verisi alındı (${rows[0].date}).` });
    } catch (err) {
      setFmpMsg({
        type: 'err',
        text: humanizeProviderError('fmp', err instanceof Error ? err.message : String(err), 'EURUSD'),
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Veri Kaynakları ve API Anahtarları</h2>
          <p className="mt-1 text-sm text-slate-400">
            Tüm istekler yerel sunucu vekili (/api/proxy) üzerinden doğrudan ve CORS hatasız çekilir.
          </p>
        </div>
        <button
          type="button"
          onClick={onBackToHub}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Veri Merkezine Dön
        </button>
      </div>

      {/* Built-in keyless sources summary */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <Server className="h-4 w-4 text-emerald-400" />
          Dahili Ücretsiz Kaynaklar (Anahtarsız Aktif)
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          Kripto için Binance, Bybit, OKX, Bitstamp, Coinbase ve Kraken; Forex için Bitstamp, Kraken, Yahoo Finance,
          biquote.io ve Frankfurter ECB; Altın/Gümüş için biquote.io Spot + Yahoo Vadeli (GC=F/SI=F, fiyatlar asla
          karıştırılmaz); Endeksler için Yahoo Finance ve biquote.io kullanılır.
        </p>
      </div>

      {/* Priority Preferences */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <label htmlFor="cryptoProviderSelect" className="block text-sm font-medium text-white">
            Öncelikli Kripto Borsası
          </label>
          <p className="text-xs text-slate-400">
            Eksik aralık kalırsa diğer borsalar otomatik tamamlar.
          </p>
          <select
            id="cryptoProviderSelect"
            value={settings.cryptoProvider}
            onChange={(e) => {
              localStorage.setItem(STORAGE_KEYS.cryptoProvider, e.target.value as CryptoProviderPref);
              onSettingsChange();
              onNotify('Kripto borsa önceliği güncellendi.', 'ok');
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          >
            <option value="auto">Otomatik (Binance → Bybit → OKX → Bitstamp → Coinbase → Kraken)</option>
            <option value="binance">Binance</option>
            <option value="bybit">Bybit</option>
            <option value="okx">OKX</option>
            <option value="bitstamp">Bitstamp</option>
            <option value="coinbase">Coinbase</option>
            <option value="kraken">Kraken</option>
          </select>
        </div>

        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <label htmlFor="cfdPrioritySelect" className="block text-sm font-medium text-white">
            Forex, Altın ve Endeks Kaynak Sırası
          </label>
          <p className="text-xs text-slate-400">
            API anahtarınız varsa önce anahtarlı kaynakları veya önce ücretsiz kaynakları seçebilirsiniz.
          </p>
          <select
            id="cfdPrioritySelect"
            value={settings.cfdPriority}
            onChange={(e) => {
              localStorage.setItem(STORAGE_KEYS.cfdPriority, e.target.value as CfdPriorityPref);
              onSettingsChange();
              onNotify('CFD/Forex kaynak sırası güncellendi.', 'ok');
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          >
            <option value="smart">Akıllı Sıra (Kayıtlı API Anahtarı Varsa Önce API → Yoksa Ücretsiz)</option>
            <option value="tiingo">Önce Tiingo FX → Twelve Data → FMP → Ücretsizler</option>
            <option value="twelvedata">Önce Twelve Data → Tiingo FX → FMP → Ücretsizler</option>
            <option value="yahoo">Önce Ücretsizler (Bitstamp/Yahoo/Kraken/biquote) → Eksikte API</option>
            <option value="free">Yalnızca Ücretsiz Kaynaklar (API Anahtarlarını Kullanma)</option>
          </select>
        </div>
      </div>

      {/* API Keys */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Tiingo */}
        <div className="flex flex-col justify-between space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white">
                <KeyRound className="h-4 w-4 text-sky-400" />
                Tiingo FX Token
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  settings.tiingoKey ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {settings.tiingoKey ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Kayıtlı
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3.5 w-3.5" /> Anahtar Yok
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Forex ve Spot Altın/Gümüş (XAUUSD, XAGUSD) için M1 dahil uzun geçmiş sağlar.
            </p>
            <input
              type="password"
              aria-label="Tiingo API Token"
              value={tiingoInput}
              onChange={(e) => setTiingoInput(e.target.value)}
              placeholder="Tiingo API Token"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const k = tiingoInput.trim();
                  localStorage.setItem(STORAGE_KEYS.tiingoKey, k);
                  setTiingoMsg(null);
                  onSettingsChange();
                  onNotify(k ? 'Tiingo token kaydedildi.' : 'Boş token kaydedildi.', k ? 'ok' : 'info');
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                Kaydet
              </button>
              <button
                type="button"
                onClick={testTiingo}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Test Et
              </button>
              <button
                type="button"
                onClick={() => {
                  setTiingoInput('');
                  localStorage.removeItem(STORAGE_KEYS.tiingoKey);
                  setTiingoMsg(null);
                  onSettingsChange();
                  onNotify('Tiingo token temizlendi.', 'info');
                }}
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Temizle
              </button>
            </div>
            {tiingoMsg && (
              <p
                className={`text-xs ${
                  tiingoMsg.type === 'ok'
                    ? 'text-emerald-400'
                    : tiingoMsg.type === 'err'
                      ? 'text-rose-400'
                      : 'text-sky-400'
                }`}
              >
                {tiingoMsg.text}
              </p>
            )}
          </div>
        </div>

        {/* Twelve Data */}
        <div className="flex flex-col justify-between space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white">
                <KeyRound className="h-4 w-4 text-sky-400" />
                Twelve Data Key
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  settings.tdKey ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {settings.tdKey ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Kayıtlı
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3.5 w-3.5" /> Anahtar Yok
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Forex &amp; Kripto'da ücretsiz çalışır (8/dk kotasında bekleyip devam eder).
            </p>
            <input
              type="password"
              aria-label="Twelve Data API Key"
              value={tdInput}
              onChange={(e) => setTdInput(e.target.value)}
              placeholder="Twelve Data API Key"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const k = tdInput.trim();
                  localStorage.setItem(STORAGE_KEYS.tdKey, k);
                  setTdMsg(null);
                  onSettingsChange();
                  onNotify(k ? 'Twelve Data anahtarı kaydedildi.' : 'Boş anahtar kaydedildi.', k ? 'ok' : 'info');
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                Kaydet
              </button>
              <button
                type="button"
                onClick={testTd}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Test Et
              </button>
              <button
                type="button"
                onClick={() => {
                  setTdInput('');
                  localStorage.removeItem(STORAGE_KEYS.tdKey);
                  setTdMsg(null);
                  onSettingsChange();
                  onNotify('Twelve Data anahtarı temizlendi.', 'info');
                }}
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Temizle
              </button>
            </div>
            {tdMsg && (
              <p
                className={`text-xs ${
                  tdMsg.type === 'ok'
                    ? 'text-emerald-400'
                    : tdMsg.type === 'err'
                      ? 'text-rose-400'
                      : 'text-sky-400'
                }`}
              >
                {tdMsg.text}
              </p>
            )}
          </div>
        </div>

        {/* FMP */}
        <div className="flex flex-col justify-between space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white">
                <KeyRound className="h-4 w-4 text-sky-400" />
                FMP API Key
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  settings.fmpKey ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {settings.fmpKey ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Kayıtlı
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3.5 w-3.5" /> Anahtar Yok
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Endeksler, emtia ve forex için isteğe bağlı ek kaynak (250 istek/gün).
            </p>
            <input
              type="password"
              aria-label="FMP API Key"
              value={fmpInput}
              onChange={(e) => setFmpInput(e.target.value)}
              placeholder="FMP API Key (isteğe bağlı)"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const k = fmpInput.trim();
                  localStorage.setItem(STORAGE_KEYS.fmpKey, k);
                  setFmpMsg(null);
                  onSettingsChange();
                  onNotify(k ? 'FMP anahtarı kaydedildi.' : 'Boş anahtar kaydedildi.', k ? 'ok' : 'info');
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                Kaydet
              </button>
              <button
                type="button"
                onClick={testFmp}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Test Et
              </button>
              <button
                type="button"
                onClick={() => {
                  setFmpInput('');
                  localStorage.removeItem(STORAGE_KEYS.fmpKey);
                  setFmpMsg(null);
                  onSettingsChange();
                  onNotify('FMP anahtarı temizlendi.', 'info');
                }}
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Temizle
              </button>
            </div>
            {fmpMsg && (
              <p
                className={`text-xs ${
                  fmpMsg.type === 'ok'
                    ? 'text-emerald-400'
                    : fmpMsg.type === 'err'
                      ? 'text-rose-400'
                      : 'text-sky-400'
                }`}
              >
                {fmpMsg.text}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Output defaults & reset */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-center gap-5">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={settings.includeVol}
              onChange={(e) => {
                localStorage.setItem(STORAGE_KEYS.includeVol, e.target.checked ? '1' : '0');
                onSettingsChange();
              }}
              className="accent-blue-500"
            />
            CSV çıktısında volume sütunu bulunsun
          </label>

          <div className="flex items-center gap-2">
            <label htmlFor="settingsTimeFmt" className="text-sm text-slate-300">
              Varsayılan Zaman Biçimi:
            </label>
            <select
              id="settingsTimeFmt"
              value={settings.csvTimeFormat}
              onChange={(e) => {
                localStorage.setItem(STORAGE_KEYS.csvTimeFormat, e.target.value as CsvTimeFormat);
                onSettingsChange();
              }}
              className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
            >
              <option value="iso">ISO UTC (2026-11-14T12:00:00Z)</option>
              <option value="ymdhm">Tarih Saat (2026-11-14 12:00:00)</option>
              <option value="unix">Unix Saniye (1794657600)</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
            setTiingoInput('');
            setTdInput('');
            setFmpInput('');
            setTiingoMsg(null);
            setTdMsg(null);
            setFmpMsg(null);
            onSettingsChange();
            onNotify('Tüm ayarlar varsayılana sıfırlandı.', 'info');
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Tüm Ayarları Sıfırla
        </button>
      </div>
    </div>
  );
}
