// The find contract (design/pluggable-find.md). Types only.

export interface FindAnchor {
  /** Row anchor id (`messageRowAnchorIds` for the Messages tab). */
  id: string;
}

/** A row the source found matches in. The source says which rows and roughly
 *  how many; the rendered row says exactly where. */
export interface FindRow {
  anchor: FindAnchor;
  /** 0-based position of the row in the surface, so a surface can page its
   *  data through a row it has not loaded yet before revealing it. */
  index: number;
  /** The source's count of matches in the row (an estimate). */
  count: number;
  /** The exact source substrings that matched; the row highlights every DOM
   *  occurrence of these. */
  texts: string[];
}

export interface FindQuery {
  /** Matched as a case- and diacritic-insensitive literal substring. */
  text: string;
}

export interface FindTotal {
  rows: number;
  occurrences: number;
  /** "gte" until a page walks off the sealed source; the band shows M+. */
  relation: "eq" | "gte";
}

export interface FindPage {
  /** Rows in the direction of travel: a backward page is nearest-first. */
  rows: FindRow[];
  total: FindTotal;
  /** False when the sample is still being written. A short page (limit or
   *  time budget) is `relation: "gte"`, not `complete: false`. */
  complete: boolean;
}

export interface FindCursor {
  /** Resume strictly after this row (or before, going backward). */
  anchor: FindAnchor;
}

export type FindDirection = "forward" | "backward";

export interface FindOptions {
  direction: FindDirection;
  cursor?: FindCursor;
  /** Max rows in the page. */
  limit: number;
}

export interface FindSource {
  find(
    query: FindQuery,
    page: FindOptions,
    signal: AbortSignal
  ): Promise<FindPage>;
}

export interface FindSurface {
  scopeId: string;
  source: FindSource;
  /** Bring the row into view (page it in, jump the list). Fire-and-forget:
   *  the row itself centres the active occurrence once it renders, or
   *  flashes if it renders none. A function property, not a method, so the
   *  coordinator can hold it detached. */
  reveal: (row: FindRow, signal: AbortSignal) => void;
}

/** Coordinator state consumed by FindBand and the per-row highlight hook. */
export interface FindState {
  /** Current search term ("" when idle). */
  term: string;
  /** Known row window: a contiguous run of matching rows in scope order. */
  rows: FindRow[];
  /** The distinct texts matched across the window (what collapsed panels
   *  expand for). */
  variants: string[];
  /** Index of the active row within `rows`, or null. */
  activeRow: number | null;
  /** 0-based DOM occurrence within the active row, or null. */
  activeOccurrence: number | null;
  /** 0-based position of the active occurrence in the whole universe (the
   *  "N" of "N of M"): the source counts of the rows before, plus the DOM
   *  index clamped to the active row's source count. Null when unknown
   *  (window anchored at neither universe edge, or at the end of an inexact
   *  universe) and while the active row renders no match. */
  activeOrdinal: number | null;
  /** Proven match counts so far (the "M"); `relation: "gte"` until pagination
   *  walks off the source. Never rewritten from the DOM. */
  total: FindTotal | null;
  /** The last page saw the whole universe (false renders the total as "M+"). */
  complete: boolean;
  /** The last survey saw the whole universe and found nothing (an incomplete
   *  prefix with no matches stays silent). */
  noResults: boolean;
  /** Scope of the registered surface, or null. */
  scopeId: string | null;
}

export interface FindCoordinator {
  /** Current state snapshot (subscribe through `useFindState`). */
  getState(): FindState;
  registerSurface(surface: FindSurface): () => void;
  /** Swap the registered surface's source in place (its view configuration
   *  changed); re-surveys like `invalidate`. */
  updateSource(scopeId: string, source: FindSource): void;
  /** The registered surface's data changed: re-survey the current term,
   *  relocating the active row. */
  invalidate(scopeId: string): void;
  /** A row's highlighter is mounted (returns the detach). Only a mounted
   *  row's DOM count is kept. */
  attachRow(anchorId: string): () => void;
  /** A mounted row reports how many DOM matches of its texts it renders;
   *  stepping inside the row then follows that count, not the source's.
   *  `null` withdraws the report (the row is re-rendering) so stepping falls
   *  back to the source count. */
  reportRowCount(anchorId: string, count: number | null): void;
  /** Start a new query (aborting any in-flight one). "" clears. */
  setTerm(term: string): void;
  /** Step to the next/previous occurrence, wrapping around the scope. */
  next(): void;
  previous(): void;
  /** Abort everything and reset to idle (band closed). */
  close(): void;
}
