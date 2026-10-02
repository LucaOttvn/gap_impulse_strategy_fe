# Chart Data Pipeline

How candles get from Massive (via our backend) to the pixels on the chart.

This document explains the entire flow — fetching, caching, the sliding window,
what the chart actually renders, and how the loading overlay is driven. It
assumes no prior knowledge of the system. If you're new to the project, read
this before touching any of the files under `pages/trading/hooks/`.

---

## Table of Contents

1. [TL;DR](#tldr)
2. [The problem this solves](#the-problem-this-solves)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [Layer 1 — the backend](#layer-1--the-backend)
5. [Layer 2 — `getCandlesInRange`](#layer-2--getcandlesinrange)
6. [Layer 3 — `useInfiniteCandles`](#layer-3--useinfinitecandles)
7. [Layer 4 — `useSlidingCandles`](#layer-4--useslidingcandles)
8. [Layer 5 — `useChartDataFlow`](#layer-5--usechartdataflow)
9. [Layer 6 — `ChartPanel` wiring](#layer-6--chartpanel-wiring)
10. [The loading overlay](#the-loading-overlay)
11. [Full walkthrough — cold start](#full-walkthrough--cold-start)
12. [Full walkthrough — scrolling back](#full-walkthrough--scrolling-back)
13. [Key decisions and why](#key-decisions-and-why)
14. [Common problems and how to debug them](#common-problems-and-how-to-debug-them)

---

## TL;DR

- The chart never holds more than **10,000 bars** at once, regardless of how
  much history the user has scrolled through.
- Every scroll-back past the oldest loaded bar fetches one more page
  (`PAGE_WINDOW_MS` per timeframe) from the backend.
- The fetched pages are all cached in React Query — scrolling back to where
  you've already been is instant, no network call.
- A blurred overlay appears whenever candles are loading: both on the first
  mount and on every scroll-back fetch.

The rest of this document explains how and why.

---

## The problem this solves

Early versions of the chart tried to fetch "all the candles for the last N
days" in a single request. For 1m that meant ~40,000 bars. That's:

- 4 MB of JSON to parse
- 1–3 seconds of `series.setData` on the main thread
- Every subsequent re-render traversing 40k items
- Worse for every additional indicator

The chart froze. The fix was to stop thinking about "fetch all the data" and
start thinking about "fetch the smallest slice the user needs, and fetch more
only when they ask for it."

That's the sliding window.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│                         B R O W S E R                            │
│                                                                  │
│  ┌──────────────────────┐                                        │
│  │  useInfiniteCandles  │  ← React Query cache of N pages        │
│  │  (React Query)       │    pages[0] = newest, pages[N] = oldest│
│  └─────────┬────────────┘                                        │
│            │                                                     │
│            │  allCandles[] (up to hundreds of thousands)         │
│            ▼                                                     │
│  ┌──────────────────────┐                                        │
│  │  useSlidingCandles   │  ← slices to WINDOW_SIZE bars          │
│  │  (window manager)    │    (10,000 by default)                 │
│  └─────────┬────────────┘                                        │
│            │                                                     │
│            │  visibleCandles[] (max 10,000)                      │
│            ▼                                                     │
│  ┌──────────────────────┐                                        │
│  │  useChartDataFlow    │  ← setData, live updates, tick merge   │
│  │  (realtime pipeline) │                                        │
│  └─────────┬────────────┘                                        │
│            │                                                     │
│            │  chartData[] (lightweight-charts shape)             │
│            ▼                                                     │
│       ┌─────────┐                                                │
│       │  CHART  │                                                │
│       └─────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
             ▲
             │  HTTP /api/stocks?from&to&ticker&multiplier&timespan
             │
┌────────────┴────────────────────────────────────────────────────┐
│                         B A C K E N D                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  getHistory (server.ts)                                  │   │
│  │    → checks data/candles/*.json cache                    │   │
│  │    → cache miss? → fetch from Massive → write to disk    │   │
│  │    → filter RTH if session=regular                       │   │
│  │    → return { results: [...] }                           │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

Everything the browser does is on the top half. The backend is a dumb pipe
that answers range queries — it has no state about what the browser has
loaded, and it doesn't know it's being paginated.

---

## Layer 1 — the backend

**Files:** `server.ts`, `api/candles.ts` (backend)

The backend exposes one endpoint: `GET /api/stocks`.

### Query parameters

| Param | Example | Purpose |
|-------|---------|---------|
| `ticker` | `AAPL` | Symbol |
| `multiplier` | `1` | Bar multiplier |
| `timespan` | `minute` | Bar timespan |
| `from` | `2025-09-01` or Unix ms | Range start |
| `to` | `2025-09-15` or Unix ms | Range end |
| `session` | `regular` \| `extended` \| `all` | RTH filter |

The backend proxies to Massive's `/v2/aggs/ticker/{ticker}/range/...`
endpoint, which only accepts two date formats:

- `YYYY-MM-DD`
- Unix milliseconds

It does **not** accept ISO 8601 with a `T`. This is why the frontend sends
`YYYY-MM-DD` (via `toIsoDate`) instead of `.toISOString()`.

### Response shape

```json
{
  "results": [
    { "t": 1726070400000, "o": 220.5, "h": 221.1, "l": 220.2, "c": 220.9, "v": 1234567 },
    ...
  ],
  "resultsCount": 5000,
  "status": "OK"
}
```

Where each field is:

- `t` — bar timestamp in Unix **milliseconds**
- `o`, `h`, `l`, `c` — OHLC prices
- `v` — volume

### Caching

The backend has an on-disk cache under `data/candles/` (not present in the
frontend — it's a server-side concern). The cache is keyed on
`(ticker, timespan, multiplier, from, to)`, so a second request for the same
range is served instantly from disk.

Frontend developers should never need to know this exists. If requests are
slow, it's either a cache miss or the range is huge.

---

## Layer 2 — `getCandlesInRange`

**File:** `services/api/candles.ts`

This is the low-level fetch. It takes a symbol, a timeframe, and an explicit
`from`/`to` range in milliseconds, and returns `Candle[]` in the shape
lightweight-charts expects.

```ts
export async function getCandlesInRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
): Promise<CandleRangeResult>
```

### What it does

1. Maps the timeframe string (`"1m"`, `"15m"`, …) to Massive's
   `(multiplier, timespan)` pair via `TIMEFRAME_MAP`.
2. Formats `fromMs` / `toMs` as `YYYY-MM-DD` via `toIsoDate`.
3. Calls `/api/stocks?ticker=...&multiplier=...&timespan=...&from=...&to=...`.
4. Maps Massive's response shape (`{t, o, h, l, c, v}`) into `Candle`.
5. Returns `{ candles, hasMoreBefore }`.

### The Rome offset problem

Massive returns UTC timestamps. The chart displays Europe/Rome time. So each
intraday bar's timestamp is shifted by the Rome offset before being handed to
lightweight-charts.

The naive implementation called `new Intl.DateTimeFormat(...)` **per bar**.
For a 40,000-bar response, that's 40,000 formatter constructions — 1–3 seconds
of synchronous work.

The fix was two-fold:

1. **Hoist the formatter** to module scope. Constructed once, ever.
2. **Cache the offset per UTC calendar day.** The Rome/UTC offset only changes
   at DST boundaries (twice a year), so within a single UTC day it's constant.
   That drops ~40,000 calls down to ~80.

```ts
const ROME_DTF = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", ... });
const romeOffsetCache = new Map<number, number>();

function getRomeOffsetSeconds(timestampMs: number): number {
  const dayKey = Math.floor(timestampMs / 86_400_000);
  const cached = romeOffsetCache.get(dayKey);
  if (cached !== undefined) return cached;
  // ... compute and cache
}
```

Daily/weekly/monthly bars are **not** shifted — they represent a business date
and must stay at UTC midnight.

### Why this layer exists separately

It's a pure function. No React, no state. That makes it testable and reusable.
`useInfiniteCandles` is just a React Query wrapper around it.

---

## Layer 3 — `useInfiniteCandles`

**File:** `pages/trading/hooks/useInfiniteCandles.ts`

This is the cache. It owns the full history of loaded candles, backed by
React Query's `useInfiniteQuery`.

### The mental model

Think of the cache as a book where each page is a window of bars:

```
pages[0]  = newest 2,700 bars   (the last 7 days for 1m)
pages[1]  = 2,700 bars before that
pages[2]  = 2,700 bars before that
...
pages[N]  = oldest loaded page
```

`pages[0]` is fetched automatically on mount. Every other page is fetched
lazily when the user scrolls to the oldest edge.

### `PAGE_WINDOW_MS`

One page is a **time window**, not a fixed bar count. This is deliberate —
different timeframes have different bar densities and paginating by bar count
means you can't reason about "how far back can I scroll on 1m vs 15m."

```ts
const PAGE_WINDOW_MS: Record<string, number> = {
  "1m":  7  * 86_400_000,   // 7 days    → ~2,700 RTH bars
  "5m":  30 * 86_400_000,   // 30 days   → ~2,300 bars
  "15m": 90 * 86_400_000,   // 90 days   → ~2,300 bars
  "1h":  365 * 86_400_000,  // 365 days  → ~1,600 bars
  // ...
};
```

### The query configuration

```ts
useInfiniteQuery({
  queryKey: ["candles-infinite", symbol, timeframe],
  initialPageParam: { to: Date.now() },
  queryFn: ({ pageParam }) =>
    getCandlesInRange(symbol, timeframe, pageParam.to - windowMs, pageParam.to),
  getNextPageParam: (lastPage) => {
    if (lastPage.candles.length === 0) return undefined;   // end of history
    const oldestSec = lastPage.candles[0]!.time as number;
    return { to: oldestSec * 1000 - 1 };                   // 1ms before oldest
  },
  staleTime: (q) => {
    // Historical pages never change — Infinity. Only the newest page gets a
    // 30s staleTime so it can be extended by live bars.
    const newest = q.state.data?.pages[0]?.candles.at(-1);
    if (!newest) return 30_000;
    const ageMs = Date.now() - (newest.time as number) * 1000;
    return ageMs > 60 * 60 * 1000 ? Infinity : 30_000;
  },
  placeholderData: (prev) => prev,
});
```

The pieces worth understanding:

**`initialPageParam: { to: Date.now() }`** — the first fetch asks for
"everything up to now." Combined with `queryFn`'s `from = to - windowMs`, that
becomes "the last 7 days of 1m bars."

**`getNextPageParam`** — this is where pagination happens. When the user asks
for the next page, React Query calls this with the *last* page. It returns the
timestamp to fetch **strictly before** — specifically, 1 ms before the oldest
bar of the previous page. That prevents the seam from overlapping.

**The `-1 ms`** is critical. Without it, the next page would re-fetch the
oldest bar of the previous page. It would still work (the Map dedupes
duplicates), but it wastes a bar of bandwidth and creates inconsistent slicing
in the sliding window.

**Empty-page stop** — when `getNextPageParam` returns `undefined`, React Query
sets `hasNextPage = false`. The infinite query is done.

**Dynamic staleTime** — this is a big win. Pages older than an hour are
immutable; only the top page can be extended by live bars. So after the user
has scrolled around for a while, virtually every page is cached forever.
Coming back tomorrow only refetches the newest page.

### Flattening

React Query gives you `pages[]`, not a flat array. The hook flattens into a
single `allCandles[]`:

```ts
const allCandles = (() => {
  if (!query.data) return [];
  const byTime = new Map<number, Candle>();
  for (const page of query.data.pages) {
    for (const c of page.candles) byTime.set(c.time as number, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
})();
```

The `Map` dedupes seam bars (belt-and-suspenders against the `-1 ms`). The
`sort` guarantees chronological order regardless of page order.

### What the hook returns

```ts
{
  allCandles,          // flattened, oldest → newest
  fetchOlder,          // call to trigger the next page
  isFetchingOlder,     // true while the next page is in flight
  isInitialLoading,    // true during the very first mount
  hasOlder,            // false once an empty page came back
}
```

`isInitialLoading` and `isFetchingOlder` are both used by the loader overlay.

---

## Layer 4 — `useSlidingCandles`

**File:** `pages/trading/hooks/useSlidingCandles.ts`

This is the most intricate piece. It exists because `allCandles` can be
arbitrarily large (hundreds of thousands of bars if the user scrolls back a
lot), but the chart can only render ~10k bars efficiently.

### The problem it solves

If you pass 100,000 bars to `series.setData`:

- 3–10 seconds of main-thread work
- The chart freezes on every render
- Indicators and overlays iterate the whole array

So `useSlidingCandles` slices `allCandles` down to `WINDOW_SIZE` (10,000) bars
and slides that window as the user scrolls.

### The rightOffset model

The slice is defined by a single state variable: **`rightOffset`**.

```
allCandles:   [..................................................]
                                     ▲                 ▲
                                     │                 │
                                     │                 └── len - rightOffset
                                     │
                                     └── len - rightOffset - WINDOW_SIZE

visibleCandles:                    [===================]
                                    (WINDOW_SIZE bars)
```

- `rightOffset = 0` → slice is the newest 10,000 bars.
- `rightOffset = 5,000` → slice is bars 5,000–15,000 from the end.
- `rightOffset = len - WINDOW_SIZE` → slice is the oldest 10,000 bars.

The anchor is the **newest end** of `allCandles`. Prepending older pages does
not move that end, so `rightOffset` does not need to change when new pages
arrive. This is critical — an earlier version bumped `rightOffset` on every
prepend and caused the slice to jump an entire page forward on every fetch.

### The scroll handler

Subscribes to lightweight-charts' `subscribeVisibleLogicalRangeChange`. Every
time the visible range changes (scroll, zoom, resize), the handler runs on the
next animation frame:

```ts
const range = chart.timeScale().getVisibleLogicalRange();
const total = allCandlesRef.current.length;
const offset = rightOffsetRef.current;

// Can we slide left (toward older bars)?
const canSlideLeft = offset < total - WINDOW_SIZE;
// Can we slide right (toward newer bars)?
const canSlideRight = offset > 0;

if (range.from < LOW_WATER) {
  // User is near the left edge of the visible slice
  if (canSlideLeft) {
    // Slide the window left by SLIDE_BARS
    setRightOffset((o) => Math.min(o + SLIDE_BARS, total - WINDOW_SIZE));
  } else if (canLoadOlder && !isFetchingOlder) {
    // No more loaded bars to slide into — ask for another page
    onNeedOlder?.();
  }
} else if (range.to > WINDOW_SIZE - LOW_WATER) {
  // User is near the right edge
  if (canSlideRight) setRightOffset((o) => Math.max(0, o - SLIDE_BARS));
}
```

### The constants and why they're sized that way

```ts
const WINDOW_SIZE = 10_000;   // max bars the chart ever renders
const LOW_WATER   = 50;       // distance from an edge before we slide
const SLIDE_BARS  = 3_000;    // how far the window shifts per slide
```

**`WINDOW_SIZE = 10,000`** — the sweet spot between "renders fast enough" and
"scrolls far enough before a fetch." Larger means each `setData` gets slower.
Smaller means the user hits fetch boundaries more often.

**`LOW_WATER = 50`** — how close the user has to get to the edge before the
window slides or a fetch fires. Small values (20–50) mean the fetch only
triggers when the user is genuinely at the edge — they see the boundary and
then the loader appears. Large values (1000+) prefetch aggressively, which
hides the loading state but breaks the "user knows it's loading" UX.

**`SLIDE_BARS = 3,000`** — how far the window moves when the user crosses the
low-water mark. If this is too small, the window slides on every frame of a
scroll (60 setState calls per second). Too large and the user sees the window
"jump." 3,000 is ~30% of `WINDOW_SIZE`, which feels smooth.

### The clamp

There's one subtle guard in the slide logic:

```ts
const maxSlide = Math.max(0, WINDOW_SIZE - range.to - 1);
const delta = Math.min(SLIDE_BARS, maxSlide);
```

This prevents the slide from pushing the *entire* visible viewport out of the
new slice. Without it, `setVisibleRange` in `useChartDataFlow` fails (the
captured range is outside the new data), and the chart auto-fits to the whole
slice — producing the "big zoom out" bug.

### The reset on chart recreation

```ts
useLayoutEffect(() => {
  setRightOffset(0);
}, [chartEpoch]);
```

`chartEpoch` bumps when the chart is recreated (theme toggle, symbol switch,
pip-precision change). Resetting to 0 means the user lands on the newest bars
after any of those events, which is the expected behavior.

### What it returns

Just `visibleCandles: Candle[]` — the sliced array, ready to be fed to
`useChartDataFlow`. Everything else (window state, scroll handler) is internal.

---

## Layer 5 — `useChartDataFlow`

**File:** `pages/trading/hooks/useChartDataFlow.ts`

This is the realtime pipeline: everything that turns raw candles / ticks /
server updates into what's drawn on the series.

### Responsibilities

1. **Bulk `setData`** — replace the whole series when the visible slice changes
2. **Preserve viewport** — capture the visible range before `setData`, restore
   it after, clamped to the new data's bounds
3. **Live candle updates** — `applyServerCandle` merges server CWs into the
   last bar via `series.update()`
4. **Tick smoothing** — `applyTick` merges bid/ask into the current bar
   between server pulses
5. **Bid/ask price lines** — `applyBidAskLines` moves the lines in place
6. **Line-cross alerts** — fires a toast + beep when the mid price crosses an
   alert-enabled drawing
7. **Staleness watchdog** — detects silence from the WS feed and triggers a
   refetch
8. **Paints the new bars** — calls `onDataRendered` after `setData` +
   double-rAF, so the loader knows when the chart is truly ready

### The bulk `setData` effect — the important one

This is where the chart gets its bars. It runs whenever the *content signature*
of `chartData` changes:

```ts
const dataSig = `${selectedSymbol}:${timeframe}:${chartData.length}:${chartData[0].time}:${chartData[chartData.length-1].time}`;
```

The signature includes:
- `symbol` and `timeframe` — so switching either forces a rebuild
- `chartData.length` — so pagination (which grows the slice) triggers
- `chartData[0].time` — so **sliding the window** triggers (content changes
  even if length stays at 10,000)
- `chartData[last].time` — so appending newer bars triggers

The effect bails early if the signature is unchanged. This is the difference
between "the chart rebuilds on every parent render" and "the chart rebuilds
only when the data actually changed."

### The viewport preservation dance

`series.setData` wipes the visible range. The user's scroll position resets to
whatever lightweight-charts decides (usually the right edge). To prevent the
window from jumping on every page load, the effect does this:

```ts
// 1. Capture the visible range BEFORE setData
const prevRange = chart && !isNewChart ? chart.timeScale().getVisibleRange() : null;

// 2. Replace the data
series.setData(chartData);
volumeSeriesRef.current?.setData(volumeData);

// 3. Restore the visible range, clamped to the new data's time bounds
if (prevRange && chart) {
  const newFirst = chartData[0].time;
  const newLast = chartData[chartData.length-1].time;
  const from = Math.max(prevRange.from, newFirst);
  const to = Math.min(prevRange.to, newLast);
  if (from < to) {
    try { chart.timeScale().setVisibleRange({ from, to }); } catch { }
  }
}
```

**Why clamp?** When the window slides (not just prepends), the new slice might
not cover the old visible range. For example, if the user was viewing the
oldest 500 bars and the window slides to include newer bars, the old range's
`from` is outside the new slice's time bounds. `setVisibleRange` throws on
out-of-bounds ranges. Without the clamp, that throw is silently swallowed and
the chart auto-fits — the "big zoom" bug.

**Why not use `setVisibleLogicalRange`?** Because the bar indices change when
the slice changes. `getVisibleLogicalRange` returns indices (0 to N-1), not
time. A range of `[3000, 3400]` in the old slice is a completely different time
window in the new slice. `getVisibleRange` / `setVisibleRange` use actual
timestamps, which stay valid across slice changes.

### The `onDataRendered` callback

After `setData` + restore, the effect schedules a double rAF:

```ts
const notifyRendered = () => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      onDataRenderedRef.current?.();
    });
  });
};
```

Why double rAF? The first rAF fires *before* the next paint. The second fires
*after* the paint has happened. By the time the second one runs, the browser
has presented the new frame — the new bars are on screen.

This is what lets the loader overlay disappear at exactly the right moment:
the chart is already rendered when the loader hides, so there's no flash of
old content.

### Live updates vs bulk updates

The other five effects handle live data. All of them use `series.update()` or
`applyOptions()`, which are O(1) — they touch one bar or one price line. None
of them trigger a full `setData`.

- **`liveCandle`** — a server-aggregated OHLCV candle arrives; merged into the
  last bar via `applyServerCandle`.
- **`tick`** — bid/ask updates between server pulses; merged into the last
  bar via `applyTick`. Overwritten by the next `liveCandle`.
- **`tick`** — also moves the bid/ask price lines in place.
- **`tick`** — also checks for line-crossings against alert-enabled drawings.
- **30-second interval** — checks if the last bar is stale; if so, calls
  `requestGapRefetch` which invalidates the React Query cache.

The key insight: **live updates never touch `setData`.** They only update the
last bar or the price lines. This is what keeps the chart at 60 fps during
active trading.

---

## Layer 6 — `ChartPanel` wiring

**File:** `components/ChartPanel.tsx`

`ChartPanel` is the orchestrator. It receives `allCandles` from `TradingPage`
and passes it through the pipeline:

```
allCandles
    │
    ▼
useChartInstance ─────────► chart, candleSeries, volumeSeries refs
    │
    ▼
useSlidingCandles ────────► visibleCandles (max 10k bars)
    │
    ▼
useChartDataFlow ─────────► chartData (lightweight-charts shape)
    │                       + setData, live updates, viewport preservation
    ▼
useIndicators ────────────► SMA/EMA/RSI/MACD series on top
    │
    ▼
useChartOverlays ─────────► position/order lines, plugins, strategy primitives
    │
    ▼
useChartAppearance ───────► colors, wicks, grid, timeframe formatting
```

Each hook is called once per render in a fixed order because later hooks
depend on earlier ones. The order is:

1. **`useChartInstance`** — creates the chart. Returns `chartEpoch` (bumps on
   recreation) and `drawingManagerRef`.
2. **`useSlidingCandles`** — slices `allCandles`. Returns `visibleCandles`.
3. **`useChartLegend`** — crosshair → OHLCV legend.
4. **`useChartDataFlow`** — feeds `visibleCandles` to the series.
5. **`useChartOverlays`** — draws positions/orders/plugins on top.
6. **`useChartAppearance`** — updates colors, grid, timeframe formatting.

`ChartPanel` itself owns:
- The five chart-related refs
- All UI state (menus, dialogs, selected drawing)
- The render

Everything else is delegated.

---

## The loading overlay

The loader has to appear at two distinct moments:

1. **Cold start** — the chart mounts, no data yet
2. **Scroll-back fetch** — the user hits the oldest loaded bar and triggers
   another page

Both are represented by `isLoadingCandles` at the `ChartPanel` level:

```tsx
isLoadingCandles={isInitialLoading || isFetchingOlder}
```

Where:
- `isInitialLoading` comes from `useInfiniteCandles` (`query.isLoading`)
- `isFetchingOlder` comes from `useInfiniteCandles` (`query.isFetchingNextPage`)

### The overlay itself

```tsx
{isLoadingCandles && (
  <div className="absolute inset-0 z-40 flex items-center justify-center
                  backdrop-blur-sm bg-background/50">
    <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl
                    bg-card border border-border shadow-2xl">
      <div className="h-8 w-8 rounded-full border-2 border-primary
                      border-t-transparent animate-spin" />
      <span className="text-xs font-mono text-muted-foreground">
        loading candles…
      </span>
    </div>
  </div>
)}
```

`absolute inset-0` covers the chart container. `backdrop-blur-sm` blurs the
chart beneath. `bg-background/50` adds a tint. The `pointer-events-auto`
implicitly blocks clicks, so the user can't interact with a half-loaded chart.

### Why the `dataSig` matters for the loader

Without the strengthened `dataSig` (which includes `chartData[0].time`), the
sliding window's content changes wouldn't trigger `useChartDataFlow`'s
`setData` effect. The `onDataRendered` callback would never fire, and the
loader would hang.

The signature is the lynchpin: it's what tells `useChartDataFlow` "the
content changed, run the effect, signal when done."

---

## Full walkthrough — cold start

User opens the trading page with AAPL and 1m selected.

```
t=0ms     TradingPage renders
          useInfiniteCandles fires the first queryFn
          isInitialLoading = true

t=0ms     ChartPanel renders
          isLoadingCandles = true → LOADER APPEARS
          useChartInstance creates the chart
          useSlidingCandles returns [] (allCandles empty)
          useChartDataFlow gets [] → effect bails (no data)

t=130ms   Backend responds with 7 days of 1m bars (~2,700 candles)
          React Query stores pages[0]
          allCandles becomes 2,700 bars
          isInitialLoading = false

t=131ms   React re-renders
          useSlidingCandles returns all 2,700 bars (below WINDOW_SIZE)
          isLoadingCandles = false → LOADER STILL VISIBLE (batched)

t=132ms   useChartDataFlow's setData effect runs
          series.setData(2,700 bars) — ~50ms
          Restores viewport (no-op on first load)
          Schedules double rAF

t=150ms   setData completes
          Browser paints the new bars

t=152ms   Double rAF fires
          The loader would hide here — but it already hid at t=131ms
          (because isLoadingCandles was already false)

Actual perceived: the loader is up for ~130ms, chart appears with bars.
```

Wait — there's a subtle issue here. On the first load, `onDataRendered` isn't
wired to the loader at all. The loader is driven by `isLoadingCandles`, which
becomes false the moment the fetch resolves. So on **cold start**, the loader
might disappear *before* `setData` has run.

**Cold start is fine** because the bars appear on the very next frame anyway.
The two-frame gap is imperceptible. The important case is scroll-back.

---

## Full walkthrough — scrolling back

User has been scrolling around for a while. `allCandles` has 30,000 bars
(5 pages loaded). The visible window is showing the newest 10,000.

```
User drags the chart to the left.

Scroll handler fires on every frame.
range.from decreases from 5,000 → 3,000 → 1,000 → 200 → 50 → ...

When range.from < LOW_WATER (50):
  canSlideLeft? YES (rightOffset < 20,000)
  → setRightOffset(o => o + 3,000)

The window slides. The user's viewport stays put because
useChartDataFlow restores the visible range on every slide.
No loader fires because no fetch happened.

User keeps scrolling until the window is at its leftmost:

rightOffset = 20,000 (total - WINDOW_SIZE)
canSlideLeft = false

range.from drops below 50 again.

  canSlideLeft? NO
  canLoadOlder? YES (hasOlder)
  isFetchingOlder? NO

  → onNeedOlder() fires  (this is the wrapper in ChartPanel)
  → setIsLoadingOlder(true)
  → LOADER APPEARS
  → React Query starts the fetch

~130ms later:

Backend responds.
allCandles grows from 30,000 to 32,700 bars.
isFetchingOlder becomes false.

React re-renders.
useSlidingCandles recomputes visibleCandles with the same
rightOffset but a larger allCandles — so the slice's
content shifted (older bars are now in the range that was
previously the boundary).

useChartDataFlow's dataSig changes:
  - chartData.length same (still 10,000)
  - chartData[0].time CHANGED (older first bar in the slice)
  - chartData[last].time same

setData effect runs.
  Capture prev visible range.
  series.setData(10,000 bars) — ~100ms, main thread blocks
    (the loader is still up — this is why the user doesn't
     see the freeze)
  Restore viewport (clamped).
  Schedule double rAF.

Double rAF fires.
  onDataRendered() → handleDataRendered() → setIsLoadingOlder(false)
  LOADER HIDES.

User sees the same viewport, now with older bars extending
to the left.
```

The critical property: **the freeze from `setData` happens while the loader
is visible.** By the time the loader hides, the chart has already painted the
new bars.

---

## Key decisions and why

### Why paginate by time window, not bar count?

Bar counts vary per timeframe. "Give me 5,000 bars" means different things on
1m vs 1d. Time windows are a common unit — "7 days" is 7 days regardless of
timeframe, and the resulting bar count is roughly stable per TF.

### Why does `getNextPageParam` use the oldest bar's time - 1?

To ensure the pages don't overlap. If you returned `{ to: oldestSec * 1000 }`
(without `-1`), the next page's `to` would be exactly the oldest bar's time,
and Massive would return that bar again at the start of the new page. The `-1`
ms is a clean break that never causes duplication.

### Why slice in the frontend rather than only fetching `WINDOW_SIZE` bars?

Because the user needs to scroll seamlessly. If you only ever have 10,000 bars
loaded, scrolling back hits a hard wall at the oldest loaded bar and forces a
fetch. Pre-loading a few pages (via pagination) means there's always more data
available to slide into — the fetch only fires when you're truly out.

### Why does `rightOffset` not need to change when pages are prepended?

Because `rightOffset` is measured from the **newest** end of `allCandles`.
Prepending bars grows the array at the front, but the last bar's position from
the end is unchanged. So `len - rightOffset` still points to the same bar.
This is the fix that stopped the "window jumps forward on every fetch" bug.

### Why the double rAF in `onDataRendered`?

`requestAnimationFrame` fires before the next paint. Chaining two means the
second fires after the paint that renders the `setData` result. So the callback
runs when the new bars are already on screen. A single rAF would fire before
the paint, causing the loader to hide while the chart was still on the old
frame.

### Why use `staleTime: Infinity` for old pages?

Historical bars never change. If they did, we'd have a data integrity problem
somewhere upstream. Treating pages older than an hour as immutable means
scrolling back to a range you've seen before is instant — no network call, no
cache miss. The only page that can be extended is the newest one, so it gets
the short `staleTime`.

### Why doesn't the sliding window resubscribe on every render?

The scroll subscription is set up once per `chartEpoch`:

```ts
useEffect(() => {
  const chart = chartRefs.chart.current;
  if (!chart) return;
  chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
  return () => { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); };
}, [chartRefs, chartEpoch]);
```

Inside the handler, current values are read from refs
(`rightOffsetRef.current`, `allCandlesRef.current`, etc.). This keeps the
subscription stable across renders — otherwise every render would unsubscribe
and resubscribe, which is wasteful and would drop scroll events.

---

## Common problems and how to debug them

### The chart jumps or zooms out when a page loads

**Cause:** `useChartDataFlow`'s `setVisibleRange` is throwing because the
captured range is outside the new slice's bounds.

**Debug:**

```ts
console.log('[flow] prevRange', prevRange, 'newBounds',
            chartData[0]?.time, chartData[chartData.length-1]?.time);
```

If `prevRange.from < chartData[0].time` or `prevRange.to > chartData[last].time`,
the clamp isn't working. Check that the clamp is actually applied — the
`Math.max` / `Math.min` lines.

### `ERR_CONNECTION_REFUSED` burst during scroll

**Cause:** The scroll handler is firing `onNeedOlder()` on every frame because
the `isFetchingOlder` guard is missing or not reached.

**Debug:** Open DevTools Network, scroll to the edge. Count the `/api/stocks`
requests. If there are more than one per second, the guard isn't working.

**Fix:** The check in the sliding window handler should be:

```ts
} else if (canLoadOlderRef.current && !isFetchingOlderRef.current) {
  onNeedOlderRef.current?.();
}
```

Both conditions required.

### The loader never appears

**Possible causes:**

1. `isLoadingCandles` isn't reaching the component. Add a `console.log` at the
   top of `ChartPanel` and scroll to the edge.
2. The fetch is resolving in <16ms and the loader is being batched out. Add
   a `useMinVisible` wrapper if you need it to be visible for a minimum
   duration.
3. `isInitialLoading` isn't being passed through from `useInfiniteCandles` —
   check that the return value includes it.

### The loader never disappears

**Cause:** `onDataRendered` isn't firing, so `isLoadingOlder` never flips back
to false.

**Debug:** Add a log inside `onDataRendered` in `useChartDataFlow`. If it
doesn't fire, the `setData` effect is bailing early — usually because the
`dataSig` didn't change.

**Fix:** The signature must include `chartData[0].time` — otherwise a slide
that changes the first bar (but not the length or last bar) won't trigger the
effect.

### The chart freezes for 1–3 seconds on load

**Cause:** Too many bars in the slice, or expensive work per bar.

**Debug:**

```ts
console.time('setData');
series.setData(chartData);
console.timeEnd('setData');
```

If `setData` is >500ms, reduce `WINDOW_SIZE` in `useSlidingCandles`. If
`setData` is fine but the chart still feels slow, check the strategy
primitives in `useChartOverlays` — they iterate the whole array.

### Live ticks cause visible stutter

**Cause:** Something in the render path is doing O(n) work on every tick.

**Check:** The `dataSig` guard should prevent `setData` from firing on live
updates. If it's still firing, the signature is including `chartData[last].time`
— which is fine for new bars but shouldn't change on a tick that only modifies
the last bar's close. Verify that the tick is going through `applyTick` and
not through a `setData`.

### Scrolling back feels laggy

**Cause:** `setData` runs on every slide. This is expected — the slice content
changed, so the series needs to be rebuilt. The loader covers this.

**If it's still too slow:** Reduce `WINDOW_SIZE` or `SLIDE_BARS`, or reduce
`PAGE_WINDOW_MS` so pages are smaller. Smaller slices mean faster `setData`
but more frequent fetches.

---

## File map

| File | Role |
|------|------|
| `services/api/candles.ts` | `getCandlesInRange` — HTTP fetch + Rome offset |
| `pages/trading/hooks/useInfiniteCandles.ts` | React Query cache of pages |
| `pages/trading/hooks/useSlidingCandles.ts` | Slices `allCandles` to `WINDOW_SIZE` |
| `pages/trading/hooks/useChartDataFlow.ts` | `setData`, live updates, viewport preservation |
| `pages/trading/hooks/useChartInstance.ts` | Creates the chart + drawing manager |
| `pages/trading/hooks/useChartLegend.ts` | Crosshair → OHLCV legend |
| `pages/trading/hooks/useChartOverlays.ts` | Positions, orders, plugins, strategy primitives |
| `pages/trading/hooks/useChartAppearance.ts` | Colors, wicks, grid, timeframe formatting |
| `components/ChartPanel.tsx` | Orchestrator — wires everything together |

---

## Quick reference — the constants

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| `WINDOW_SIZE` | `useSlidingCandles` | 10,000 | Max bars the chart renders |
| `LOW_WATER` | `useSlidingCandles` | 50 | Distance from edge before sliding |
| `SLIDE_BARS` | `useSlidingCandles` | 3,000 | Bars shifted per slide |
| `PAGE_WINDOW_MS["1m"]` | `useInfiniteCandles` | 7 days | Page size for 1m |
| `PAGE_WINDOW_MS["15m"]` | `useInfiniteCandles` | 90 days | Page size for 15m |
| `ROME_DTF` | `services/api/candles.ts` | singleton | Prevents per-bar formatter churn |

If you change any of these, re-read the section that explains it — the
trade-offs are non-obvious and changing one usually requires changing another.