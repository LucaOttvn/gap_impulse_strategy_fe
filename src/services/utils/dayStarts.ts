import { Candle } from "../schemas";

// ── Day-start helpers ──────────────────────────────────────
export function dayKey(unixSeconds: number, timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
}

export function findDayStarts(candles: Candle[], timeZone = "America/New_York"): number[] {
    const indices: number[] = [];
    let prev = "";
    for (let i = 0; i < candles.length; i++) {
        if (!candles[i]) continue
        const key = dayKey(candles[i]!.time, timeZone);
        if (key !== prev) {
            indices.push(i);
            prev = key;
        }
    }
    return indices;
}

// For each candle index, the time of the first candle of its calendar day.
export function computeDayStartTimes(candles: Candle[], timeZone: string): number[] {
    const dayStartTimes: number[] = new Array(candles.length);
    let currentStart = candles[0]?.time ?? 0;
    let prevKey = "";
    for (let i = 0; i < candles.length; i++) {
        if (!candles[i]) continue
        const key = dayKey(candles[i]!.time, timeZone);
        if (key !== prevKey) {
            currentStart = candles[i]!.time;
            prevKey = key;
        }
        dayStartTimes[i] = currentStart;
    }
    return dayStartTimes;
}