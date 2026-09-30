import { useCallback, useRef, useState } from "react";

const STORAGE_KEY = "bottomPanelHeight";
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;

/** Vertical resize drag for the bottom panel, with height persisted to localStorage. */
export function useBottomPanelResize() {
  const [height, setHeight] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_HEIGHT;
  });

  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const clientY = "touches" in e ? e.touches[0]!.clientY : e.clientY;
      startYRef.current = clientY;
      startHRef.current = height;

      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!resizingRef.current) return;
        const y = "touches" in ev ? ev.touches[0]!.clientY : (ev as MouseEvent).clientY;
        const delta = startYRef.current - y;
        const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHRef.current + delta));
        setHeight(next);
      };
      const onUp = () => {
        resizingRef.current = false;
        setHeight((h) => {
          localStorage.setItem(STORAGE_KEY, String(h));
          return h;
        });
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    },
    [height],
  );

  return { height, handleResizeStart };
}