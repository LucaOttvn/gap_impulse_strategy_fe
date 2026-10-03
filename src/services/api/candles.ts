import { Candle } from "../schemas";
import { getCandlesInRange } from "./01_fetchCandles";

/**
 * A single Massive request is capped at 50,000 bars. For deep backtests we
 * split the requested range into chunks, fetch each, and merge. Requests
 * are made in small batches so we don't hammer the backend (or trip a
 * rate limiter on the Massive side).
 *
 * On the first run of a (symbol, timeframe) pair, each chunk is a cache
 * miss on the backend → fetched from Massive → written to disk. On every
 * subsequent run, every chunk is a disk hit and the whole thing returns
 * in a few hundred milliseconds.
 */

// Safe chunk size per timeframe — one chunk stays under 50k RTH bars.
const CHUNK_DAYS: Record<string, number> = {
  "1m": 90,     // ~35k bars
  "5m": 400,    // ~31k bars
  "15m": 1500,   // ~29k bars
  "30m": 3000,   // ~29k bars
  "1h": 5000,   // ~24k bars
  "4h": 5000,
  "1d": 5000,
  "1w": 5000,
};

const MAX_CONCURRENT_CHUNKS = 3;

export interface ChunkedFetchOptions {
  /** Called after each chunk resolves: (completed, total). */
  onProgress?: (completed: number, total: number) => void;
  /** Optional abort signal — checked between batches. */
  signal?: AbortSignal;
}

export async function fetchCandlesChunked(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  opts: ChunkedFetchOptions = {},
): Promise<Candle[]> {
  const chunkMs = (CHUNK_DAYS[timeframe] ?? 90) * 86_400_000;

  // Build the list of [from, to] windows.
  const chunks: Array<[number, number]> = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + chunkMs, toMs);
    chunks.push([cursor, end]);
    cursor = end;
  }

  const { onProgress, signal } = opts;
  let completed = 0;
  const results: Candle[][] = [];

  // Fetch in small parallel batches. Parallelism is bounded so the backend
  // doesn't get a burst of 20 simultaneous requests on 1m/5-year runs.
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
    const batchResults = await Promise.all(
      batch.map(([from, to]) =>
        getCandlesInRange(symbol, timeframe, from, to).then((r) => r),
      ),
    );
    results.push(...batchResults);

    completed += batch.length;
    onProgress?.(completed, chunks.length);
  }

  // Merge + dedupe across seams. Chunks are day-aligned, so adjacent chunks
  // can overlap by one bar.
  const byTime = new Map<number, Candle>();
  for (const chunk of results) {
    for (const c of chunk) byTime.set(c.time as unknown as number, c);
  }
  return [...byTime.values()].sort(
    (a, b) => (a.time as unknown as number) - (b.time as unknown as number),
  );
}