import { useCallback, useState } from "react";
import { useTradeSound } from "@/hooks/useTradeSound";
import type { Order, Position } from "@/services/schemas.ts";

const ONE_CLICK_KEY = "oneClickTrading";

/** Trading-mode flags + dialog targets (one-click, sound, modify dialogs). */
export function useTradingState() {
  const [oneClick, setOneClick] = useState(
    () => localStorage.getItem(ONE_CLICK_KEY) === "true",
  );
  const [modifyingPosition, setModifyingPosition] = useState<Position | null>(null);
  const [modifyingOrder, setModifyingOrder] = useState<Order | null>(null);

  const toggleOneClick = useCallback(() => {
    setOneClick((prev) => {
      const next = !prev;
      localStorage.setItem(ONE_CLICK_KEY, String(next));
      return next;
    });
  }, []);

  const { muted: soundMuted, toggleMute: toggleSoundMute, playTradeSound } = useTradeSound();

  return {
    oneClick,
    toggleOneClick,
    soundMuted,
    toggleSoundMute,
    playTradeSound,
    modifyingPosition,
    setModifyingPosition,
    modifyingOrder,
    setModifyingOrder,
  };
}