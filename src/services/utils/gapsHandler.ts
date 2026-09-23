import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { OPENING_WINDOW_SEC } from "./strategy";
import { GapRectanglePrimitive } from "./primitives";

export type Direction = "bullish" | "bearish";

export interface Gap {
    startTime: number; // unix seconds — left edge of the rectangle
    endTime: number;   // unix seconds — right edge of the rectangle
    topPrice: number;  // upper edge
    bottomPrice: number; // lower edge
    direction: Direction
}

export function handleGap(
    firstCandle: Candle,
    thirdCandle: Candle,
    currentDayStartTime: number,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
    dayHigh: number,
    dayLow: number,
): Gap | null {

    // Reject gaps whose third candle is still inside the opening
    // window. Because candles are chronological, if the third is
    // in the window then so are the first two — one check covers all.
    const pastOpeningWindow = thirdCandle.time >= currentDayStartTime + OPENING_WINDOW_SEC;

    if (!pastOpeningWindow) return null;

    // The third candle must agree with the gap's direction:
    //   - a bullish gap is valid only if the third candle is green
    //     (close > open) — the market kept pushing up through the void
    //   - a bearish gap is valid only if the third candle is red
    //     (close < open) — the market kept pushing down through the void
    // A doji (close === open) fails both and disqualifies the gap.
    const isThirdBullish = thirdCandle.close > thirdCandle.open;
    const isThirdBearish = thirdCandle.close < thirdCandle.open;

    const isBullishGap = firstCandle.high < thirdCandle.low && isThirdBullish;
    const isBearishGap = firstCandle.low > thirdCandle.high && isThirdBearish;

    const dayHighPassed = thirdCandle.close > dayHigh;
    const dayLowPassed = thirdCandle.close < dayLow;

    if (isBullishGap && dayHighPassed) {

        const bullishGapMinSize = firstCandle.high * 0.0005

        if (thirdCandle.low - firstCandle.high < bullishGapMinSize) return null

        const bullishThirdCandleMinSize = firstCandle.high * 0.001

        if (thirdCandle.close - thirdCandle.open < bullishThirdCandleMinSize) return null

        const newGap: Gap = {
            startTime: firstCandle.time,
            endTime: thirdCandle.time,
            topPrice: thirdCandle.low,
            bottomPrice: firstCandle.high,
            direction: "bullish",
        }
        drawGap(newGap, candleSeries, primitives,);

        return newGap;
    } else if (isBearishGap && dayLowPassed) {

        const bearishGapMinSize = firstCandle.low * 0.0005

        if (firstCandle.low - thirdCandle.high < bearishGapMinSize) return null

        const bearishThirdCandleMinSize = firstCandle.low * 0.001

        if (thirdCandle.open - thirdCandle.close < bearishThirdCandleMinSize) return null

        const newGap: Gap = {
            startTime: firstCandle.time,
            endTime: thirdCandle.time,
            topPrice: firstCandle.low,
            bottomPrice: thirdCandle.high,
            direction: "bearish",
        }
        drawGap(newGap, candleSeries, primitives,);
        return newGap;
    }
    return null;
}
/**
 * Attaches one rectangle primitive per gap. Kept separate from the
 * main loop so the caller can decide when (and how) to draw gaps,
 * and because attaching a primitive is a side effect that doesn't
 * belong in the loop's control flow.
 */
function drawGap(
    gap: Gap,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
) {
    const isBull = gap.direction === "bullish";

    const primitive = new GapRectanglePrimitive(
        gap.startTime as Time,
        gap.endTime as Time,
        gap.topPrice,
        gap.bottomPrice,
        // Bullish gaps are blue, bearish gaps are yellow. Alpha < 1
        // so price action stays visible underneath.
        isBull ? "rgba(40, 62, 255, 0.8)" : "rgba(253, 218, 62, 0.7)",
        "transparent", // no border stroke
    );
    candleSeries.attachPrimitive(primitive);
    primitives.push(primitive);
}