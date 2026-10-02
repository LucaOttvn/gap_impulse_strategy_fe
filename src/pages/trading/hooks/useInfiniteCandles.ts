import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { getCandlesInRange, type CandleRangeResult } from "../../../services/api/candles";
import type { Candle } from "../../../services/schemas";

// Bars-per-page, expressed as a time window per timeframe. Sized so each page
// is ~2k bars — fast to fetch, and small enough that a few pages fit
// comfortably in the sliding render window.
const PAGE_WINDOW_MS: Record<string, number> = {
  "1m":  7  * 86_400_000,
  "5m":  30 * 86_400_000,
  "15m": 90 * 86_400_000,
  "30m": 180 * 86_400_000,
  "1h":  365 * 86_400_000,
  "4h":  730 * 86_400_000,
  "1d":  1825 * 86_400_000,
  "1w":  3650 * 86_400_000,
};

export interface InfiniteCandlesResult {
  /** Flattened, chronologically-sorted candles from every loaded page. */
  allCandles: Candle[];
  /** Triggers a fetch of the next (older) page. */
  fetchOlder: () => void;
  /** True while the NEXT (older) page is being fetched. */
  isFetchingOlder: boolean;
  /** True during the very first page load — no data has arrived yet. */
  isInitialLoading: boolean;
  /** False once an empty page came back — no more history. */
  hasOlder: boolean;
}

export function useInfiniteCandles(
  symbol: string,
  timeframe: string,
): InfiniteCandlesResult {
  const windowMs = PAGE_WINDOW_MS[timeframe] ?? 7 * 86_400_000;

  const query = useInfiniteQuery<
    CandleRangeResult,
    Error,
    InfiniteData<CandleRangeResult, { to: number }>,
    readonly unknown[],
    { to: number }
  >({
    queryKey: ["candles-infinite", symbol, timeframe] as const,
    initialPageParam: { to: Date.now() },
    queryFn: ({ pageParam }) =>
      getCandlesInRange(symbol, timeframe, pageParam.to - windowMs, pageParam.to),
    getNextPageParam: (lastPage) => {
      // Empty page = no more history. This is the authoritative stop.
      if (lastPage.candles.length === 0) return undefined;
      const oldestSec = lastPage.candles[0]!.time as unknown as number;
      // Next window strictly before the oldest bar we have.
      return { to: oldestSec * 1000 - 1 };
    },
    // Historical pages never change — cache them indefinitely. Only the
    // newest page can be extended by live bars.
    staleTime: (q) => {
      const newest = q.state.data?.pages[0]?.candles.at(-1);
      if (!newest) return 30_000;
      const ageMs = Date.now() - (newest.time as unknown as number) * 1000;
      return ageMs > 60 * 60 * 1000 ? Infinity : 30_000;
    },
    placeholderData: (prev) => prev,
  });

  // Flatten pages into a single chronological array. Pages[0] is newest;
  // pages[N] is oldest. Reverse the page order before flattening.
  const allCandles = (() => {
    if (!query.data) return [];
    const byTime = new Map<number, Candle>();
    for (const page of query.data.pages) {
      for (const c of page.candles) byTime.set(c.time as unknown as number, c);
    }
    return [...byTime.values()].sort(
      (a, b) => (a.time as unknown as number) - (b.time as unknown as number),
    );
  })();

  return {
    allCandles,
    fetchOlder: () => { void query.fetchNextPage(); },
    isFetchingOlder: query.isFetchingNextPage,
    isInitialLoading: query.isLoading,
    hasOlder: !!query.hasNextPage,
  };
}