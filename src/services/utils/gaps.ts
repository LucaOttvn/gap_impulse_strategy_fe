import { ISeriesApi, Time, CandlestickData, WhitespaceData, CandlestickSeriesOptions, DeepPartial, CandlestickStyleOptions, SeriesOptionsCommon, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { computeDayStartTimes } from "./dayStarts";
import { GapRectanglePrimitive } from "./primitives";

// ── Gap model ──────────────────────────────────────────────
interface Gap {
    startTime: number; // unix seconds
    endTime: number;
    topPrice: number;
    bottomPrice: number;
    direction: "bullish" | "bearish";
}

// ── Detection ──────────────────────────────────────────────
// Scans every group of 3 candles [i, i+1, i+2].
// Compares candle i (first) with candle i+2 (third).
//   bullish: high[first] < low[third]
//   bearish: low[first]  > high[third]
//
// A gap is rejected when its third candle is still inside the opening
// window (first N minutes of the day in the target timezone). Because
// candles are time-ordered, if the third is inside the window then so
// are the first two — one check covers all three.
const OPENING_WINDOW_SEC = 15 * 60;

function findGaps(candles: Candle[], timeZone = "America/New_York"): Gap[] {
    const gaps: Gap[] = [];
    if (candles.length < 3) return gaps;

    const dayStartTimes = computeDayStartTimes(candles, timeZone);

    for (let i = 0; i + 2 < candles.length; i += 1) {
        const first = candles[i];
        const third = candles[i + 2];
        if (!first || !third) continue;

        // Skip gaps whose third candle is still in the opening window.
        if (third.time < dayStartTimes[i + 2]! + OPENING_WINDOW_SEC) continue;

        if (first.high < third.low) {
            gaps.push({
                startTime: first.time,
                endTime: third.time,
                topPrice: third.low,
                bottomPrice: first.high,
                direction: "bullish",
            });
        } else if (first.low > third.high) {
            gaps.push({
                startTime: first.time,
                endTime: third.time,
                topPrice: first.low,
                bottomPrice: third.high,
                direction: "bearish",
            });
        }
    }
    return gaps;
}

// ── Public entry point: gap rectangles ─────────────────────
// Attaches one rectangle primitive per detected gap.
// Returns the primitives so the caller can detach them on cleanup.
export function drawGapsImpulseStrategy(
    candleSeries: ISeriesApi<
        "Candlestick",
        Time,
        CandlestickData<Time> | WhitespaceData<Time>,
        CandlestickSeriesOptions,
        DeepPartial<CandlestickStyleOptions & SeriesOptionsCommon>
    >,
    candles: Candle[],
): ISeriesPrimitive<Time>[] {
    const gaps = findGaps(candles);
    console.log(`Found ${gaps.length} gaps`, gaps);

    const primitives: ISeriesPrimitive<Time>[] = [];

    for (const gap of gaps) {
        const isBull = gap.direction === "bullish";
        const primitive = new GapRectanglePrimitive(
            gap.startTime as Time,
            gap.endTime as Time,
            gap.topPrice,
            gap.bottomPrice,
            isBull ? "rgba(40, 62, 255, 0.8)" : "rgba(253, 218, 62, 0.7)", // fill
            "transparent", // border
        );
        candleSeries.attachPrimitive(primitive);
        primitives.push(primitive);
    }

    return primitives;
}
