// lightweight-charts imports
import {
    ISeriesPrimitive,
    Time,
    IPrimitivePaneView,
    IPrimitivePaneRenderer,
    SeriesAttachedParameter,
    Coordinate,
} from 'lightweight-charts';

// fancy-canvas import
import { CanvasRenderingTarget2D } from 'fancy-canvas';

interface StepPoint {
    time: Time;
    value: number;
}

export class StepLinePrimitive implements ISeriesPrimitive<Time> {
    private _points: StepPoint[];
    private _color: string;
    private _lineWidth: number;
    private _lineStyle: 'solid' | 'dashed' | 'dotted';
    private _paneViews: StepLinePaneView[] = [];
    private _series: SeriesAttachedParameter<Time> | null = null;

    constructor(
        points: StepPoint[],
        color: string,
        lineWidth: number,
        lineStyle: 'solid' | 'dashed' | 'dotted' = 'solid',
    ) {
        this._points = points;
        this._color = color;
        this._lineWidth = lineWidth;
        this._lineStyle = lineStyle;
    }

    // Called by the library when the primitive is attached to a series.
    attached(param: SeriesAttachedParameter<Time>): void {
        this._series = param;
    }

    // Called when the primitive is detached.
    detached(): void {
        this._series = null;
    }

    // The library calls this to get the pane views.
    paneViews(): readonly IPrimitivePaneView[] {
        if (this._paneViews.length === 0) {
            this._paneViews.push(new StepLinePaneView(this));
        }
        return this._paneViews;
    }

    // Helper for the view/renderer to access the chart and series.
    getSeries(): SeriesAttachedParameter<Time> | null {
        return this._series;
    }

    getPoints(): StepPoint[] {
        return this._points;
    }

    getColor(): string {
        return this._color;
    }

    getLineWidth(): number {
        return this._lineWidth;
    }

    getLineStyle(): 'solid' | 'dashed' | 'dotted' {
        return this._lineStyle;
    }

    // Optional: update the points and request a redraw.
    updatePoints(points: StepPoint[]): void {
        this._points = points;
        if (this._series) {
            this._series.requestUpdate();
        }
    }
}

class StepLinePaneView implements IPrimitivePaneView {
    private _primitive: StepLinePrimitive;
    private _renderer: StepLinePaneRenderer;

    constructor(primitive: StepLinePrimitive) {
        this._primitive = primitive;
        this._renderer = new StepLinePaneRenderer(primitive);
    }

    renderer(): IPrimitivePaneRenderer {
        return this._renderer;
    }

    // Draw above the candles, like in the reference screenshot.
    // Change to 'normal' if you want the lines behind the series.
    zOrder(): 'bottom' | 'normal' | 'top' {
        return 'bottom';
    }
}

class StepLinePaneRenderer implements IPrimitivePaneRenderer {
    private _primitive: StepLinePrimitive;

    constructor(primitive: StepLinePrimitive) {
        this._primitive = primitive;
    }

    draw(target: CanvasRenderingTarget2D): void {
        const param = this._primitive.getSeries();
        if (!param) return;

        const points = this._primitive.getPoints();
        if (points.length < 2) return;

        const timeScale = param.chart.timeScale();

        // Convert each (time, value) to pixel coordinates (CSS pixels).
        const coords: { x: Coordinate; y: Coordinate }[] = [];
        for (const pt of points) {
            const x = timeScale.timeToCoordinate(pt.time);
            const y = param.series.priceToCoordinate(pt.value);
            if (x === null || y === null) continue; // bar not visible / not yet laid out
            coords.push({ x, y });
        }

        if (coords.length < 2) return;

        target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            ctx.save();

            // Work in CSS pixel space from here on. Without this,
            // coordinates would be wrong on any display with DPR != 1.
            ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);

            // Set line style.
            ctx.strokeStyle = this._primitive.getColor();
            ctx.lineWidth = this._primitive.getLineWidth();

            const lineStyle = this._primitive.getLineStyle();
            if (lineStyle === 'dashed') {
                ctx.setLineDash([5, 5]);
            } else if (lineStyle === 'dotted') {
                ctx.setLineDash([2, 2]);
            } else {
                ctx.setLineDash([]);
            }

            // Draw the step line.
            ctx.beginPath();
            ctx.moveTo(coords[0]!.x, coords[0]!.y);
            for (let i = 1; i < coords.length; i++) {
                ctx.lineTo(coords[i]!.x, coords[i]!.y);
            }
            ctx.stroke();

            ctx.restore();
        });
    }
}