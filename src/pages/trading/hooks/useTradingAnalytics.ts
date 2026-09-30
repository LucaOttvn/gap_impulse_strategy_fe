import { useCallback, useRef } from "react";
import { posthog } from "@/lib/posthog";

/** Funnel analytics — fires once per session on the user's first executed trade. */
export function useTradingAnalytics() {
  const hasTrackedFirstTrade = useRef(false);

  const trackFirstTrade = useCallback(() => {
    if (hasTrackedFirstTrade.current) return;
    hasTrackedFirstTrade.current = true;
    posthog.capture("funnel.trade.first_executed", {
      sessionId: posthog.get_session_id?.(),
    });
  }, []);

  return { trackFirstTrade };
}