// EMAHandler.ts
import { Candle } from "../schemas";

export type EmaHandler = (candle: Candle) => number | null;

export function createEMAHandler(period: number): EmaHandler {
    const k = 2 / (period + 1);
    let emaValue: number | null = null;
    let seedSum = 0;
    let seedCount = 0;

    return (candle: Candle): number | null => {
        if (emaValue === null) {
            seedSum += candle.close;
            seedCount += 1;
            if (seedCount === period) {
                emaValue = seedSum / period;
                return emaValue;
            }
            return null;
        }
        emaValue = candle.close * k + emaValue * (1 - k);
        return emaValue;
    };
}