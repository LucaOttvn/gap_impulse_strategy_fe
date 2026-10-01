import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { MarketDataCandlesPayload } from "./api/market-data";
import { queryKeys } from "./queries";
import { Candle } from "./schemas";

// export function useCandles(
//   symbol: string,
//   timeframe: string,
//   limit?: number,
//   replayVersion?: number,
// ) {
//   return useQuery<MarketDataCandlesPayload, Error, Candle[]>({
//     // Include replayVersion in the query key so each replay session forces a
//     // completely fresh query — React Query won't reuse structural sharing or
//     // stale cache from a previous replay / normal session.
//     queryKey: [...queryKeys.market.candles(symbol, timeframe), limit ?? "auto", replayVersion ?? 0],
//     queryFn: () => ,
//     // Extract just the candles array for consumers — raw payload (with isPartial)
//     // is still accessible via query.state.data inside refetchInterval below.
//     select: (data) => data.candles,
//     staleTime: 30_000,
//     // Keep previously-fetched candles visible while a new depth query (different
//     // limit in the key) is in-flight. Without this, switching from firstPaint
//     // → deep limit causes a momentary empty array, which lets a live WS candle
//     // paint as the only bar before history arrives.
//     placeholderData: (prev) => prev,
//     // When the server signals the response is partial (backfill queued), poll
//     // at 3 s until data fills in. Otherwise use the 5-min safety-net cadence.
//     refetchInterval: (query) => (query.state.data?.metadata?.isPartial ? 3_000 : 5 * 60_000),
//   });
// }

// services/api/candles.ts
export async function fetchCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const result = await api.getCandlesWithMeta(symbol, timeframe);
  return result.candles;
}