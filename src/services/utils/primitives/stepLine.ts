import type {
  ISeriesPrimitive,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
} from "lightweight-charts";

interface StepPoint {
  time: Time;
  value: number;
}

class StepLineRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _points: StepPoint[],
    private _color: string,
    private _width: number,
    private _style: "solid" | "dashed" | "dotted",
    private _series: any,
    private _timeScale: any,
  ) {}

  draw(target: any) {
    if (this._points.length < 2) return;
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;

      const xs: number[] = [];
      const ys: number[] = [];
      for (const p of this._points) {
        const x = this._timeScale.timeToCoordinate(p.time);
        const y = this._series.priceToCoordinate(p.value);
        if (x == null || y == null) return;
        xs.push(x);
        ys.push(y);
      }

      ctx.save();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = this._width * hr;
      ctx.setLineDash(
        this._style === "dashed" ? [6 * hr, 4 * hr]
        : this._style === "dotted" ? [2 * hr, 3 * hr]
        : [],
      );
      ctx.beginPath();
      ctx.moveTo(xs[0]! * hr, ys[0]! * vr);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i]! * hr, ys[i]! * vr);
      ctx.stroke();
      ctx.restore();
    });
  }
}

class StepLinePaneView implements IPrimitivePaneView {
  constructor(private _source: StepLinePrimitive) {}

  renderer() {
    const series = this._source.series;
    const chart = this._source.chart;
    if (!series || !chart) return null;
    return new StepLineRenderer(
      this._source.points,
      this._source.color,
      this._source.lineWidth,
      this._source.lineStyle,
      series,
      chart.timeScale(),
    );
  }

  zOrder() { return "top" as const; }
}

export class StepLinePrimitive implements ISeriesPrimitive<Time> {
  public series: any = null;
  public chart: any = null;
  public color: string;
  public lineWidth: number;
  public lineStyle: "solid" | "dashed" | "dotted";

  constructor(
    public points: StepPoint[],
    color: string,
    lineWidth: number,
    lineStyle: "solid" | "dashed" | "dotted" = "solid",
  ) {
    this.color = color;
    this.lineWidth = lineWidth;
    this.lineStyle = lineStyle;
  }

  attached(param: any) {
    this.series = param.series;
    this.chart = param.chart;
  }

  detached() {
    this.series = null;
    this.chart = null;
  }

  updatePoints(points: StepPoint[]) { this.points = points; }

  updateAllViews() {}

  paneViews() { return [new StepLinePaneView(this)]; }
}