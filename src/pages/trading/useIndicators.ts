import { useEffect, useRef } from "react";
import {
  LineSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import {
  sma, ema, rsi, macd, bollingerBands, atr, stochastic, vwap,
  INDICATOR_REGISTRY,
  type IndicatorType,
} from "../../lib/indicators.ts";
import { toIndicatorCandles } from "./utils.ts";
import { CHART_COLORS } from "./constants.ts";

type IndicatorSeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

export function useIndicators(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: CandlestickData<Time>[],
  activeIndicators: IndicatorType[],
  isDark: boolean,
): void {
  const indicatorSeriesRef = useRef<Map<string, IndicatorSeries>>(new Map());
  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  // ── Rebuild gate ──
  // The effect below tears down and rebuilds every indicator series and
  // recomputes every indicator over the full array. That's ~100–500 ms of
  // main-thread work per run. `chartData` identity changes on every parent
  // render, so without this gate the effect would re-run on every WS tick.
  // Gate on a content signature instead: only rebuild when the shape of the
  // data or the active indicator set actually changed.
  const lastSigRef = useRef<string>("");
  const sig = [
    activeIndicators.slice().sort().join(","),
    isDark ? "d" : "l",
    chartData.length,
    chartData[chartData.length - 1]?.time ?? 0,
    chartData[0]?.time ?? 0,
  ].join("|");

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || chartData.length === 0) return;

    // No structural change → bail before doing any work.
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    const chart = chartRef.current;
    const indCandles = toIndicatorCandles(chartData);

    // Tear down old indicator series.
    for (const series of indicatorSeriesRef.current.values()) {
      try {
        chart.removeSeries(series);
      } catch {
        /* already removed */
      }
    }
    indicatorSeriesRef.current.clear();

    // Helper — reduces the repetitive "add series + setData + track" block.
    const addLine = (key: string, color: string, data: Array<{time: number; value: number}>,
                     opts: {lineWidth?: 1 | 2; lineStyle?: LineStyle; priceScaleId?: string} = {}) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: opts.lineWidth ?? 1,
        lineStyle: opts.lineStyle,
        priceScaleId: opts.priceScaleId ?? "right",
      });
      s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
      indicatorSeriesRef.current.set(key, s);
      return s;
    };

    const addHistogram = (key: string, data: Array<{time: number; value: number; color: string}>,
                          priceScaleId: string) => {
      const s = chart.addSeries(HistogramSeries, { priceScaleId });
      s.setData(data.map((p) => ({ time: p.time as Time, value: p.value, color: p.color })));
      indicatorSeriesRef.current.set(key, s);
      return s;
    };

    for (const type of activeIndicators) {
      const config = INDICATOR_REGISTRY.find((r) => r.type === type);
      if (!config) continue;

      switch (type) {
        case "SMA": {
          addLine("SMA", config.color, sma(indCandles, config.defaultParams.period!));
          break;
        }
        case "EMA": {
          addLine("EMA", config.color, ema(indCandles, config.defaultParams.period!));
          break;
        }
        case "RSI": {
          const data = rsi(indCandles, config.defaultParams.period);
          addLine("RSI", config.color, data, { priceScaleId: "rsi" });
          addLine("RSI-70", "#555", data.map((p) => ({ time: p.time, value: 70 })), { lineStyle: LineStyle.Dashed, priceScaleId: "rsi" });
          addLine("RSI-30", "#555", data.map((p) => ({ time: p.time, value: 30 })), { lineStyle: LineStyle.Dashed, priceScaleId: "rsi" });
          break;
        }
        case "MACD": {
          const data = macd(indCandles, config.defaultParams.fast, config.defaultParams.slow, config.defaultParams.signal);
          addLine("MACD-line", "#2196f3", data.macd, { priceScaleId: "macd" });
          addLine("MACD-signal", "#ff9800", data.signal, { priceScaleId: "macd" });
          addHistogram(
            "MACD-hist",
            data.histogram.map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? colors.up + "99" : colors.down + "99" })),
            "macd",
          );
          break;
        }
        case "BOLL": {
          const data = bollingerBands(indCandles, config.defaultParams.period, config.defaultParams.stdDev);
          addLine("BOLL-upper", config.color + "80", data.upper);
          addLine("BOLL-mid", config.color, data.middle);
          addLine("BOLL-lower", config.color + "80", data.lower);
          break;
        }
        case "ATR": {
          addLine("ATR", config.color, atr(indCandles, config.defaultParams.period), { priceScaleId: "atr" });
          break;
        }
        case "STOCH": {
          const data = stochastic(indCandles, config.defaultParams.kPeriod, config.defaultParams.dPeriod);
          addLine("STOCH-K", "#ab47bc", data.k, { priceScaleId: "stoch" });
          addLine("STOCH-D", "#ff7043", data.d, { priceScaleId: "stoch" });
          break;
        }
        case "VWAP": {
          addLine("VWAP", config.color, vwap(indCandles), { lineWidth: 2, lineStyle: LineStyle.Dashed });
          break;
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}