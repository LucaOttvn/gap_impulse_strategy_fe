import { UTCTimestamp } from "lightweight-charts";
import { API_BASE, ApiError, LOOKBACK_MS, MassiveResponse, TIMEFRAME_MAP, toIsoDate } from "../api";
import { Candle } from "../schemas";

const candlesMeta = (candles: Candle[]) => ({
    candles,
    metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

// ── Rome offset helper ──
// `new Intl.DateTimeFormat(...)` is expensive (~50 µs per construction). The
// original code built one per bar and called formatToParts on it, which for
// a 31k-bar 1m response meant 1–3 seconds of synchronous main-thread work
// before the chart could paint.
//
// Two fixes, both cheap:
//   1. Hoist the formatter to module scope — construct it once, ever.
//   2. Cache the offset per UTC calendar day. The Rome/UTC offset only
//      changes at DST boundaries (twice a year), so within a UTC day it's
//      constant. That drops ~31,000 formatToParts calls to ~80.
const ROME_DTF = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
});

const romeOffsetCache = new Map<number, number>();

function getRomeOffsetSeconds(timestampMs: number): number {
    const dayKey = Math.floor(timestampMs / 86_400_000);
    const cached = romeOffsetCache.get(dayKey);
    if (cached !== undefined) return cached;

    const parts = Object.fromEntries(
        ROME_DTF.formatToParts(new Date(timestampMs)).map((p) => [p.type, p.value])
    );
    const romeAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour === "24" ? "0" : parts.hour), // en-GB can emit "24"
        Number(parts.minute),
        Number(parts.second),
    );
    const offset = (romeAsUtc - timestampMs) / 1000;
    romeOffsetCache.set(dayKey, offset);
    return offset;
}

export async function getHistory(symbol: string, timeframe: string): Promise<Candle[]> {
    const [multiplier, timespan] = TIMEFRAME_MAP[timeframe] ?? ["1", "day"];
    const lookback = LOOKBACK_MS[timeframe] ?? LOOKBACK_MS["1d"];

    const to = Date.now();
    const from = to - lookback!;

    const params = new URLSearchParams({
        ticker: symbol,
        multiplier,
        timespan,
        from: toIsoDate(from),
        to: toIsoDate(to),
    });

    // ── Timing: network ──
    console.time('[candles] fetch');
    const res = await fetch(`${API_BASE}/api/stocks?${params}`);
    console.timeEnd('[candles] fetch');

    if (!res.ok) {
        throw new ApiError(`Candle fetch failed: ${res.status}`, res.status);
    }

    // ── Timing: JSON parse ──
    console.time('[candles] json-parse');
    const json = (await res.json()) as MassiveResponse;
    console.timeEnd('[candles] json-parse');

    console.log('[candles] bar count:', json.results?.length ?? 0);
    console.log('[candles] response bytes:', new Blob([JSON.stringify(json)]).size);

    if (!json.results) return [];

    const isIntraday = timespan !== "day" && timespan !== "week" && timespan !== "month";

    // ── Timing: map / timestamp conversion ──
    console.time('[candles] map');
    const mapped = json.results.map((r) => {
        const utcSeconds = Math.floor(r.t / 1000);
        // Only shift intraday bars. Daily/weekly/monthly bars represent a
        // business date and must stay at UTC midnight to avoid day-boundary bugs.
        const displaySeconds = isIntraday
            ? utcSeconds + getRomeOffsetSeconds(r.t)
            : utcSeconds;

        return {
            time: displaySeconds as UTCTimestamp,
            timestamp: r.t,
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            volume: r.v,
        };
    });
    console.timeEnd('[candles] map');

    return mapped;
}

export async function getCandlesWithMeta(symbol: string, timeframe: string) {
    const candles = await getHistory(symbol, timeframe);
    return candlesMeta(candles);
}

export interface CandlePage {
  candles: Candle[];
  hasMoreBefore: boolean;
}

export interface CandleRangeResult {
  candles: Candle[];
  hasMoreBefore: boolean;
}

