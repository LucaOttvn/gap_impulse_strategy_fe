import { useCallback } from "react";
import { api } from "@/services/api.ts";
import type { PlaceOrderInput } from "@/services/schemas.ts";
import { toast } from "@/services/toast.ts";
import type { ConfirmOrderPayload } from "./useConfirmOrder.ts";

/**
 * Chart context-menu quick orders (Buy/Sell limit/stop at the clicked price).
 * Always routes through the confirm dialog so a stray right-click can never
 * place an order directly.
 */
export function useQuickOrder(
  activeAccountId: string | null,
  selectedSymbol: string,
  requestConfirm: (order: ConfirmOrderPayload) => void,
) {
  return useCallback(
    (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => {
      if (!activeAccountId) {
        toast.warning("No Account", "Select an account before placing orders");
        return;
      }
      const input: PlaceOrderInput = {
        accountId: activeAccountId,
        symbol: selectedSymbol,
        side,
        type,
        quantity: 1,
        ...(type === "LIMIT" ? { price } : { stopPrice: price }),
      };
      requestConfirm({
        symbol: selectedSymbol,
        side,
        type,
        quantity: 1,
        price: type === "LIMIT" ? price : undefined,
        stopPrice: type === "STOP" ? price : undefined,
        _submit: () => api.placeOrder(input),
      });
    },
    [activeAccountId, selectedSymbol, requestConfirm],
  );
}