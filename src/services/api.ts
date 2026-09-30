// export const API_BASE = "https://gap-impulse-strategy-be.onrender.com";
export const API_BASE = "http://localhost:3000";
import { demoApi } from "./demo/api.ts";
import { getCandlesWithMeta } from "./api/candles.ts";
import { SYMBOLS } from "./api/symbols.ts";
import { Candle } from "./schemas.ts";


export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const benign = () => Promise.resolve(null);

// ── translate OpenCharts timeframe → (multiplier, timespan) ────
// Verify these keys against what the UI actually passes in. Grep the
// codebase for `getCandles(` to see the timeframe strings it uses.
export const TIMEFRAME_MAP: Record<string, [string, string]> = {
  "1m": ["1", "minute"],
  "5m": ["5", "minute"],
  "15m": ["15", "minute"],
  "30m": ["30", "minute"],
  "1h": ["1", "hour"],
  "4h": ["4", "hour"],
  "1d": ["1", "day"],
  "1w": ["1", "week"],
};

// How far back to request per timeframe. Massive requires from/to.
export const LOOKBACK_MS: Record<string, number> = {
  "1m": 79 * 24 * 60 * 60 * 1000,
  "5m": 7 * 24 * 60 * 60 * 1000,
  "15m": 30 * 24 * 60 * 60 * 1000,
  "30m": 60 * 24 * 60 * 60 * 1000,
  "1h": 180 * 24 * 60 * 60 * 1000,
  "4h": 365 * 24 * 60 * 60 * 1000,
  "1d": 5 * 365 * 24 * 60 * 60 * 1000,
  "1w": 10 * 365 * 24 * 60 * 60 * 1000,
};

// Massive aggregate result
interface MassiveAgg {
  t: number; // ms since epoch UTC
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MassiveResponse {
  results?: MassiveAgg[];
  status?: string;
  error?: string;
}

export const toIsoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const liveApi = {
  ...demoApi,

  getCandles: (symbol: string, timeframe: string) =>
    getCandlesWithMeta(symbol, timeframe),

  getCandlesWithMeta: (symbol: string, timeframe: string) =>
    getCandlesWithMeta(symbol, timeframe),

  getCandlesInRange,

  getSymbols: () => Promise.resolve(SYMBOLS),
};

export const api = new Proxy(liveApi as Record<string, unknown>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return benign;
  },
}) as typeof liveApi & Record<string, (...args: any[]) => Promise<unknown>>;

// ── Add near the top of services/api.ts, next to getCandlesWithMeta ──

/**
 * Fetch one page of candles for [fromMs, toMs]. The caller decides the window
 * size — this function just forwards it to the backend's /api/stocks endpoint,
 * which accepts from/to as ISO timestamps.
 */
export async function getCandlesInRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
): Promise<{ candles: Candle[] }> {
  const [multiplier, timespan] = TIMEFRAME_MAP[timeframe] ?? ["1", "minute"];

  const url = new URL(`${API_BASE}/api/stocks`);
  url.searchParams.set("ticker", symbol);
  url.searchParams.set("multiplier", multiplier);
  url.searchParams.set("timespan", timespan);
  // Massive accepts Unix timestamps (ms) or YYYY-MM-DD — NOT ISO 8601.
  // Your function already receives millis, so just pass them through.
  url.searchParams.set("from", String(fromMs));
  url.searchParams.set("to", String(toMs));
  url.searchParams.set("session", "regular");

  const res = await fetch(url.toString());
  if (!res.ok) throw new ApiError(`Candles request failed (${res.status})`, res.status);
  const json = await res.json();

  const candles: Candle[] = (json.results ?? []).map((r: { t: number; o: number; h: number; l: number; c: number; v: number }) => ({
    time: Math.floor(r.t / 1000),
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
  }));

  return { candles };
}