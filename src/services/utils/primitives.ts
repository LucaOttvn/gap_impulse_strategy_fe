import { CanvasRenderingTarget2D } from "fancy-canvas";
import {
    ISeriesPrimitive, Time, IChartApi, ISeriesApi,
    SeriesAttachedParameter,
    IPrimitivePaneView, IPrimitivePaneRenderer,
} from "lightweight-charts";

// ── Rectangle primitive ────────────
export class GapRectanglePrimitive implements ISeriesPrimitive<Time> {
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

    paneViews(): readonly IPrimitivePaneView[] {
        const self = this;
        return [
            {
                zOrder: () => "top" as const,
                renderer: (): IPrimitivePaneRenderer => ({
                    draw(target: CanvasRenderingTarget2D) {
                        const chart = self._chart;
                        const series = self._series;
                        if (!chart || !series) return;

                        const ts = chart.timeScale();
                        const x1 = ts.timeToCoordinate(self._startTime);
                        const x2 = ts.timeToCoordinate(self._endTime);
                        const y1 = series.priceToCoordinate(self._topPrice);
                        const y2 = series.priceToCoordinate(self._bottomPrice);

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

export class TimeRangeBandPrimitive implements ISeriesPrimitive<Time> {
    private _chart: IChartApi | null = null;

    constructor(
        private readonly _startTime: Time,
        private readonly _endTime: Time,
        private readonly _fill: string,
    ) {}

    attached(param: SeriesAttachedParameter<Time>) {
        this._chart = param.chart;
    }

    detached() {
        this._chart = null;
    }

    updateAllViews() {}

    paneViews(): readonly IPrimitivePaneView[] {
        const self = this;
        return [
            {
                zOrder: () => "bottom" as const,
                renderer: (): IPrimitivePaneRenderer => ({
                    draw(target: CanvasRenderingTarget2D) {
                        const chart = self._chart;
                        if (!chart) return;

                        const ts = chart.timeScale();
                        const x1 = ts.timeToCoordinate(self._startTime);
                        const x2 = ts.timeToCoordinate(self._endTime);
                        if (x1 === null || x2 === null) return;

                        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
                            const left = Math.min(x1, x2);
                            const right = Math.max(x1, x2);
                            ctx.save();
                            ctx.fillStyle = self._fill;
                            ctx.fillRect(left, 0, right - left, mediaSize.height);
                            ctx.restore();
                        });
                    },
                }),
            },
        ];
    }
}

export class HorizontalSegmentPrimitive implements ISeriesPrimitive<Time> {
    private _chart: IChartApi | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;

    constructor(
        private readonly _startTime: Time,
        private readonly _endTime: Time,
        private readonly _price: number,
        private readonly _color: string,
        private readonly _lineWidth: number = 2,
        private readonly _lineStyle: "solid" | "dashed" | "dotted" = "solid",
    ) {}

    attached(param: SeriesAttachedParameter<Time>) {
        this._chart = param.chart;
        this._series = param.series as ISeriesApi<"Candlestick">;
    }

    detached() {
        this._chart = null;
        this._series = null;
    }

    updateAllViews() {}

    paneViews(): readonly IPrimitivePaneView[] {
        const self = this;
        return [
            {
                zOrder: () => "top" as const,
                renderer: (): IPrimitivePaneRenderer => ({
                    draw(target: CanvasRenderingTarget2D) {
                        const chart = self._chart;
                        const series = self._series;
                        if (!chart || !series) return;

                        const ts = chart.timeScale();
                        const x1 = ts.timeToCoordinate(self._startTime);
                        const x2 = ts.timeToCoordinate(self._endTime);
                        const y = series.priceToCoordinate(self._price);
                        if (x1 === null || x2 === null || y === null) return;

                        const left = Math.min(x1, x2);
                        const right = Math.max(x1, x2);

                        target.useMediaCoordinateSpace(({ context: ctx }) => {
                            ctx.save();
                            ctx.strokeStyle = self._color;
                            ctx.lineWidth = self._lineWidth;
                            if (self._lineStyle === "dashed") ctx.setLineDash([6, 4]);
                            else if (self._lineStyle === "dotted") ctx.setLineDash([2, 3]);
                            ctx.beginPath();
                            ctx.moveTo(left, y);
                            ctx.lineTo(right, y);
                            ctx.stroke();
                            ctx.restore();
                        });
                    },
                }),
            },
        ];
    }
}