export async function getCandlesInRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
): Promise<CandleRangeResult> {
  const [multiplier, timespan] = TIMEFRAME_MAP[timeframe] ?? ["1", "day"];

  const params = new URLSearchParams({
    ticker: symbol,
    multiplier,
    timespan,
    from: toIsoDate(fromMs),
    to: toIsoDate(toMs),
  });

  const res = await fetch(`${API_BASE}/api/stocks?${params}`);
  if (!res.ok) {
    throw new ApiError(`Candle fetch failed: ${res.status}`, res.status);
  }

  const json = (await res.json()) as MassiveResponse;
  if (!json.results?.length) return { candles: [], hasMoreBefore: false };

  const isIntraday = timespan !== "day" && timespan !== "week" && timespan !== "month";

  const candles = json.results.map((r) => {
    const utcSeconds = Math.floor(r.t / 1000);
    const displaySeconds = isIntraday
      ? utcSeconds + getRomeOffsetSeconds(r.t)
      : utcSeconds;

    return {
      time: displaySeconds as UTCTimestamp,
      timestamp: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    };
  });

  // A page is "done" when the server returns nothing. `hasMoreBefore` is a
  // hint that we can keep walking back; the authoritative stop is an empty
  // page in useInfiniteCandles' getNextPageParam.
  return { candles, hasMoreBefore: true };
}

/**
 * A single Massive request is capped at 50,000 bars. For deep backtests we
 * split the requested range into chunks, fetch each, and merge. Requests
 * are made in small batches so we don't hammer the backend (or trip a
 * rate limiter on the Massive side).
 *
 * On the first run of a (symbol, timeframe) pair, each chunk is a cache
 * miss on the backend → fetched from Massive → written to disk. On every
 * subsequent run, every chunk is a disk hit and the whole thing returns
 * in a few hundred milliseconds.
 */

// Safe chunk size per timeframe — one chunk stays under 50k RTH bars.
const CHUNK_DAYS: Record<string, number> = {
  "1m":  90,     // ~35k bars
  "5m":  400,    // ~31k bars
  "15m": 1500,   // ~29k bars
  "30m": 3000,   // ~29k bars
  "1h":  5000,   // ~24k bars
  "4h":  5000,
  "1d":  5000,
  "1w":  5000,
};

const MAX_CONCURRENT_CHUNKS = 3;

export interface ChunkedFetchOptions {
  /** Called after each chunk resolves: (completed, total). */
  onProgress?: (completed: number, total: number) => void;
  /** Optional abort signal — checked between batches. */
  signal?: AbortSignal;
}

export async function fetchCandlesChunked(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  opts: ChunkedFetchOptions = {},
): Promise<Candle[]> {
  const chunkMs = (CHUNK_DAYS[timeframe] ?? 90) * 86_400_000;

  // Build the list of [from, to] windows.
  const chunks: Array<[number, number]> = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + chunkMs, toMs);
    chunks.push([cursor, end]);
    cursor = end;
  }

  const { onProgress, signal } = opts;
  let completed = 0;
  const results: Candle[][] = [];

  // Fetch in small parallel batches. Parallelism is bounded so the backend
  // doesn't get a burst of 20 simultaneous requests on 1m/5-year runs.
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
    const batchResults = await Promise.all(
      batch.map(([from, to]) =>
        getCandlesInRange(symbol, timeframe, from, to).then((r) => r.candles),
      ),
    );
    results.push(...batchResults);

    completed += batch.length;
    onProgress?.(completed, chunks.length);
  }

  // Merge + dedupe across seams. Chunks are day-aligned, so adjacent chunks
  // can overlap by one bar.
  const byTime = new Map<number, Candle>();
  for (const chunk of results) {
    for (const c of chunk) byTime.set(c.time as unknown as number, c);
  }
  return [...byTime.values()].sort(
    (a, b) => (a.time as unknown as number) - (b.time as unknown as number),
  );
}