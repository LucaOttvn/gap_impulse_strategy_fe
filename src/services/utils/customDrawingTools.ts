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
import { TimeRangeBandPrimitive, GapRectanglePrimitive, HorizontalSegmentPrimitive } from "./primitives";

// ── Gap model ──────────────────────────────────────────────
interface Gap {
    startTime: number; // unix seconds
    endTime: number;
    topPrice: number;
    bottomPrice: number;
    direction: "bullish" | "bearish";
}

// ── Day-start helpers ──────────────────────────────────────
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

// For each candle index, the time of the first candle of its calendar day.
function computeDayStartTimes(candles: Candle[], timeZone: string): number[] {
    const dayStartTimes: number[] = new Array(candles.length);
    let currentStart = candles[0]?.time ?? 0;
    let prevKey = "";
    for (let i = 0; i < candles.length; i++) {
        const key = dayKey(candles[i].time, timeZone);
        if (key !== prevKey) {
            currentStart = candles[i].time;
            prevKey = key;
        }
        dayStartTimes[i] = currentStart;
    }
    return dayStartTimes;
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

// ── Day levels ─────────────────────────────────────────────
// Running high/low of each calendar day, in the target timezone.
// Mirrors the Pine `var` pattern: reset on the first bar of the day,
// extend with every subsequent bar.
export interface DayLevels {
    startTime: number;
    endTime: number;
    dayHigh: number;
    dayLow: number;
}

function computeDayLevels(candles: Candle[], timeZone: string): DayLevels[] {
    if (candles.length === 0) return [];

    const out: DayLevels[] = [];
    let key = "";
    let startTime = candles[0]!.time;
    let endTime = candles[0]!.time;
    let high = -Infinity;
    let low = Infinity;

    for (const c of candles) {
        const k = dayKey(c.time, timeZone);
        if (k !== key) {
            // Flush previous day before starting a new one
            if (key !== "") {
                out.push({ startTime, endTime, dayHigh: high, dayLow: low });
            }
            key = k;
            startTime = c.time;
            endTime = c.time;
            high = c.high;
            low = c.low;
        } else {
            endTime = c.time;
            if (c.high > high) high = c.high;
            if (c.low < low) low = c.low;
        }
    }

    // Flush the last (possibly still running) day
    if (key !== "") {
        out.push({ startTime, endTime, dayHigh: high, dayLow: low });
    }

    return out;
}

// ── Public entry point: day high / low lines ───────────────
export function drawDayLevels(
    candleSeries: ISeriesApi<
        "Candlestick",
        Time,
        CandlestickData<Time> | WhitespaceData<Time>,
        CandlestickSeriesOptions,
        DeepPartial<CandlestickStyleOptions & SeriesOptionsCommon>
    >,
    candles: Candle[],
    options?: {
        timeZone?: string;
        highColor?: string;
        lowColor?: string;
        lineWidth?: number;
        lineStyle?: "solid" | "dashed" | "dotted";
    },
): ISeriesPrimitive<Time>[] {
    const timeZone = options?.timeZone ?? "America/New_York";
    const highColor = options?.highColor ?? "#ffffff";
    const lowColor = options?.lowColor ?? "#ffffff";
    const lineWidth = options?.lineWidth ?? 2;
    const lineStyle = options?.lineStyle ?? "solid";

    const days = computeDayLevels(candles, timeZone);
    const primitives: ISeriesPrimitive<Time>[] = [];

    for (const d of days) {
        const highLine = new HorizontalSegmentPrimitive(
            d.startTime as Time,
            d.endTime as Time,
            d.dayHigh,
            highColor,
            lineWidth,
            lineStyle,
        );
        candleSeries.attachPrimitive(highLine);
        primitives.push(highLine);

        const lowLine = new HorizontalSegmentPrimitive(
            d.startTime as Time,
            d.endTime as Time,
            d.dayLow,
            lowColor,
            lineWidth,
            lineStyle,
        );
        candleSeries.attachPrimitive(lowLine);
        primitives.push(lowLine);
    }

    return primitives;
}