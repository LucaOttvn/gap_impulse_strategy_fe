import { CanvasRenderingTarget2D } from "fancy-canvas";
import {
    IChartApi, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter,
    Time, IPrimitivePaneView, IPrimitivePaneRenderer,
} from "lightweight-charts";

export class LabelPrimitive implements ISeriesPrimitive<Time> {
    private _chart: IChartApi | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;

    constructor(
        private readonly _time: Time,
        private readonly _price: number,
        private readonly _lines: string[],
        private readonly _bg: string = "rgba(15, 20, 30, 0.92)",
        private readonly _fg: string = "#e5e7eb",
        private readonly _border: string = "#64748b",
        private readonly _side: "left" | "right" = "right",
    ) {}

    attached(param: SeriesAttachedParameter<Time>) {
        this._chart = param.chart;
        this._series = param.series as ISeriesApi<"Candlestick">;
    }
    detached() { this._chart = null; this._series = null; }
    updateAllViews() {}

    paneViews(): readonly IPrimitivePaneView[] {
        const self = this;
        return [{
            zOrder: () => "top" as const,
            renderer: (): IPrimitivePaneRenderer => ({
                draw(target: CanvasRenderingTarget2D) {
                    const chart = self._chart;
                    const series = self._series;
                    if (!chart || !series) return;

                    const ts = chart.timeScale();
                    const x = ts.timeToCoordinate(self._time);
                    const y = series.priceToCoordinate(self._price);
                    if (x === null || y === null) return;

                    target.useMediaCoordinateSpace(({ context: ctx }) => {
                        const pad = 8;
                        const lineH = 15;
                        const fontSize = 11;
                        ctx.save();
                        ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;

                        // Measure the widest line so the box fits.
                        let w = 0;
                        for (const line of self._lines) {
                            const m = ctx.measureText(line).width;
                            if (m > w) w = m;
                        }
                        const boxW = w + pad * 2;
                        const boxH = self._lines.length * lineH + pad * 2;

                        // Anchor point → box top-left, based on side.
                        const bx = self._side === "right" ? x + 10 : x - 10 - boxW;
                        const by = y - boxH / 2;

                        // Rounded background.
                        ctx.fillStyle = self._bg;
                        ctx.strokeStyle = self._border;
                        ctx.lineWidth = 1;
                        const r = 5;
                        const x0 = bx, y0 = by, x1 = bx + boxW, y1 = by + boxH;
                        ctx.beginPath();
                        ctx.moveTo(x0 + r, y0);
                        ctx.lineTo(x1 - r, y0);
                        ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
                        ctx.lineTo(x1, y1 - r);
                        ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
                        ctx.lineTo(x0 + r, y1);
                        ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
                        ctx.lineTo(x0, y0 + r);
                        ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();

                        // Text lines.
                        ctx.fillStyle = self._fg;
                        ctx.textBaseline = "top";
                        for (let i = 0; i < self._lines.length; i++) {
                            ctx.fillText(self._lines[i]!, bx + pad, by + pad + i * lineH);
                        }

                        // Pointer from the box to the anchor point.
                        ctx.strokeStyle = self._border;
                        ctx.beginPath();
                        if (self._side === "right") {
                            ctx.moveTo(x, y);
                            ctx.lineTo(bx, by + boxH / 2);
                        } else {
                            ctx.moveTo(x, y);
                            ctx.lineTo(bx + boxW, by + boxH / 2);
                        }
                        ctx.stroke();

                        ctx.restore();
                    });
                },
            }),
        }];
    }
}