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
