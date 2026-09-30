import { useCallback, useEffect, useState } from "react";
import { TIMEFRAMES, type Timeframe } from "../constants.ts";

const DEFAULT_TF: Timeframe = "15m";
const storageKey = (symbol: string) => `tf_${symbol}`;

function readTf(symbol: string): Timeframe | null {
  const saved = localStorage.getItem(storageKey(symbol));
  return saved && TIMEFRAMES.includes(saved as Timeframe) ? (saved as Timeframe) : null;
}

/** Timeframe state keyed per-symbol, persisted to localStorage. */
export function useTimeframePersistence(selectedSymbol: string) {
  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => readTf(selectedSymbol) ?? DEFAULT_TF,
  );

  const handleTimeframeChange = useCallback(
    (tf: Timeframe) => {
      setTimeframe(tf);
      localStorage.setItem(storageKey(selectedSymbol), tf);
    },
    [selectedSymbol],
  );

  // Restore the symbol's saved TF whenever the active symbol changes.
  useEffect(() => {
    const saved = readTf(selectedSymbol);
    if (saved) setTimeframe(saved);
  }, [selectedSymbol]);

  return [timeframe, handleTimeframeChange] as const;
}