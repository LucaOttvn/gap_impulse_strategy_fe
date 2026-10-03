import { useQuery } from "@tanstack/react-query";
import type { ISeriesApi } from "lightweight-charts";
import { fetchCandlesChunked } from "../../../services/api/candles";
import {
  drawGapsImpulseStrategy,
  type OperationRecord,
} from "../../../services/utils/strategy";
import {
  computeOperationStats,
  type OperationStats,
} from "../../../services/utils/operationStats";
import type { Timeframe } from "../constants";

/**
 * How far back to fetch for a backtest, per timeframe. These are the
 * practical maximums — bigger ranges produce more records but take longer
 * to run the strategy synchronously and consume more memory in the table.
 *
 * 5 years is a deliberate default for "deep" backtests on higher timeframes.
 * On 1m it produces ~500k bars, which is heavy — the strategy runs for
 * several seconds on the main thread. Consider using a Web Worker if this
 * becomes a UX problem.
 */
const BACKTEST_YEARS: Record<string, number> = {
  "1m":  1,
  "5m":  1,
  "15m": 1,
  "30m": 1,
  "1h":  1,
  "4h":  1,
  "1d":  1,
  "1w":  10,
};

const DAY_MS = 86_400_000;

// A no-op series that satisfies the type but does nothing. The strategy
// calls attachPrimitive() on it inside openPosition(); we don't care about
// any drawing for a headless backtest.
const NOOP_SERIES = {
  attachPrimitive: () => {},
  detachPrimitive: () => {},
} as unknown as ISeriesApi<"Candlestick">;

export interface BacktestResult {
  records: OperationRecord[];
  stats: OperationStats;
  barCount: number;
  rangeFrom: number;
  rangeTo: number;
}

export function useStrategyBacktest(symbol: string, timeframe: Timeframe) {
  return useQuery<BacktestResult>({
    queryKey: ["strategy-backtest", symbol, timeframe],
    queryFn: async ({ signal }) => {
      const years = BACKTEST_YEARS[timeframe] ?? 5;
      const to = Date.now();
      const from = to - years * 365 * DAY_MS;

      const candles = await fetchCandlesChunked(symbol, timeframe, from, to, {
        signal,
        onProgress: (done, total) => {
          // Optional — logs progress during the first (cache-miss) run.
          // console.log(`[backtest] chunk ${done}/${total}`);
        },
      });

      const { records } = drawGapsImpulseStrategy(NOOP_SERIES, candles);

      return {
        records,
        stats: computeOperationStats(records),
        barCount: candles.length,
        rangeFrom: from,
        rangeTo: to,
      };
    },
    staleTime: 30 * 60_000,  // 30 min — the strategy output is deterministic
    gcTime:    60 * 60_000,
  });
}