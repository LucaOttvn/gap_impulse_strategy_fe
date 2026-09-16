import {
    CandlestickData,
    CandlestickSeriesOptions,
    CandlestickStyleOptions,
    DeepPartial, ISeriesApi,
    ISeriesPrimitive, SeriesOptionsCommon,
    Time,
    WhitespaceData
} from "lightweight-charts";
import { Candle } from "../schemas";
import { TimeRangeBandPrimitive, GapRectanglePrimitive } from "./primitives";

// ── Gap model ──────────────────────────────────────────────
interface Gap {
    startTime: number; // unix seconds
    endTime: number;
    topPrice: number;
    bottomPrice: number;
    direction: "bullish" | "bearish";
}

// ── Detection ──────────────────────────────────────────────
// Scans non-overlapping groups of 3 candles [i, i+1, i+2].
// Compares candle i (first) with candle i+2 (third).
//   bullish: high[first] < low[third]
//   bearish: low[first]  > high[third]
function findGaps(candles: Candle[]): Gap[] {
    const gaps: Gap[] = [];
    for (let i = 0; i + 2 < candles.length; i += 1) {
        const first = candles[i];
        const third = candles[i + 2];

        if (!first || !third) continue

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

// ── Public entry point ─────────────────────────────────────
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


// ── Day-start detection ────────────────────────────────────
function dayKey(unixSeconds: number, timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
}

function findDayStarts(candles: Candle[], timeZone = "America/New_York"): number[] {
    const indices: number[] = [];
    let prev = "";
    for (let i = 0; i < candles.length; i++) {
        const key = dayKey(candles[i].time, timeZone);
        if (key !== prev) {
            indices.push(i);
            prev = key;
        }
    }
    return indices;
}

// ── Public entry point: highlight first N minutes of each day ──
export function highlightFirstMinutesOfDay(
    candleSeries: ISeriesApi<
        "Candlestick",
        Time,
        CandlestickData<Time> | WhitespaceData<Time>,
        CandlestickSeriesOptions,
        DeepPartial<CandlestickStyleOptions & SeriesOptionsCommon>
    >,
    candles: Candle[],
    options?: {
        minutes?: number;
        timeZone?: string;
        fill?: string;
        /** Skip days whose opening bar isn't the true session open (e.g. sparse data). */
        requireFirstBar?: boolean;
    },
): ISeriesPrimitive<Time>[] {
    const minutes = options?.minutes ?? 15;
    const timeZone = options?.timeZone ?? "America/New_York";
    const fill = options?.fill ?? "rgba(255, 200, 50, 0.10)";

    const dayStartIndices = findDayStarts(candles, timeZone);
    const primitives: ISeriesPrimitive<Time>[] = [];

    for (const i of dayStartIndices) {
        const first = candles[i];
        if (!first) continue;

        const startSec = first.time;
        const endSec = startSec + minutes * 60;

        const band = new TimeRangeBandPrimitive(
            startSec as Time,
            endSec as Time,
            fill,
        );
        candleSeries.attachPrimitive(band);
        primitives.push(band);
    }

    return primitives;
}