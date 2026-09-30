import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api.ts";
import { toast } from "@/services/toast.ts";

type Mods = { takeProfit?: number | null; stopLoss?: number | null };

function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: string }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Request failed";
}

/**
 * Handler for chart drag-to-edit SL/TP levels. Reverts the price line on
 * failure by invalidating the positions query.
 */
export function useModifyPosition(
  activeAccountId: string | null,
  isFeedConnected: boolean,
) {
  const queryClient = useQueryClient();

  return useCallback(
    async (positionId: string, mods: Mods) => {
      if (!isFeedConnected) {
        toast.warning(
          "No Data Feed",
          "Cannot modify positions while disconnected from the data feed",
        );
        if (activeAccountId) {
          queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
        }
        return;
      }
      try {
        await api.modifyPosition(positionId, mods);
        const field = mods.takeProfit !== undefined ? "TP" : "SL";
        const price = mods.takeProfit !== undefined ? mods.takeProfit : mods.stopLoss;
        toast.success(`${field} Updated`, `${field} set to ${price}`);
        if (activeAccountId) {
          queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
        }
      } catch (err: unknown) {
        toast.error("Modify Failed", getErrorMessage(err));
        // Refetch so the price line reverts to the server's value.
        if (activeAccountId) {
          queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
        }
      }
    },
    [activeAccountId, queryClient, isFeedConnected],
  );
}