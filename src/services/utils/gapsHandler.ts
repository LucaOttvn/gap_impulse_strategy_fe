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
): Gap | null {

    // Reject gaps whose third candle is still inside the opening
    // window. Because candles are chronological, if the third is
    // in the window then so are the first two — one check covers all.
    const pastOpeningWindow = thirdCandle.time >= currentDayStartTime + OPENING_WINDOW_SEC;

    if (!pastOpeningWindow) return null;

    const isBullishGap = firstCandle.high < thirdCandle.low;
    const isBearishGap = firstCandle.low > thirdCandle.high;

    if (isBullishGap) {
        const newGap: Gap = {
            startTime: firstCandle.time,
            endTime: thirdCandle.time,
            topPrice: thirdCandle.low,
            bottomPrice: firstCandle.high,
            direction: "bullish",
        }
        // Gap rectangles are ALWAYS drawn, regardless of the
        // fib lock. Only fib activation is gated by it.
        drawGap(
            newGap,
            candleSeries,
            primitives,
        );
        return newGap;
    } else if (isBearishGap) {
        const newGap: Gap = {
            startTime: firstCandle.time,
            endTime: thirdCandle.time,
            topPrice: firstCandle.low,
            bottomPrice: thirdCandle.high,
            direction: "bearish",
        }
        drawGap(
            newGap,
            candleSeries,
            primitives,
        );
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