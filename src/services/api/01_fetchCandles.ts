import { UTCTimestamp } from "lightweight-charts";
import { TIMEFRAME_MAP, toIsoDate, API_BASE, ApiError } from "../api";
import { StrategyCandle } from "../utils/01_interfaces";

const ROME_DTF = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

const romeOffsetCache = new Map<number, number>();

function getRomeOffsetSeconds(timestampMs: number): number {
  const dayKey = Math.floor(timestampMs / 86_400_000);
  const cached = romeOffsetCache.get(dayKey);
  if (cached !== undefined) return cached;

  const parts = Object.fromEntries(
    ROME_DTF.formatToParts(new Date(timestampMs)).map((p) => [p.type, p.value])
  );
  const romeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour), // en-GB can emit "24"
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = (romeAsUtc - timestampMs) / 1000;
  romeOffsetCache.set(dayKey, offset);
  return offset;
}

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

  const strategyCandles = (await res.json()) as StrategyCandle[];

  if (!strategyCandles) return [];

  const isIntraday = timespan !== "day" && timespan !== "week" && timespan !== "month";

  const candles: StrategyCandle[] = strategyCandles.map((strategyCandle) => {
    const utcSeconds = Math.floor(strategyCandle.time / 1000);
    const displaySeconds = isIntraday
      ? utcSeconds + getRomeOffsetSeconds(strategyCandle.time)
      : utcSeconds;

    return {
      time: displaySeconds as UTCTimestamp,
      timestamp: strategyCandle.time,
      open: strategyCandle.open,
      high: strategyCandle.high,
      low: strategyCandle.low,
      close: strategyCandle.close,
      volume: strategyCandle.volume,
      dayHigh: strategyCandle.dayHigh,
      dayLow: strategyCandle.dayLow,
    };
  });
  return candles;
}