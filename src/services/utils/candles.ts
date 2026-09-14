import { API_BASE, ApiError, LOOKBACK_MS, MassiveResponse, TIMEFRAME_MAP, toIsoDate } from "../api";
import { Candle } from "../schemas";

const candlesMeta = (candles: Candle[]) => ({
    candles,
    metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

const tzOffsetMs = -new Date().getTimezoneOffset() * 60 * 1000;

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

    const res = await fetch(`${API_BASE}/api/stocks?${params}`);
    if (!res.ok) {
        throw new ApiError(`Candle fetch failed: ${res.status}`, res.status);
    }

    const json = (await res.json()) as MassiveResponse;
    if (!json.results) return [];

    console.log(json)

    return json.results.map((r) => ({
        time: Math.floor((r.t + tzOffsetMs) / 1000),
        timestamp: r.t,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v,
    }))
}

export async function getCandlesWithMeta(symbol: string, timeframe: string) {
    const candles = await getHistory(symbol, timeframe)
    return candlesMeta(candles)
}