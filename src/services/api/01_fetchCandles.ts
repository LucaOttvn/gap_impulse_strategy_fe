import { UTCTimestamp } from "lightweight-charts";
import { TIMEFRAME_MAP, toIsoDate, API_BASE, ApiError } from "../api";
import { Gap, StrategyCandle, TpSlRect } from "../utils/01_interfaces";

export async function getCandlesInRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
): Promise<StrategyCandle[]> {
  const [multiplier, timespan] = TIMEFRAME_MAP[timeframe] ?? ["1", "day"];

  const params = new URLSearchParams({
    ticker: symbol,
    multiplier,
    timespan,
    from: toIsoDate(fromMs),
    to: toIsoDate(toMs),
  });

  const res = await fetch(`${API_BASE}/api/stocks?${params}`);
  if (!res.ok) {
    throw new ApiError(`Candle fetch failed: ${res.status}`, res.status);
  }

  const raw = (await res.json()) as Array<{
    time: number;         // unix SECONDS (BE already divided by 1000)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    dayHigh: number | null;
    dayLow: number | null;
    orangeLine: number | null;
    blueLine: number | null;
    ema: number | null;
    emaNewDay: boolean | null;
    gap: Gap | null
    // raw cast:
    tpSl: TpSlRect | null;
  }>;

  if (!Array.isArray(raw)) return [];

  return raw.map((c) => ({
    time: c.time as UTCTimestamp,
    timestamp: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    dayHigh: c.dayHigh ?? NaN,
    dayLow: c.dayLow ?? NaN,
    orangeLine: c.orangeLine ?? NaN,
    blueLine: c.blueLine ?? NaN,
    ema: c.ema ?? NaN,
    emaNewDay: c.emaNewDay ?? false,
    gap: c.gap ?? null,
    tpSl: c.tpSl ?? null,
  }));
}