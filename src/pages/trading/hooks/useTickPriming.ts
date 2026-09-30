import { useEffect } from "react";
import { api } from "@/services/api.ts";

/**
 * Prime the active symbol with a fresh server-side snapshot immediately on
 * symbol switch so bid/ask appears without waiting for the next WS tick.
 */
export function useTickPriming(
  selectedSymbol: string,
  updateTick: (symbol: string, bid: number, ask: number, ts: number) => void,
) {
  useEffect(() => {
    let cancelled = false;
    void api
      .getTick(selectedSymbol)
      .then((tick) => {
        if (cancelled || !tick) return;
        updateTick(
          selectedSymbol,
          Number(tick.bid),
          Number(tick.ask),
          typeof tick.timestamp === "number" ? tick.timestamp : Date.now(),
        );
      })
      .catch(() => {
        // Ignore snapshot misses; WS stream remains authoritative.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, updateTick]);
}