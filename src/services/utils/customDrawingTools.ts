import {
    CandlestickData,
    CandlestickSeriesOptions,
    CandlestickStyleOptions,
    DeepPartial,
    IChartApi,
    ISeriesApi,
    ISeriesPrimitive,
    ISeriesPrimitivePaneRenderer,
    ISeriesPrimitivePaneView,
    SeriesAttachedParameter,
    SeriesOptionsCommon,
    Time,
    WhitespaceData,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { Candle } from "../schemas";

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

// ── Rectangle primitive (lightweight-charts v5) ────────────
class GapRectanglePrimitive implements ISeriesPrimitive<Time> {
    private _chart: IChartApi | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;

    constructor(
        private readonly _startTime: Time,
        private readonly _endTime: Time,
        private readonly _topPrice: number,
        private readonly _bottomPrice: number,
        private readonly _fill: string,
        private readonly _border: string,
    ) { }

    attached(param: SeriesAttachedParameter<Time>) {
        this._chart = param.chart;
        this._series = param.series as ISeriesApi<"Candlestick">;
    }

    detached() {
        this._chart = null;
        this._series = null;
    }

    updateAllViews() { }

    paneViews(): readonly ISeriesPrimitivePaneView[] {
        const self = this;
        return [
            {
                zOrder: () => "top" as const,
                renderer: (): ISeriesPrimitivePaneRenderer => ({
                    draw(target: CanvasRenderingTarget2D) {
                        const chart = self._chart;
                        const series = self._series;
                        if (!chart || !series) return;

                        const ts = chart.timeScale();
                        const x1 = ts.timeToCoordinate(self._startTime);
                        const x2 = ts.timeToCoordinate(self._endTime);
                        const y1 = series.priceToCoordinate(self._topPrice);
                        const y2 = series.priceToCoordinate(self._bottomPrice);

                        // Skip if the rectangle is entirely off-screen on either axis.
                        if (x1 === null || x2 === null || y1 === null || y2 === null) return;

                        const left = Math.min(x1, x2);
                        const right = Math.max(x1, x2);
                        const top = Math.min(y1, y2);
                        const bottom = Math.max(y1, y2);

                        target.useMediaCoordinateSpace(({ context: ctx }) => {
                            ctx.save();
                            ctx.fillStyle = self._fill;
                            ctx.fillRect(left, top, right - left, bottom - top);
                            ctx.strokeStyle = self._border;
                            ctx.lineWidth = 1;
                            ctx.strokeRect(left, top, right - left, bottom - top);
                            ctx.restore();
                        });
                    },
                }),
            },
        ];
    }
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