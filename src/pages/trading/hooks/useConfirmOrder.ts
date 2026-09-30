import { useCallback, useState } from "react";

export type ConfirmOrderPayload = {
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  /** Deferred submit — only fired when the user confirms the dialog. */
  _submit: () => Promise<unknown>;
};

/** State + confirm/cancel dance for the order confirmation dialog. */
export function useConfirmOrder(onConfirmed?: () => void) {
  const [pending, setPending] = useState<ConfirmOrderPayload | null>(null);
  const [loading, setLoading] = useState(false);

  const request = useCallback((order: ConfirmOrderPayload) => setPending(order), []);

  const confirm = useCallback(() => {
    if (!pending?._submit) return;
    setLoading(true);
    pending
      ._submit()
      .then(() => onConfirmed?.())
      .finally(() => {
        setLoading(false);
        setPending(null);
      });
  }, [pending, onConfirmed]);

  const cancel = useCallback(() => setPending(null), []);

  return { pending, loading, request, confirm, cancel };
}