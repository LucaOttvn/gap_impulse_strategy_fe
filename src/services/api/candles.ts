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