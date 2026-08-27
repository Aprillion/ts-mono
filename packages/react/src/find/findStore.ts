import type {
  FindAnchor,
  FindCoordinator,
  FindCursor,
  FindDirection,
  FindPage,
  FindRow,
  FindSource,
  FindState,
  FindSurface,
  FindTotal,
} from "./types";

// Page sizes are guesses (not calibrated on real transcripts), bounded by the
// view server's 1000-row page cap.
export const FIND_SURVEY_LIMIT = 1000;
export const FIND_STEP_LIMIT = 200;

export const FIND_IDLE_STATE: FindState = {
  term: "",
  rows: [],
  variants: [],
  activeRow: null,
  activeOccurrence: null,
  activeOrdinal: null,
  total: null,
  complete: false,
  noResults: false,
  scopeId: null,
};

interface ActivePosition {
  row: number;
  occurrence: number;
}

/**
 * The registered FindSurface plus the query, row window and navigation state.
 *
 * `rows` is a contiguous run of matching rows in scope order. A term change
 * surveys forward from the top; stepping inside the window is local, past an
 * edge it pages with a cursor, past a known universe edge it re-windows from
 * the opposite end. At most one page is in flight; steps taken meanwhile
 * accumulate as a signed count and apply when the page commits (a re-survey
 * keeps them, a term change drops them). Inside a row the step count is its
 * DOM match count while it is mounted and has reported, the source's count
 * otherwise; a row rendering none of its matches is skipped. "N of M" stays
 * in source counts (see `ordinal`).
 */
