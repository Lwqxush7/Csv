export type CategoryId = 'forex' | 'index' | 'commodity' | 'crypto';

export type Timeframe =
  | 'M1'
  | 'M3'
  | 'M5'
  | 'M15'
  | 'M30'
  | 'H1'
  | 'H2'
  | 'H4'
  | 'D1'
  | 'W1'
  | 'MN1';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PairConfig {
  code: string;
  cat: CategoryId;
  name: string;
  keywords: string;
  dec: number;
  primary: string;
  fallback?: string | null;
  futuresFallback?: string | null;
  isSpotMetal?: boolean;
  td?: string | null;
  tiingo?: string;
  biquote?: string;
  biquoteAlt?: string[];
  fmp?: string;
  fmpTz?: string;
  fxBase?: string;
  fxQuote?: string;
  bitstamp?: string | null;
  kraken?: string | null;
  binance?: string;
  okx?: string;
  bybit?: string;
  coinbase?: string | null;
  kucoin?: string;
}

export type TfStatus = 'ok' | 'partial' | 'error';

export interface TfMeta {
  status: TfStatus;
  source: string;
  note: string;
}

export type CryptoProviderPref = 'auto' | 'binance' | 'okx' | 'bybit' | 'coinbase' | 'kraken' | 'bitstamp';
export type CfdPriorityPref = 'smart' | 'tiingo' | 'twelvedata' | 'yahoo' | 'free';
export type CsvTimeFormat = 'iso' | 'ymdhm' | 'unix';

export interface AppSettings {
  tdKey: string;
  tiingoKey: string;
  fmpKey: string;
  cryptoProvider: CryptoProviderPref;
  cfdPriority: CfdPriorityPref;
  includeVol: boolean;
  csvTimeFormat: CsvTimeFormat;
}

export interface FetchProgress {
  message: string;
  completedSteps: number;
  totalSteps: number;
  activeTf?: Timeframe;
  activeSource?: string;
}
