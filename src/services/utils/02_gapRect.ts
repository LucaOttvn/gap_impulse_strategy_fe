import type {
  ISeriesPrimitive,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
} from "lightweight-charts";

class GapRectRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _startTime: Time,
    private _endTime: Time,
    private _topPrice: number,
    private _bottomPrice: number,
    private _fillColor: string,
    private _borderColor: string,
    private _series: any,
    private _timeScale: any,
  ) {}

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;

      const x1 = this._timeScale.timeToCoordinate(this._startTime);
      const x2 = this._timeScale.timeToCoordinate(this._endTime);
      const y1 = this._series.priceToCoordinate(this._topPrice);
      const y2 = this._series.priceToCoordinate(this._bottomPrice);

      if (x1 == null || x2 == null || y1 == null || y2 == null) return;

      ctx.save();
      ctx.fillStyle = this._fillColor;
      ctx.fillRect(
        Math.min(x1, x2) * hr,
        Math.min(y1, y2) * vr,
        Math.abs(x2 - x1) * hr,
        Math.abs(y2 - y1) * vr,
      );
      if (this._borderColor !== "transparent") {
        ctx.strokeStyle = this._borderColor;
        ctx.lineWidth = 1 * hr;
        ctx.strokeRect(
          Math.min(x1, x2) * hr,
          Math.min(y1, y2) * vr,
          Math.abs(x2 - x1) * hr,
          Math.abs(y2 - y1) * vr,
        );
      }
      ctx.restore();
    });
  }
}

class GapRectPaneView implements IPrimitivePaneView {
  constructor(private _source: GapRectanglePrimitive) {}

  renderer() {
    const series = this._source.series;
    const chart = this._source.chart;
    if (!series || !chart) return null;
    return new GapRectRenderer(
      this._source.startTime,
      this._source.endTime,
      this._source.topPrice,
      this._source.bottomPrice,
      this._source.fillColor,
      this._source.borderColor,
      series,
      chart.timeScale(),
    );
  }

  zOrder() { return "bottom" as const; }
}

export class GapRectanglePrimitive implements ISeriesPrimitive<Time> {
  public series: any = null;
  public chart: any = null;

  constructor(
    public startTime: Time,
    public endTime: Time,
    public topPrice: number,
    public bottomPrice: number,
    public fillColor: string,
    public borderColor: string = "transparent",
  ) {}

  attached(param: any) {
    this.series = param.series;
    this.chart = param.chart;
  }

  detached() {
    this.series = null;
    this.chart = null;
  }

  updateAllViews() {}

  paneViews() { return [new GapRectPaneView(this)]; }
}