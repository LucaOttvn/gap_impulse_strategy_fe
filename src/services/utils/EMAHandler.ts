import { Candle } from "../schemas";
import { dayKey } from "./dayStarts";

export interface EmaResult {
    value: number;
    /** True on the first candle of a new trading session. */
    newDay: boolean;
}

export type EmaHandler = (candle: Candle) => EmaResult;

/**
 * Stateful, session-resetting EMA.
 *
 * Same math as before, but the return value also tells the caller
 * whether this candle started a new session. The strategy uses that
 * flag to insert an `na` break into the plotted line so it stops
 * cleanly at the previous day's close and restarts on the new day,
 * instead of being drawn as one continuous curve across the gap.
 */
export function createEMAHandler(
    period: number,
    timeZone = "America/New_York",
): EmaHandler {
    const k = 2 / (period + 1);
    let emaValue: number | null = null;
    let currentDayKey = "";

    return (candle: Candle): EmaResult => {
        const key = dayKey(candle.time, timeZone);
        const newDay = key !== currentDayKey;

        if (newDay) {
            currentDayKey = key;
            emaValue = candle.close;
            return { value: emaValue, newDay: true };
        }

        emaValue = candle.close * k + emaValue! * (1 - k);
        return { value: emaValue, newDay: false };
    };
}