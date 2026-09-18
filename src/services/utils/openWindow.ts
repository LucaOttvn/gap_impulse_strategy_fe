import { ISeriesApi, Time, CandlestickData, WhitespaceData, CandlestickSeriesOptions, DeepPartial, CandlestickStyleOptions, SeriesOptionsCommon, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { findDayStarts } from "./dayStarts";
import { TimeRangeBandPrimitive } from "./primitives";

// ── Public entry point: highlight first N minutes of each day ──
export function highlightOpenWindow(
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