
// ── Gap model ──────────────────────────────────────────────
// A "gap" is a price range that was skipped between two candles.
// We store it as a rectangle in (time, price) space so the

import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { OPENING_WINDOW_SEC } from "./strategy";
import { createPlotLine } from "./plotLine";
import { GapRectanglePrimitive } from "./primitives";

// GapRectanglePrimitive can draw it directly on the chart.
export interface Gap {
    startTime: number; // unix seconds — left edge of the rectangle
    endTime: number;   // unix seconds — right edge of the rectangle
    topPrice: number;  // upper edge
    bottomPrice: number; // lower edge
    direction: "bullish" | "bearish";
}

export function handleGap(firstCandle: Candle, thirdCandle: Candle, currentDayStart: number, candleSeries: ISeriesApi<"Candlestick">, primitives: ISeriesPrimitive<Time>[], activeFib: "bullish" | "bearish" | null, fib618: ReturnType<typeof createPlotLine> | null, fib786: ReturnType<typeof createPlotLine> | null) {
    // Reject gaps whose third candle is still inside the opening
    // window. Because candles are chronological, if the third is
    // in the window then so are the first two — one check covers all.
    const pastOpeningWindow = thirdCandle.time >= currentDayStart + OPENING_WINDOW_SEC;

    if (pastOpeningWindow) {
        const isBullishGap = firstCandle.high < thirdCandle.low;
        const isBearishGap = firstCandle.low > thirdCandle.high;

        if (isBullishGap) {
            // Gap rectangles are ALWAYS drawn, regardless of the
            // fib lock. Only fib activation is gated by it.
            drawGap(
                {
                    startTime: firstCandle.time,
                    endTime: thirdCandle.time,
                    topPrice: thirdCandle.low,
                    bottomPrice: firstCandle.high,
                    direction: "bullish",
                },
                candleSeries,
                primitives,
            );

            // First gap of the day? Lock the direction and create
            // the two bullish handles. If `activeFib` is already
            // set (from an earlier gap today, either direction),
            // this block is skipped entirely.
            if (!activeFib) {
                activeFib = "bullish";
                fib618 = createPlotLine(candleSeries, { color: "#f59e0b", mode: "step" });
                fib786 = createPlotLine(candleSeries, { color: "#22d3ee", mode: "step" });
            }
        } else if (isBearishGap) {
            drawGap(
                {
                    startTime: firstCandle.time,
                    endTime: thirdCandle.time,
                    topPrice: firstCandle.low,
                    bottomPrice: thirdCandle.high,
                    direction: "bearish",
                },
                candleSeries,
                primitives,
            );

            if (!activeFib) {
                activeFib = "bearish";
                fib618 = createPlotLine(candleSeries, { color: "#f59e0b", mode: "step" });
                fib786 = createPlotLine(candleSeries, { color: "#22d3ee", mode: "step" });
            }
        }
    }
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