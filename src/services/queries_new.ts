import { api } from "./api";
import { Candle } from "./schemas";

export async function fetchCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const result = await api.getCandlesWithMeta(symbol, timeframe);
  return result.candles;
}