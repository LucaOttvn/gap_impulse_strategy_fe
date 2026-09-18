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
import { HorizontalSegmentPrimitive } from "./primitives";
import { dayKey } from "./dayStarts";

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