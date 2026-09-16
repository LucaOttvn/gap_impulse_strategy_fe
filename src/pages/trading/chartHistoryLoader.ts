// PURPOSE
// -------
// The chart only deep-fetches a finite window of candles on mount. When the
// user scrolls far enough left that fewer than `LOAD_MORE_THRESHOLD` bars
// remain between the left edge and the oldest loaded candle, this module fetches
// the preceding `LOAD_MORE_WINDOW`-bar slice from the candle API and prepends it,
// so the chart appears to extend seamlessly into the past.
//
// It is intentionally a pure, dependency-free helper module (no React): the
// chart lifecycle owns the refs and state, and hands them in when wiring up the
// visible-logical-range subscription.
//
// WHAT EACH PIECE DOES
// --------------------
//   LoadMoreState        – Bookkeeping for the loader: whether a fetch is in
//                          flight, whether the true end of history has been
//                          reached, the last timestamp already fetched, and an
//                          optional "shifted fetch boundary" (see below).
//
//   getSeriesOldestMs()  – Returns the timestamp (ms) of the oldest bar the
//                          series currently holds, so the next fetch knows
//                          where to continue.
//
//   isLoadMoreEligible() – The gate run on every range change. Returns false
//                          while a fetch is already running, once we know there
//                          is no more data, or when more than `LOAD_MORE_THRESHOLD`
//                          bars remain on the left. A shifted fetch boundary from
//                          a prior empty window is always eligible (we still need
//                          to probe the range before the gap). Otherwise it only
//                          proceeds if we've never fetched or the series has grown
//                          older than the last fetch boundary.
//
//   fetchOlderRange()    – Actually calls `api.getCandles` for the window that
//                          ends at `toMs`. On an EMPTY response it does not give
//                          up: an empty window is usually a gap (e.g. a Forex
//                          weekend) rather than the true end of history, so it
//                          shifts `fetchFromMs` one window further back and lets
//                          the next scroll event retry past the gap. On error it
//                          resets `lastFetchedBeforeMs` so the user can retry by
//                          scrolling again (avoids a permanent dead-lock where a
//                          transient network error blocks history forever).
//
//   makeHistoryLoader()  – The subscription callback factory. It reads the
//                          timeframe through a ref (the chart persists across
//                          timeframe switches, so it must always fetch the *current*
//                          TF), guards eligibility, chooses the fetch boundary
//                          (shifted or the series' current oldest bar), and hands
//                          the result to `onLoaded` so the caller can prepend the
//                          bars to React state.
//
// The caller (`ChartPanel`) subscribes this via
// `chart.timeScale().subscribeVisibleLogicalRangeChange(...)` inside the
// chart-create effect, and unsubscribes on cleanup.
// ═════════════════════════════════════════════════════════════════════════════

import type {LogicalRange, ISeriesApi} from "lightweight-charts";
import {api} from "../../services/api.ts";
import type {Candle} from "../../services/schemas.ts";
import {TF_INTERVAL_MS, type Timeframe} from "./constants.ts";


// ── Scroll-triggered history loading ─────────────────────────
// When the user scrolls to the left edge of loaded data, fetch the preceding
// window from the candle API and prepend it so the chart extends seamlessly.

const LOAD_MORE_THRESHOLD = 20; // trigger when fewer than N bars remain on the left
const LOAD_MORE_WINDOW = 500; // how many interval-widths to fetch per extension

export type LoadMoreState = {
  loading: boolean;
  noMoreData: boolean;
  lastFetchedBeforeMs: number;
  // When > 0, use this as toMs for the next fetch instead of getSeriesOldestMs.
  // Set after an empty-range response so we skip over gaps (e.g. Forex weekends)
  // rather than permanently locking noMoreData on the first empty window.
  fetchFromMs: number;
};

function getSeriesOldestMs(series: ISeriesApi<"Candlestick">): number {
  const data = series.data();
  return data.length === 0 ? 0 : (data[0]!.time as number) * 1_000;
}

function isLoadMoreEligible(state: LoadMoreState, series: ISeriesApi<"Candlestick">, range: LogicalRange): boolean {
  if (state.loading || state.noMoreData) return false;
  const barsInfo = series.barsInLogicalRange(range);
  if ((barsInfo?.barsBefore ?? Number.POSITIVE_INFINITY) > LOAD_MORE_THRESHOLD) return false;
  // A shifted window from a previous empty-range response is always eligible —
  // we need to try the window before the gap (e.g. before a Forex weekend).
  if (state.fetchFromMs > 0) return true;
  const oldestMs = getSeriesOldestMs(series);
  if (oldestMs === 0) return false;
  return state.lastFetchedBeforeMs === 0 || oldestMs < state.lastFetchedBeforeMs;
}

function fetchOlderRange(symbol: string, timeframe: string, toMs: number, state: LoadMoreState, onLoaded: (bars: Candle[]) => void): void {
  const windowMs = LOAD_MORE_WINDOW * (TF_INTERVAL_MS[timeframe as Timeframe] ?? 60_000);
  api
    .getCandles(symbol, timeframe)
    .then((bars) => {
      if (bars.candles.length === 0) {
        // Empty window — could be a gap (e.g. Forex weekend) rather than true
        // end of history. Shift the fetch boundary back one more window so the
        // next scroll event tries the range before this gap instead of stopping.
        const nextToMs = toMs - windowMs;
        if (nextToMs > 0) {
          state.fetchFromMs = nextToMs;
        } else {
          state.noMoreData = true;
        }
      } else {
        onLoaded(bars.candles as Candle[]);
      }
    })
    .catch(() => {
      // Reset the fetch boundary so the user can retry by scrolling again.
      // Without this, a transient network error permanently blocks history
      // loading for the current view (lastFetchedBeforeMs stays set but no
      // bars were prepended, so the eligibility guard never clears).
      state.lastFetchedBeforeMs = 0;
    })
    .finally(() => {
      state.loading = false;
    });
}

export function makeHistoryLoader(
  symbol: string,
  timeframeRef: {current: string},
  seriesRef: {current: ISeriesApi<"Candlestick"> | null},
  stateRef: {current: LoadMoreState},
  onLoaded: (bars: Candle[]) => void,
): (range: LogicalRange | null) => void {
  return (range) => {
    const series = seriesRef.current;
    if (!range || !series) return;
    const state = stateRef.current;
    if (!isLoadMoreEligible(state, series, range)) return;
    // Use the shifted boundary from a prior empty-range response when present,
    // otherwise fall back to the series' current oldest bar.
    const toMs = state.fetchFromMs > 0 ? state.fetchFromMs : getSeriesOldestMs(series);
    if (toMs === 0) return;
    state.loading = true;
    state.lastFetchedBeforeMs = toMs;
    state.fetchFromMs = 0;
    // Read the timeframe from a ref: the chart (and this subscription) persists
    // across TF changes, so the loader must always fetch the *current* TF.
    fetchOlderRange(symbol, timeframeRef.current, toMs, state, onLoaded);
  };
}
