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

// US equities regular trading hours: 9:30 AM – 4:00 PM ET.
// 6.5 hours = 23,400 seconds.
const SESSION_LENGTH_SEC = 6.5 * 3600; // 23400

// A candle is "the last one of the day" if the next candle would
// start past the session close. With fixed-interval bars, that means
// this candle's timestamp falls within one bar-width of the end.
const CANDLE_DURATION_SEC = 60; // set to your chart interval

export function handleGap(
    firstCandle: Candle,
    thirdCandle: Candle,
    currentDayStartTime: number,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
    dayHigh: number,
    dayLow: number,
): Gap | null {
    const lastBarStartsAt = currentDayStartTime + SESSION_LENGTH_SEC - CANDLE_DURATION_SEC;

    if (thirdCandle.time >= lastBarStartsAt) return null;

    // Reject gaps whose third candle is still inside the opening
    // window. Because candles are chronological, if the third is
    // in the window then so are the first two — one check covers all.
    const pastOpeningWindow = thirdCandle.time >= currentDayStartTime + OPENING_WINDOW_SEC;

    if (!pastOpeningWindow) return null;

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