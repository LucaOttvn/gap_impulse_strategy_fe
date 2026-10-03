// src/pages/trading/hooks/useBacktest.ts
import { StrategyCandle } from "@/services/utils/01_interfaces";
import { OperationStats } from "@/services/utils/operationStats";
import { OperationRecord } from "@/services/utils/strategy";
import { useEffect, useState } from "react";

interface BacktestPayload {
  candles: StrategyCandle[];
  records: OperationRecord[];
  stats: OperationStats;
  barCount: number;
  rangeFrom: string;
  rangeTo: string;
}

export function useBacktest(symbol: string, timeframe: string, from?: string, to?: string) {
  const [data, setData] = useState<BacktestPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("http://localhost:3000/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, timeframe, from, to }),
    })
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setData(json); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, timeframe, from, to]);

  return { data, loading, error };
}