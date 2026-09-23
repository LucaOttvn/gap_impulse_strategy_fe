import { Candle } from "../schemas";

export type EmaHandler = (candle: Candle) => number;

/**
 * Returns a stateful EMA function: call the result once per candle and
 * it returns the running EMA value, or `null` during the warm-up phase.
 *
 * The trick is the closure. `emaValue` / `seedSum` / `seedCount` are
 * declared here in the factory, NOT inside the returned function, so
 * they belong to this one call of `createEMAHandler` and persist across
 * every invocation of the returned function. Calling the factory twice
 * gives two independent handlers with their own private state — useful
 * for running multiple EMAs (e.g. 21 and 50) side by side.
 *
 * Warm-up: for the first `period` candles, the function simply
 * accumulates closes and returns `null`. On the `period`-th call it
 * seeds `emaValue` with their SMA (matching TradingView's `ta.ema`),
 * then switches to the standard exponential recurrence.
 */
export function createEMAHandler(period: number): EmaHandler {
    const k = 2 / (period + 1);
    let emaValue: number | null = null;
    let seedSum = 0;
    let seedCount = 0;

    return (candle: Candle): number => {
        if (emaValue === null) {
            seedSum += candle.close;
            seedCount += 1;
            if (seedCount === period) {
                emaValue = seedSum / period;
                return emaValue;
            }
            return 0;
        }
        emaValue = candle.close * k + emaValue * (1 - k);
        return emaValue;
    };
}