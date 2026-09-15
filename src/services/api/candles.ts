import { UTCTimestamp } from "lightweight-charts";
import { API_BASE, ApiError, LOOKBACK_MS, MassiveResponse, TIMEFRAME_MAP, toIsoDate } from "../api";
import { Candle } from "../schemas";

const candlesMeta = (candles: Candle[]) => ({
    candles,
    metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

function getRomeOffsetSeconds(timestampMs: number): number {
    const dtf = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Rome",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    });
    const parts = Object.fromEntries(
        dtf.formatToParts(new Date(timestampMs)).map((p) => [p.type, p.value])
    );
    const romeAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour === "24" ? "0" : parts.hour), // en-GB can emit "24"
        Number(parts.minute),
        Number(parts.second),
    );
    return (romeAsUtc - timestampMs) / 1000;
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

    const res = await fetch(`${API_BASE}/api/stocks?${params}`);
    if (!res.ok) {
        throw new ApiError(`Candle fetch failed: ${res.status}`, res.status);
    }

    const json = (await res.json()) as MassiveResponse;
    if (!json.results) return [];

    const isIntraday = timespan !== "day" && timespan !== "week" && timespan !== "month";

    return json.results.map((r) => {

        const utcSeconds = Math.floor(r.t / 1000);
        // Only shift intraday bars. Daily/weekly/monthly bars represent a business
        // date and must stay at UTC midnight to avoid day-boundary bugs.
        const displaySeconds = isIntraday
            ? utcSeconds + getRomeOffsetSeconds(r.t)
            : utcSeconds;

        return {
            // Pass pure UTC seconds directly to Lightweight Charts
            time: displaySeconds as UTCTimestamp,
            timestamp: r.t,
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            volume: r.v,
        }
    });
}

export async function getCandlesWithMeta(symbol: string, timeframe: string) {
    const candles = await getHistory(symbol, timeframe);
    return candlesMeta(candles);
}