export class FindStore implements FindCoordinator {
  private state: FindState = FIND_IDLE_STATE;
  private listeners = new Set<() => void>();
  private surface: FindSurface | null = null;
  private term = "";
  private rows: FindRow[] = [];
  private active: ActivePosition | null = null;
  private serverTotal: FindTotal | null = null;
  private complete = false;
  private noResults = false;
  private windowAtStart = true;
  private windowAtEnd = false;
  /** The anchor the window's first row follows (a forward cursor page's
   *  cursor), when known; null at the universe start or when unknown. */
  private windowBefore: FindAnchor | null = null;
  private mounted = new Set<string>();
  private domCounts = new Map<string, number>();
  private inflight: AbortController | null = null;
  private revealAbort: AbortController | null = null;
  /** Steps taken while a page is in flight: +1 forward, -1 backward. */
  private pending = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): FindState => this.state;

  private publish(): void {
    const next: FindState = {
      term: this.term,
      rows: this.rows,
      variants:
        this.rows === this.state.rows
          ? this.state.variants
          : [...new Set(this.rows.flatMap((row) => row.texts))],
      activeRow: this.active?.row ?? null,
      activeOccurrence: this.active?.occurrence ?? null,
      activeOrdinal: this.ordinal(),
      total: this.serverTotal,
      complete: this.complete,
      noResults: this.noResults,
      scopeId: this.surface?.scopeId ?? null,
    };
    // React cleanup+setup pairs re-register the same surface; publishing an
    // unchanged snapshot would re-render every consumer for nothing.
    const keys = Object.keys(next) as (keyof FindState)[];
    if (keys.every((k) => Object.is(this.state[k], next[k]))) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  private stepCount(row: FindRow): number {
    return this.domCounts.get(row.anchor.id) ?? row.count;
  }

  /** The active occurrence's universe position in source counts, computable
   *  from whichever universe edge the window touches (the end only under an
   *  exact total); null otherwise, and null while the active row renders no
   *  match (it flashes instead). */
  private ordinal(): number | null {
    const active = this.active;
    if (!active) return null;
    const rows = this.rows;
    const activeRow = rows[active.row]!;
    if (this.stepCount(activeRow) === 0) return null;
    const within = Math.min(
      active.occurrence,
      Math.max(activeRow.count - 1, 0)
    );
    if (this.windowAtStart) {
      let before = 0;
      for (let i = 0; i < active.row; i++) before += rows[i]!.count;
      return before + within;
    }
    const total = this.serverTotal;
    if (this.windowAtEnd && total && total.relation === "eq" && this.complete) {
      let fromActive = 0;
      for (let i = active.row; i < rows.length; i++)
        fromActive += rows[i]!.count;
      return total.occurrences - fromActive + within;
    }
    return null;
  }

  registerSurface(surface: FindSurface): () => void {
    this.setSurface(surface);
    return () => {
      if (this.surface === surface) this.setSurface(null);
    };
  }

  updateSource(scopeId: string, source: FindSource): void {
    const surface = this.surface;
    if (!surface || surface.scopeId !== scopeId || surface.source === source)
      return;
    surface.source = source;
    this.invalidate(scopeId);
  }

  invalidate(scopeId: string): void {
    if (this.surface?.scopeId === scopeId && this.term) this.survey();
  }

  attachRow(anchorId: string): () => void {
    this.mounted.add(anchorId);
    return () => {
      this.mounted.delete(anchorId);
      this.forgetRowCount(anchorId);
    };
  }

  reportRowCount(anchorId: string, count: number | null): void {
    if (!this.mounted.has(anchorId)) return;
    if (count === null) {
      this.forgetRowCount(anchorId);
      return;
    }
    if (this.domCounts.get(anchorId) === count) return;
    this.domCounts.set(anchorId, count);
    this.clampActive(anchorId, count);
    this.publish();
  }

  /** Back to the source count: clamp the active occurrence to it. */
  private forgetRowCount(anchorId: string): void {
    if (!this.domCounts.delete(anchorId)) return;
    const active = this.active;
    if (active) this.clampActive(anchorId, this.rows[active.row]!.count);
    this.publish();
  }

  private clampActive(anchorId: string, count: number): void {
    const active = this.active;
    if (
      active &&
      this.rows[active.row]!.anchor.id === anchorId &&
      active.occurrence >= count
    ) {
      active.occurrence = Math.max(count - 1, 0);
    }
  }

  private setSurface(surface: FindSurface | null): void {
    this.surface = surface;
    this.reset();
    this.publish();
    if (surface && this.term) this.survey();
  }

  setTerm(term: string): void {
    if (term === this.term) return;
    this.reset();
    this.term = term;
    this.publish();
    if (term && this.surface) this.survey();
  }

  next(): void {
    this.step("forward");
  }

  previous(): void {
    this.step("backward");
  }

  close(): void {
    this.reset();
    this.term = "";
    this.publish();
  }

  dispose(): void {
    this.abortAll();
    this.listeners.clear();
  }

  private abortAll(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.revealAbort?.abort();
    this.revealAbort = null;
    this.pending = 0;
  }

  private reset(): void {
    this.abortAll();
    this.rows = [];
    this.active = null;
    this.serverTotal = null;
    this.complete = false;
    this.noResults = false;
    this.domCounts.clear();
    this.windowAtStart = true;
    this.windowAtEnd = false;
    this.windowBefore = null;
  }

  // ---- Querying ---------------------------------------------------------

  /** Fetch one page and hand it to `onPage`, then apply the steps taken
   *  meanwhile. A superseded fetch exits silently; a failed one ends in a
   *  coherent empty state rather than stale rows under a blank band. */
  private fetch(
    opts: { direction: FindDirection; cursor?: FindCursor; limit: number },
    onPage: (page: FindPage) => void
  ): void {
    const surface = this.surface;
    if (!surface) return;
    this.inflight?.abort();
    const ac = new AbortController();
    this.inflight = ac;
    surface.source
      .find({ text: this.term }, opts, ac.signal)
      .then(
        (page) => {
          if (this.inflight !== ac) return;
          this.inflight = null;
          this.serverTotal = page.total;
          this.complete = page.complete;
          onPage(page);
          this.drain();
        },
        () => {
          if (this.inflight !== ac) return;
          this.inflight = null;
          this.pending = 0;
          this.reset();
          this.publish();
        }
      )
      .catch((error: unknown) => console.error(error));
  }

  /** Survey the term forward: from the top while that page holds the active
   *  row (N stays known), else from just before the active row so it stays
   *  in the window.
   *  The current window stays on screen until the page lands; the active row
   *  is then relocated by anchor without revealing (a live append never
   *  yanks the view), else the nearest row by index, else the first match,
   *  is revealed. Steps pending behind the page are applied from the
   *  relocated position (only a term change drops them). */
  private survey(): void {
    if (!this.surface || !this.term) return;
    const previous = this.active
      ? { row: this.rows[this.active.row]!, occurrence: this.active.occurrence }
      : null;
    const cursor = this.surveyCursor();
    this.fetch(
      { direction: "forward", cursor, limit: FIND_SURVEY_LIMIT },
      (page) => {
        this.rows = page.rows;
        this.windowAtStart = cursor === undefined;
        this.windowBefore = cursor?.anchor ?? null;
        this.windowAtEnd = this.coversEdge(
          page,
          page.rows.length,
          this.windowAtStart
        );
        this.noResults =
          page.complete &&
          page.total.occurrences === 0 &&
          page.rows.length === 0;
        this.active = null;
        if (previous) {
          const byAnchor = this.rows.findIndex(
            (row) => row.anchor.id === previous.row.anchor.id
          );
          if (byAnchor !== -1) {
            const max = Math.max(this.stepCount(this.rows[byAnchor]!) - 1, 0);
            this.active = {
              row: byAnchor,
              occurrence: Math.min(previous.occurrence, max),
            };
            this.publish();
            return;
          }
          const nearest = this.nearestByIndex(previous.row.index);
          if (nearest !== null) {
            this.activateRow(nearest, "forward");
            return;
          }
        }
        // Steps taken meanwhile enter the page from its edge (see `drain`), so
        // Enter during the survey lands on 1 of M, not 2.
        if (this.pending !== 0) {
          this.publish();
          return;
        }
        const first = this.nextRow(-1, "forward");
        if (first === null) this.publish();
        else this.activateRow(first, "forward");
      }
    );
  }

  /** Where a re-survey starts so its page holds the active row: the top
   *  while the window starts there and the row is within a page (N stays
   *  known); else the row before the active one, or, for a window's first
   *  row, the anchor the window itself follows. */
  private surveyCursor(): FindCursor | undefined {
    const active = this.active;
    if (!active) return undefined;
    if (this.windowAtStart && active.row < FIND_SURVEY_LIMIT) return undefined;
    const before = this.rows[active.row - 1];
    if (before) return { anchor: before.anchor };
    return this.windowBefore ? { anchor: this.windowBefore } : undefined;
  }

  private nearestByIndex(index: number): number | null {
    let best: number | null = null;
    let distance = Infinity;
    this.rows.forEach((row, i) => {
      const d = Math.abs(row.index - index);
      if (d < distance && this.stepCount(row) > 0) {
        best = i;
        distance = d;
      }
    });
    return best;
  }

  // ---- Stepping -----------------------------------------------------------

  private step(direction: FindDirection): void {
    if (!this.term || !this.surface) return;
    this.pending += direction === "forward" ? 1 : -1;
    this.drain();
  }

  /** Apply pending steps until none remain or one needs a page. */
  private drain(): void {
    while (this.pending !== 0 && !this.inflight) {
      if (this.rows.length === 0) {
        this.pending = 0;
        return;
      }
      const direction = this.pending > 0 ? "forward" : "backward";
      if (!this.tryStep(direction)) return;
      this.pending -= this.pending > 0 ? 1 : -1;
    }
  }

  /** The nearest row past `from` in `direction` that still has matches to
   *  step through, or null at the window edge. */
  private nextRow(from: number, direction: FindDirection): number | null {
    const step = direction === "forward" ? 1 : -1;
    for (let i = from + step; i >= 0 && i < this.rows.length; i += step) {
      if (this.stepCount(this.rows[i]!) > 0) return i;
    }
    return null;
  }

  /** One step; false when it started a page fetch instead. */
  private tryStep(direction: FindDirection): boolean {
    const active = this.active;
    const forward = direction === "forward";
    if (active) {
      const count = this.stepCount(this.rows[active.row]!);
      if (forward && active.occurrence + 1 < count) {
        this.activate(active.row, active.occurrence + 1);
        return true;
      }
      if (!forward && active.occurrence > 0 && count > 0) {
        this.activate(active.row, Math.min(active.occurrence - 1, count - 1));
        return true;
      }
    }
    const from = active ? active.row : forward ? -1 : this.rows.length;
    const row = this.nextRow(from, direction);
    if (row !== null) {
      this.activateRow(row, direction);
      return true;
    }
    if (forward ? this.windowAtEnd : this.windowAtStart) {
      if (this.windowAtStart && this.windowAtEnd) {
        const wrapped = this.nextRow(
          forward ? -1 : this.rows.length,
          direction
        );
        if (wrapped !== null) this.activateRow(wrapped, direction);
        return true;
      }
      this.rewindow(forward ? "start" : "end");
      return false;
    }
    this.extend(direction);
    return false;
  }

  /** Enter a row from the direction of travel: its first occurrence going
   *  forward, its last going backward. */
  private activateRow(row: number, direction: FindDirection): void {
    const count = this.stepCount(this.rows[row]!);
    this.activate(row, direction === "forward" ? 0 : Math.max(count - 1, 0));
  }

  private activate(row: number, occurrence: number): void {
    const target = this.rows[row];
    if (!target || !this.surface) return;
    this.active = { row, occurrence };
    this.publish();
    this.revealAbort?.abort();
    this.revealAbort = new AbortController();
    this.surface.reveal(target, this.revealAbort.signal);
  }

  /**
   * Whether the window now reaches the far universe edge. Only a page that
   * saw the whole universe (`complete`) can prove one: with the window
   * anchored at the opposite edge and an exact total, the row total is
   * authoritative; otherwise a part-filled page proves the scan ran out (a
   * full page proves nothing, since sources may cap pages below `limit`).
   */
  private coversEdge(
    page: FindPage,
    windowLength: number,
    anchoredAtOppositeEdge: boolean,
    limit = FIND_SURVEY_LIMIT
  ): boolean {
    if (!page.complete) return false;
    if (anchoredAtOppositeEdge && page.total.relation === "eq") {
      return windowLength >= page.total.rows;
    }
    return page.rows.length < limit;
  }

  private extend(direction: FindDirection): void {
    const edge =
      direction === "forward" ? this.rows[this.rows.length - 1] : this.rows[0];
    if (!edge) return;
    this.fetch(
      { direction, cursor: { anchor: edge.anchor }, limit: FIND_STEP_LIMIT },
      (page) => {
        if (page.rows.length === 0) {
          if (direction === "forward") this.windowAtEnd = true;
          else this.windowAtStart = true;
        } else if (direction === "forward") {
          this.rows = [...this.rows, ...page.rows];
          this.windowAtEnd = this.coversEdge(
            page,
            this.rows.length,
            this.windowAtStart,
            FIND_STEP_LIMIT
          );
        } else {
          // Backward pages arrive nearest-first.
          const reversed = [...page.rows].reverse();
          this.rows = [...reversed, ...this.rows];
          this.windowBefore = null;
          if (this.active) this.active.row += reversed.length;
          this.windowAtStart = this.coversEdge(
            page,
            this.rows.length,
            this.windowAtEnd,
            FIND_STEP_LIMIT
          );
        }
        this.publish();
      }
    );
  }

  /** Replace the window from a universe edge (wrap-around); the pending step
   *  then enters it from that edge. An opposite step meanwhile nets the
   *  pending count to zero: the page is then dropped and the current window
   *  and position stay. */
  private rewindow(edge: "start" | "end"): void {
    const direction: FindDirection = edge === "start" ? "forward" : "backward";
    this.fetch({ direction, limit: FIND_STEP_LIMIT }, (page) => {
      if (this.pending === 0) return;
      const coversAll = this.coversEdge(
        page,
        page.rows.length,
        true,
        FIND_STEP_LIMIT
      );
      if (edge === "start") {
        this.rows = page.rows;
        this.windowAtStart = true;
        this.windowAtEnd = coversAll;
      } else {
        this.rows = [...page.rows].reverse();
        this.windowAtEnd = true;
        this.windowAtStart = coversAll;
      }
      this.windowBefore = null;
      this.active = null;
      this.publish();
    });
  }
}
