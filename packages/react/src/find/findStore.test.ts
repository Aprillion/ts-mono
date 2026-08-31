import { describe, expect, it, vi } from "vitest";

import { FIND_STEP_LIMIT, FindStore } from "./findStore";
import type {
  FindOptions,
  FindPage,
  FindQuery,
  FindRow,
  FindSource,
  FindSurface,
} from "./types";

const row = (id: string, count = 1, index = 0): FindRow => ({
  anchor: { id },
  index,
  count,
  texts: ["x"],
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** [activeRow, activeOccurrence, activeOrdinal, total occurrences] */
const pos = (store: FindStore) => {
  const st = store.getState();
  return [
    st.activeRow,
    st.activeOccurrence,
    st.activeOrdinal,
    st.total?.occurrences ?? null,
  ];
};

interface FakeSurfaceOptions {
  /** Report every page as complete:false (a loaded-prefix source). */
  incomplete?: boolean;
  /** Hold each page until this promise resolves (for in-flight tests). */
  gate?: Promise<void>;
  /** Hold only the calls after this many (1 = every call but the survey). */
  gateAfter?: number;
  /** Cap pages at this many rows regardless of the requested limit. */
  pageSize?: number;
  /** If set, only requests with this `limit` wait on `gate`. */
  gateLimit?: number;
}

function makeSurface(
  scopeId: string,
  all: FindRow[],
  options: FakeSurfaceOptions = {}
): {
  surface: FindSurface;
  reveal: ReturnType<typeof vi.fn>;
  calls: FindOptions[];
} {
  const calls: FindOptions[] = [];
  const source: FindSource = {
    // Rows strictly past the cursor, in the direction of travel.
    async find(_query: FindQuery, opts: FindOptions): Promise<FindPage> {
      calls.push(opts);
      if (
        options.gate &&
        (options.gateLimit === undefined || opts.limit === options.gateLimit)
      ) {
        const n =
          options.gateLimit === undefined
            ? calls.length
            : calls.filter((c) => c.limit === options.gateLimit).length;
        if (n > (options.gateAfter ?? 0)) {
          await options.gate;
        }
      }
      const backward = opts.direction === "backward";
      const limit = Math.min(opts.limit, options.pageSize ?? opts.limit);
      const step = backward ? -1 : 1;
      let i: number;
      if (opts.cursor) {
        const at = all.findIndex((r) => r.anchor.id === opts.cursor!.anchor.id);
        i = backward ? at - 1 : at + 1;
      } else {
        i = backward ? all.length - 1 : 0;
      }
      const page: FindRow[] = [];
      for (; i >= 0 && i < all.length && page.length < limit; i += step) {
        page.push(all[i]!);
      }
      const more = i >= 0 && i < all.length;
      const occurrences = page.reduce((sum, r) => sum + r.count, 0);
      return {
        rows: page,
        complete: !options.incomplete,
        total: {
          rows: page.length,
          occurrences,
          relation: more || options.incomplete ? "gte" : "eq",
        },
      };
    },
  };
  const reveal = vi.fn();
  return { surface: { scopeId, source, reveal }, reveal, calls };
}

describe("FindStore", () => {
  it("surveys on term change: fills the window, totals, reveals the first row", async () => {
    const store = new FindStore();
    const { surface, reveal } = makeSurface("messages", [
      row("a", 2),
      row("b"),
      row("c"),
    ]);
    store.registerSurface(surface);

    store.setTerm("x");
    await flush();

    const st = store.getState();
    expect(st.rows).toHaveLength(3);
    expect(pos(store)).toEqual([0, 0, 0, 4]);
    expect(st.complete).toBe(true);
    expect(st.noResults).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(row("a", 2), expect.any(AbortSignal));
  });

  it("keeps paging a gte survey and sums M until eq", async () => {
    const all = [
      row("a", 1, 0),
      row("b", 1, 1),
      row("c", 1, 2),
      row("d", 1, 3),
    ];
    const calls: FindOptions[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source: FindSource = {
      async find(_query: FindQuery, opts: FindOptions): Promise<FindPage> {
        calls.push(opts);
        if (calls.length > 1) await gate;
        const at = opts.cursor
          ? all.findIndex((r) => r.anchor.id === opts.cursor!.anchor.id)
          : -1;
        const start = at + 1;
        const page = all.slice(start, start + 2);
        const reached = start + page.length >= all.length;
        return {
          rows: page,
          complete: true,
          total: {
            rows: page.length,
            occurrences: page.length,
            relation: reached ? "eq" : "gte",
          },
        };
      },
    };
    const store = new FindStore();
    store.registerSurface({
      scopeId: "messages",
      source,
      reveal: vi.fn(),
    });
    store.setTerm("x");
    await flush();
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual(["a", "b"]);
    expect(store.getState().total).toEqual({
      rows: 2,
      occurrences: 2,
      relation: "gte",
    });
    expect(store.getState().complete).toBe(false);
    store.next();
    expect(pos(store)).toEqual([1, 0, 1, 2]);
    release();
    await flush();
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual(["a", "b"]);
    expect(store.getState().total).toEqual({
      rows: 4,
      occurrences: 4,
      relation: "eq",
    });
    expect(store.getState().complete).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not double-count an extend that lands behind the count frontier", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 200 }, (_, i) => row(`m${i}`, 1, i));
    const { surface } = makeSurface("messages", all, { pageSize: 50 });
    store.registerSurface(surface);
    store.setTerm("x");
    for (let i = 0; i < 8; i++) await flush();
    expect(store.getState().total).toEqual({
      rows: 200,
      occurrences: 200,
      relation: "eq",
    });
    expect(store.getState().rows).toHaveLength(50);
    store.next();
    for (let i = 0; i < 49; i++) store.next();
    await flush();
    expect(store.getState().rows).toHaveLength(100);
    expect(store.getState().total).toEqual({
      rows: 200,
      occurrences: 200,
      relation: "eq",
    });
  });

  it("reports noResults when the survey finds nothing", async () => {
    const store = new FindStore();
    const { surface, reveal } = makeSurface("messages", []);
    store.registerSurface(surface);

    store.setTerm("x");
    await flush();

    expect(store.getState().noResults).toBe(true);
    expect(store.getState().total?.occurrences).toBe(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("stays silent, not 'No results', when an incomplete prefix has no matches", async () => {
    const store = new FindStore();
    const { surface } = makeSurface("messages", [], { incomplete: true });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    const st = store.getState();
    expect(st.noResults).toBe(false);
    expect(st.complete).toBe(false);
    expect(st.total?.occurrences).toBe(0);
  });

  it("steps through a row's occurrences by the source count, then into the next row, wrapping locally", async () => {
    const store = new FindStore();
    const { surface, reveal } = makeSurface("messages", [
      row("a", 2),
      row("b"),
    ]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();

    store.next();
    expect(pos(store)).toEqual([0, 1, 1, 3]);
    store.next();
    expect(pos(store)).toEqual([1, 0, 2, 3]);
    store.next();
    expect(pos(store)).toEqual([0, 0, 0, 3]);
    store.previous();
    expect(pos(store)).toEqual([1, 0, 2, 3]);
    store.previous();
    expect(pos(store)).toEqual([0, 1, 1, 3]);
    // Every activation reveals its row (the row centres the occurrence).
    expect(reveal).toHaveBeenCalledTimes(6);
  });

  it("steps a rendered row by its DOM count while N stays in source counts", async () => {
    const store = new FindStore();
    const { surface } = makeSurface("messages", [row("a", 3), row("b")]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    expect(pos(store)).toEqual([0, 2, 2, 4]);

    // Only a mounted row's count is kept.
    store.reportRowCount("a", 2);
    expect(pos(store)).toEqual([0, 2, 2, 4]);
    store.attachRow("a");

    // Fewer DOM matches than the source counted: clamp, and move on earlier.
    store.reportRowCount("a", 2);
    expect(pos(store)).toEqual([0, 1, 1, 4]);
    store.next();
    expect(pos(store)).toEqual([1, 0, 3, 4]);
    store.previous();
    expect(pos(store)).toEqual([0, 1, 1, 4]);

    // More DOM matches than counted: step through them all, N stops rising.
    store.reportRowCount("a", 5);
    store.next();
    store.next();
    expect(pos(store)).toEqual([0, 3, 2, 4]);
    store.next();
    expect(pos(store)).toEqual([0, 4, 2, 4]);
    store.next();
    expect(pos(store)).toEqual([1, 0, 3, 4]);
  });

  it("a row that renders none of its matches has no ordinal and is skipped afterwards", async () => {
    const store = new FindStore();
    const { surface } = makeSurface("messages", [
      row("a"),
      row("b", 2),
      row("c"),
    ]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    expect(pos(store)).toEqual([1, 0, 1, 4]);

    store.attachRow("b");
    store.reportRowCount("b", 0);
    expect(pos(store)).toEqual([1, 0, null, 4]);
    store.next();
    expect(pos(store)).toEqual([2, 0, 3, 4]);
    store.previous();
    expect(pos(store)).toEqual([0, 0, 0, 4]);
    store.previous();
    expect(pos(store)).toEqual([2, 0, 3, 4]);
  });

  it("enters the survey page from the edge with the Enters pressed while it was in flight: one Enter lands on 1 of M", async () => {
    const store = new FindStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const all = Array.from({ length: 5 }, (_, i) => row(`m${i}`));
    const { surface, reveal } = makeSurface("messages", all, { gate });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    expect(store.getState().activeRow).toBeNull();

    release();
    await flush();
    expect(pos(store)).toEqual([0, 0, 0, 5]);
    expect(reveal).toHaveBeenCalledTimes(1);

    // Mashed Enter counts from the first match; Shift+Enter enters from the end.
    store.setTerm("xy");
    store.next();
    store.next();
    store.next();
    await flush();
    expect(pos(store)).toEqual([2, 0, 2, 5]);
    store.setTerm("xyz");
    store.previous();
    await flush();
    expect(pos(store)).toEqual([4, 0, 4, 5]);
  });

  it("extends the window with a cursor call when stepping past its end", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 6 }, (_, i) => row(`m${i}`));
    const { surface, calls } = makeSurface("messages", all, { pageSize: 3 });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    expect(store.getState().rows).toHaveLength(3);

    store.next();
    store.next();
    store.next();
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      direction: "forward",
      cursor: { anchor: { id: "m2" } },
      limit: 200,
    });
    expect(store.getState().rows).toHaveLength(6);
    expect(pos(store)).toEqual([3, 0, 3, 6]);
  });

  it("wraps backward past an incomplete window via a backward no-cursor call, nearest-first, and reports N from the end", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 6 }, (_, i) => row(`m${i}`, 2));
    const { surface, calls } = makeSurface("messages", all, { pageSize: 3 });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();

    store.previous();
    await flush();
    expect(calls.some((c) => c.direction === "backward" && !c.cursor)).toBe(
      true
    );
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual([
      "m3",
      "m4",
      "m5",
    ]);
    expect(pos(store)).toEqual([2, 1, 11, 12]);

    // And forward from the suffix window back to the universe start.
    store.next();
    await flush();
    expect(calls.some((c) => c.direction === "forward" && !c.cursor)).toBe(
      true
    );
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual([
      "m0",
      "m1",
      "m2",
    ]);
    expect(pos(store)).toEqual([0, 0, 0, 12]);
  });

  it("Shift+Enter wrap does not report a negative N when a 1-row survey later claims eq", async () => {
    // Survey paints one hit (50ms budget analogue) then a follow-up page
    // walks off EOF, while a backward wrap still returns later rows — the
    // band used to show "-2 of 1".
    const all = Array.from({ length: 5 }, (_, i) => row(`m${i}`, 1, i));
    const store = new FindStore();
    const source: FindSource = {
      async find(_query: FindQuery, opts: FindOptions): Promise<FindPage> {
        if (opts.direction === "forward" && !opts.cursor) {
          return {
            rows: [all[0]!],
            complete: true,
            total: { rows: 1, occurrences: 1, relation: "gte" },
          };
        }
        if (opts.direction === "forward") {
          return {
            rows: [],
            complete: true,
            total: { rows: 0, occurrences: 0, relation: "eq" },
          };
        }
        return {
          rows: [all[4]!, all[3]!, all[2]!, all[1]!],
          complete: true,
          total: { rows: 4, occurrences: 4, relation: "gte" },
        };
      },
    };
    store.registerSurface({
      scopeId: "messages",
      source,
      reveal: vi.fn(),
    });
    store.setTerm("x");
    await flush();
    expect(pos(store)).toEqual([0, 0, 0, 1]);

    store.previous();
    await flush();
    store.previous();
    store.previous();
    store.previous();
    const st = store.getState();
    expect(st.activeOccurrence).toBeGreaterThanOrEqual(0);
    expect(st.activeOrdinal).not.toBeNull();
    expect(st.activeOrdinal).toBeGreaterThanOrEqual(0);
    expect(st.total?.occurrences).toBeGreaterThanOrEqual(4);
  });

  it("does not treat a short incomplete survey as the universe end: re-queries with a cursor, then wraps when nothing more comes", async () => {
    const store = new FindStore();
    const { surface, calls } = makeSurface("messages", [row("a"), row("b")], {
      incomplete: true,
    });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    await flush();
    expect(
      calls.some(
        (c) => c.cursor?.anchor.id === "b" && c.limit === FIND_STEP_LIMIT
      )
    ).toBe(true);
    expect(pos(store)).toEqual([0, 0, 0, 2]);
  });

  it("aborts the in-flight query when the term changes and drops its page even when it lands last", async () => {
    const store = new FindStore();
    const gates = new Map<string, () => void>();
    const signals: AbortSignal[] = [];
    const reveal = vi.fn();
    const surface: FindSurface = {
      scopeId: "messages",
      source: {
        async find(query, _opts, signal) {
          signals.push(signal);
          // A source that ignores the signal: the page still arrives.
          await new Promise<void>((resolve) => gates.set(query.text, resolve));
          const rows = query.text === "x" ? [row("stale")] : [row("fresh")];
          return {
            rows,
            complete: true,
            total: { rows: 1, occurrences: 1, relation: "eq" },
          };
        },
      },
      reveal,
    };
    store.registerSurface(surface);
    store.setTerm("x");
    store.setTerm("xy");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    gates.get("xy")!();
    await flush();
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual(["fresh"]);
    gates.get("x")!();
    await flush();
    expect(store.getState().term).toBe("xy");
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual(["fresh"]);
    expect(pos(store)).toEqual([0, 0, 0, 1]);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalledWith(
      row("stale"),
      expect.any(AbortSignal)
    );
  });

  it("re-surveys without revealing when the surface's source is swapped, relocating the active row by anchor", async () => {
    const store = new FindStore();
    const { surface, reveal } = makeSurface("messages", [
      row("a"),
      row("b", 3),
    ]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    expect(pos(store)).toEqual([1, 1, 2, 4]);
    reveal.mockClear();

    const swapped = makeSurface("messages", [row("z"), row("a"), row("b", 3)]);
    store.updateSource("messages", swapped.surface.source);
    await flush();
    expect(pos(store)).toEqual([2, 1, 3, 5]);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("clamps the relocated occurrence when the row shrank, and reveals the first row when the active one vanished", async () => {
    const store = new FindStore();
    const { surface, reveal } = makeSurface("messages", [
      row("a"),
      row("b", 3),
    ]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    store.next();
    expect(pos(store)).toEqual([1, 2, 3, 4]);

    store.updateSource(
      "messages",
      makeSurface("messages", [row("a"), row("b", 1)]).surface.source
    );
    await flush();
    expect(pos(store)).toEqual([1, 0, 1, 2]);

    reveal.mockClear();
    store.updateSource(
      "messages",
      makeSurface("messages", [row("c"), row("d")]).surface.source
    );
    await flush();
    expect(pos(store)).toEqual([0, 0, 0, 2]);
    expect(reveal).toHaveBeenCalledWith(row("c"), expect.any(AbortSignal));
  });

  it("re-surveys the same source on invalidate, keeping the active row", async () => {
    const store = new FindStore();
    const all = [row("a"), row("b")];
    const { surface, calls } = makeSurface("messages", all);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    all.unshift(row("z"));
    store.invalidate("messages");
    store.invalidate("other");
    await flush();
    expect(calls).toHaveLength(2);
    expect(pos(store)).toEqual([2, 0, 2, 3]);
  });

  it("re-surveys a live sample around an active row beyond the first page, poll after poll", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 1100 }, (_, i) => row(`m${i}`, 1, i));
    const { surface, calls, reveal } = makeSurface("messages", all, {
      incomplete: true,
    });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.previous(); // wrap to the end of the running sample
    await flush();
    const activeId = () =>
      store.getState().rows[pos(store)[0] as number]?.anchor.id;
    expect(activeId()).toBe("m1099");
    reveal.mockClear();

    // Poll: the window is re-surveyed from just before the active row.
    all.push(row("m1100", 1, 1100));
    store.invalidate("messages");
    await flush();
    expect(
      calls.some(
        (c) =>
          c.direction === "forward" &&
          c.cursor?.anchor.id === "m1098" &&
          c.limit === 1000
      )
    ).toBe(true);
    expect(activeId()).toBe("m1099");

    // Next poll: the active row is now the window's first row; the window's
    // own predecessor is the cursor, so the row stays put again.
    const surveysFrom1098 = () =>
      calls.filter(
        (c) =>
          c.direction === "forward" &&
          c.cursor?.anchor.id === "m1098" &&
          c.limit === 1000
      ).length;
    const before = surveysFrom1098();
    all.push(row("m1101", 1, 1101));
    store.invalidate("messages");
    await flush();
    expect(surveysFrom1098()).toBeGreaterThan(before);
    expect(activeId()).toBe("m1099");
    expect(store.getState().rows.map((r) => r.anchor.id)).toEqual([
      "m1099",
      "m1100",
      "m1101",
    ]);
    expect(reveal).not.toHaveBeenCalled();
    expect(pos(store)[2]).toBeNull(); // mid-universe: N unknown

    store.next();
    expect(activeId()).toBe("m1100");
  });

  it("keeps the wrapped last hit when a small live sample grows inside one survey page", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, i));
    const { surface, reveal } = makeSurface("messages", all, {
      incomplete: true,
    });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m7"
    );
    reveal.mockClear();
    all.push(row("m8", 1, 8));
    store.invalidate("messages");
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m7"
    );
    expect(pos(store)[2]).toBe(7);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("stays on the last hit through wrap when a live sample reseals under new ids", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, i));
    const { surface } = makeSurface("messages", all, { incomplete: true });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    all.length = 0;
    for (let i = 0; i < 9; i++) all.push(row(`n${i}`, 1, i));
    store.invalidate("messages");
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).not.toBe(
      "n0"
    );
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "n8"
    );
    expect(pos(store)[2]).not.toBe(0);
  });

  it("wrap under gte then grow does not report ordinal 0 when wrap rows all had index 0", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, 0));
    const { surface } = makeSurface("messages", all, { incomplete: true });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    all.length = 0;
    for (let i = 0; i < 9; i++) all.push(row(`n${i}`, 1, i));
    store.invalidate("messages");
    await flush();
    expect(pos(store)[2]).not.toBe(0);
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).not.toBe(
      "n0"
    );
  });

  it("keeps an end-wrap pin across surface re-register", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, i));
    const first = makeSurface("messages", all, { incomplete: true });
    const unreg = store.registerSurface(first.surface);
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m7"
    );
    all.push(row("m8", 1, 8));
    unreg();
    store.registerSurface(
      makeSurface("messages", all, { incomplete: true }).surface
    );
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m8"
    );
    expect(pos(store)).toEqual([8, 0, 8, 9]);
  });

  it("clears the end pin when the user steps forward after wrap", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, i));
    const { surface } = makeSurface("messages", all, { incomplete: true });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    store.next();
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m0"
    );
    all.push(row("m8", 1, 8));
    store.invalidate("messages");
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m0"
    );
  });

  it("does not keep the end pin when a different scope registers", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 8 }, (_, i) => row(`m${i}`, 1, i));
    const unreg = store.registerSurface(
      makeSurface("messages", all, { incomplete: true }).surface
    );
    store.setTerm("x");
    await flush();
    store.previous();
    await flush();
    unreg();
    store.registerSurface(
      makeSurface("other", all, { incomplete: true }).surface
    );
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
      "m0"
    );
  });

  it("re-surveys from the top while the active row is inside the first page, so N stays known", async () => {
    const store = new FindStore();
    const all = Array.from({ length: 5 }, (_, i) => row(`m${i}`, 1, i));
    const { surface, calls } = makeSurface("messages", all);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    store.invalidate("messages");
    await flush();
    expect(calls[1]).toEqual({ direction: "forward", limit: 1000 });
    expect(pos(store)).toEqual([2, 0, 2, 5]);
  });

  it("relocates to the nearest row by index when the active row no longer matches", async () => {
    const store = new FindStore();
    const all = [row("a", 1, 2), row("b", 1, 7), row("c", 1, 12)];
    const { surface, reveal } = makeSurface("messages", all);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    expect(pos(store)[0]).toBe(1);
    reveal.mockClear();

    all.splice(1, 1, row("d", 1, 9));
    store.invalidate("messages");
    await flush();
    expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe("d");
    expect(reveal).toHaveBeenCalledWith(
      row("d", 1, 9),
      expect.any(AbortSignal)
    );
  });

  it("keeps steps pending behind a page fetch that an invalidate aborts, applying them once the active row is relocated", async () => {
    const store = new FindStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const all = Array.from({ length: 6 }, (_, i) => row(`m${i}`));
    const { surface } = makeSurface("messages", all, {
      pageSize: 3,
      gate,
      gateLimit: FIND_STEP_LIMIT,
    });
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.next();
    store.next();
    store.next(); // extend (held)
    store.invalidate("messages");
    release();
    await flush();
    expect(store.getState().rows).toHaveLength(6);
    expect(pos(store)).toEqual([3, 0, 3, 6]);
  });

  it("keeps the current window on screen while an invalidate survey runs and applies steps taken meanwhile", async () => {
    const store = new FindStore();
    const { surface } = makeSurface("messages", [row("a"), row("b")]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = makeSurface("messages", [row("a"), row("b"), row("c")], {
      gate,
    });
    store.updateSource("messages", slow.surface.source);
    expect(store.getState().rows).toHaveLength(2);
    store.next(); // queued: the survey owns the state
    expect(pos(store)).toEqual([0, 0, 0, 2]);
    release();
    await flush();
    expect(store.getState().rows).toHaveLength(3);
    expect(pos(store)).toEqual([1, 0, 1, 3]);
  });

  it("clears state on close and empty term", async () => {
    const store = new FindStore();
    const { surface } = makeSurface("messages", [row("a")]);
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    store.attachRow("a");
    store.reportRowCount("a", 2);
    store.next();
    expect(pos(store)).toEqual([0, 1, 0, 1]);

    store.close();
    expect(store.getState()).toMatchObject({
      term: "",
      rows: [],
      activeRow: null,
      total: null,
      scopeId: "messages",
    });

    store.setTerm("x");
    await flush();
    expect(pos(store)).toEqual([0, 0, 0, 1]);
    store.setTerm("");
    expect(store.getState().rows).toEqual([]);
  });

  it("holds one surface: a new registration replaces it, and only the current one unregisters", async () => {
    const store = new FindStore();
    const first = makeSurface("transcript", [row("a")]);
    const second = makeSurface("messages", [row("b")]);
    const unregisterFirst = store.registerSurface(first.surface);
    store.setTerm("x");
    await flush();
    expect(store.getState().scopeId).toBe("transcript");

    store.registerSurface(second.surface);
    await flush();
    expect(store.getState().scopeId).toBe("messages");
    expect(store.getState().rows).toEqual([row("b")]);

    unregisterFirst();
    expect(store.getState().scopeId).toBe("messages");
    expect(store.getState().term).toBe("x");
  });

  it("ends a query whose source throws with no total and nothing in flight", async () => {
    const store = new FindStore();
    const surface: FindSurface = {
      scopeId: "messages",
      source: {
        find: () => Promise.reject(new Error("boom")),
      },
      reveal: () => {},
    };
    store.registerSurface(surface);
    store.setTerm("x");
    await flush();
    expect(store.getState().total).toBeNull();
    expect(store.getState().noResults).toBe(false);

    const good = makeSurface("messages", [row("a")]);
    store.updateSource("messages", good.surface.source);
    await flush();
    expect(pos(store)).toEqual([0, 0, 0, 1]);
  });

  describe("steps taken while a page is in flight", () => {
    it("an opposite step cancels the one that started the extend; the page still commits", async () => {
      const store = new FindStore();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const all = Array.from({ length: 6 }, (_, i) => row(`m${i}`));
      const { surface, calls } = makeSurface("messages", all, {
        pageSize: 3,
        gate,
        gateLimit: FIND_STEP_LIMIT,
      });
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      store.next();
      store.next();
      store.next(); // past the window: extend (held)
      store.previous();
      expect(pos(store)[0]).toBe(2);

      release();
      await flush();
      expect(calls.filter((c) => c.limit === FIND_STEP_LIMIT)).toHaveLength(1);
      expect(store.getState().rows).toHaveLength(6);
      expect(pos(store)).toEqual([2, 0, 2, 6]);
    });

    it("an opposite step during a re-window keeps the current window and position", async () => {
      const store = new FindStore();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const all = Array.from({ length: 3 }, (_, i) => row(`m${i}`));
      const { surface, calls } = makeSurface("messages", all, {
        pageSize: 2,
        gate,
        gateLimit: FIND_STEP_LIMIT,
      });
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      store.previous(); // wrap backward: re-window from the end (held)
      store.next();
      release();
      await flush();
      expect(calls.filter((c) => c.limit === FIND_STEP_LIMIT)).toHaveLength(1);
      expect(store.getState().rows.map((r) => r.anchor.id)).toEqual([
        "m0",
        "m1",
      ]);
      expect(pos(store)).toEqual([0, 0, 0, 3]);
    });

    it("steps on through a wrap when Enter is mashed during the re-window", async () => {
      const store = new FindStore();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const all = Array.from({ length: 3 }, (_, i) => row(`m${i}`));
      const { surface, calls } = makeSurface("messages", all, {
        pageSize: 2,
        gate,
        gateAfter: 1,
        gateLimit: FIND_STEP_LIMIT,
      });
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      store.previous(); // wrap backward: a suffix window [m1, m2] at m2
      await flush();
      expect(store.getState().rows.map((r) => r.anchor.id)).toEqual([
        "m1",
        "m2",
      ]);
      store.next(); // wrap forward: re-window from the start (held)
      store.next();
      store.next();
      release();
      await flush();
      expect(calls.map((c) => [c.direction, c.cursor?.anchor.id])).toEqual([
        ["forward", undefined],
        ["forward", "m1"],
        ["backward", undefined],
        ["forward", undefined],
        ["forward", "m1"],
      ]);
      expect(store.getState().rows[pos(store)[0] as number]?.anchor.id).toBe(
        "m2"
      );
    });
  });

  describe("DOM counts", () => {
    it("forgets a row's count when its highlight detaches", async () => {
      const store = new FindStore();
      const { surface } = makeSurface("messages", [
        row("a"),
        row("b", 2),
        row("c"),
      ]);
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      const detach = store.attachRow("b");
      store.reportRowCount("b", 0);
      store.next();
      expect(pos(store)[0]).toBe(2);
      detach();
      store.previous();
      expect(pos(store)).toEqual([1, 1, 2, 4]);
    });

    it("clamps the active occurrence to the source count when the row detaches with extra DOM matches", async () => {
      const store = new FindStore();
      const { surface } = makeSurface("messages", [row("a", 2), row("b")]);
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      const detach = store.attachRow("a");
      store.reportRowCount("a", 5);
      store.next();
      store.next();
      store.next();
      store.next();
      expect(pos(store)).toEqual([0, 4, 1, 3]);
      detach();
      expect(pos(store)).toEqual([0, 1, 1, 3]);
      store.previous();
      expect(pos(store)).toEqual([0, 0, 0, 3]);
    });

    it("forgets a row's count while its markdown is pending, stepping by the source count meanwhile", async () => {
      const store = new FindStore();
      const { surface } = makeSurface("messages", [row("a", 3), row("b")]);
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      store.attachRow("a");
      store.reportRowCount("a", 1);
      store.reportRowCount("a", null);
      store.next();
      expect(pos(store)).toEqual([0, 1, 1, 4]);
      store.reportRowCount("a", 1);
      expect(pos(store)).toEqual([0, 0, 0, 4]);
    });
  });

  describe("invalidate", () => {
    it("a failed page leaves an empty, coherent state and drops queued steps", async () => {
      const store = new FindStore();
      let fail = false;
      const calls: FindOptions[] = [];
      const surface: FindSurface = {
        scopeId: "messages",
        source: {
          find(_query, opts) {
            calls.push(opts);
            if (fail) return Promise.reject(new Error("boom"));
            return Promise.resolve({
              rows: [row("a"), row("b")],
              complete: true,
              total: { rows: 2, occurrences: 2, relation: "eq" },
            });
          },
        },
        reveal: () => {},
      };
      store.registerSurface(surface);
      store.setTerm("x");
      await flush();
      fail = true;
      store.invalidate("messages");
      store.next();
      await flush();
      const idle = {
        rows: [],
        activeRow: null,
        activeOrdinal: null,
        total: null,
        noResults: false,
      };
      expect(store.getState()).toMatchObject(idle);
      store.attachRow("a");
      store.reportRowCount("a", 1);
      await flush();
      expect(calls).toHaveLength(2);
      expect(store.getState()).toMatchObject(idle);
    });
  });
});
