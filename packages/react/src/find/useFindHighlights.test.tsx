// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { FC, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VirtualScrollerContext,
  type VirtualScroller,
} from "../virtual/VirtualScrollerContext";

import {
  FindProvider,
  useFindCoordinatorOptional,
} from "./FindCoordinatorContext";
import type { FindCoordinator, FindRow, FindSource } from "./types";
import { useFindHighlights } from "./useFindHighlights";

// ---- CSS Custom Highlight API stub (jsdom has neither CSS.highlights nor
// Highlight). Stubbed at the global boundary, per repo testing rules. ----

class HighlightStub {
  ranges: Range[] = [];
  add(range: Range) {
    this.ranges.push(range);
  }
}

let highlightMap: Map<string, HighlightStub>;

function stubHighlightApi() {
  highlightMap = new Map();
  vi.stubGlobal("CSS", { highlights: highlightMap });
  vi.stubGlobal("Highlight", HighlightStub);
}

// jsdom has no layout: Range.getClientRects is missing entirely, and
// elementFromPoint has nothing to hit; by default it reports the row's own
// text (nothing covers the match).
beforeEach(() => {
  Range.prototype.getClientRects = () =>
    Object.assign([] as DOMRect[], { item: () => null });
  document.elementFromPoint = () => screen.queryByTestId("row-e1");
});

// ---- Harness -------------------------------------------------------------

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function occurrencesSource(
  anchorId: string,
  count = 2,
  text = "needle"
): FindSource {
  return rowsSource([
    { anchor: { id: anchorId }, index: 0, count, texts: [text] },
  ]);
}

function rowsSource(rows: FindRow[]): FindSource {
  return {
    find: () =>
      Promise.resolve({
        rows,
        complete: true,
        total: {
          rows: rows.length,
          occurrences: rows.reduce((sum, row) => sum + row.count, 0),
          relation: "eq",
        },
      }),
  };
}

const Row: FC<{ anchorId: string; children: React.ReactNode }> = ({
  anchorId,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useFindHighlights(ref, anchorId);
  return (
    <div data-testid={`row-${anchorId}`} ref={ref}>
      {children}
    </div>
  );
};

function renderRows(children: React.ReactNode) {
  const captured: { coordinator?: FindCoordinator } = {};
  const Probe = () => {
    const coordinator = useFindCoordinatorOptional();
    useEffect(() => {
      captured.coordinator = coordinator ?? undefined;
    }, [coordinator]);
    return null;
  };
  render(
    <FindProvider>
      <Probe />
      {children}
    </FindProvider>
  );
  const coordinator = captured.coordinator;
  if (!coordinator) throw new Error("coordinator not mounted");
  return coordinator;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Offset mapping over split text nodes ---------------------------------

describe("useFindHighlights range mapping", () => {
  beforeEach(stubHighlightApi);

  /** Highlight `html` given the source matched `texts` in the row (source
   *  count `count`); returns the painted ranges, the active range and the
   *  coordinator. */
  async function highlight(html: string, texts: string | string[], count = 1) {
    const coordinator = renderRows(
      <Row anchorId="e1">
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </Row>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: rowsSource([
          {
            anchor: { id: "e1" },
            index: 0,
            count,
            texts: typeof texts === "string" ? [texts] : texts,
          },
        ]),
        reveal: () => {},
      });
      coordinator.setTerm("typed");
    });
    await flush();
    return {
      root: screen.getByTestId("row-e1").firstElementChild!,
      ranges: highlightMap.get("find-match")?.ranges ?? [],
      active: highlightMap.get("find-active")?.ranges[0] ?? null,
      coordinator,
    };
  }

  it("builds ranges that span element boundaries", async () => {
    // "needle" split across an element boundary: "nee" + <b>"dle"</b>
    const { root, ranges } = await highlight("nee<b>dle here</b>", "needle");
    expect(ranges).toHaveLength(1);
    const range = ranges[0]!;
    expect(range.startContainer).toBe(root.firstChild);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(root.querySelector("b")!.firstChild);
    expect(range.endOffset).toBe(3);
    expect(range.toString()).toBe("needle");
  });

  it("scans the plain concatenation of searchable text, skipping the chrome", async () => {
    const { ranges } = await highlight(
      '<span>needle</span><span>nee</span><span data-find-chrome="true">needle</span><span>dle</span>',
      "needle"
    );
    expect(ranges).toHaveLength(2);
    // The second occurrence bridges the skipped chrome, as the projection's
    // "needle" does.
    expect(ranges[1]?.startContainer.textContent).toBe("nee");
    expect(ranges[1]?.endContainer.textContent).toBe("dle");
  });

  it("highlights every DOM occurrence of the texts the source matched, exactly", async () => {
    const { ranges } = await highlight("Needle and NEEDLE and needle", [
      "Needle",
      "needle",
    ]);
    expect(ranges.map((r) => r.toString())).toEqual(["Needle", "needle"]);
  });

  it("matches a quoted text literally, not its bare word", async () => {
    const { ranges } = await highlight('say "hi" and say hi', '"hi"');
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.toString()).toBe('"hi"');
  });

  it("treats regex syntax in a text literally", async () => {
    const { ranges } = await highlight("a.b axb (a.b)", "a.b");
    expect(ranges.map((r) => r.toString())).toEqual(["a.b", "a.b"]);
  });

  it("highlights the variants a folding source returns where the DOM text differs from the typed term", async () => {
    // Typed "istanbul" / "strasse" / "cafe": the source matched these forms.
    const { ranges } = await highlight(
      "İstanbul istanbul ISTANBUL; straße strasse; café cafe",
      ["İstanbul", "istanbul", "ISTANBUL", "straße", "strasse", "café", "cafe"]
    );
    expect(ranges.map((r) => r.toString())).toEqual([
      "İstanbul",
      "istanbul",
      "ISTANBUL",
      "straße",
      "strasse",
      "café",
      "cafe",
    ]);
  });

  it("keeps a variant containing NUL intact", async () => {
    // As a text node: the HTML parser would replace NUL.
    const coordinator = renderRows(<Row anchorId="e1">{"a\0b a b"}</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: rowsSource([
          {
            anchor: { id: "e1" },
            index: 0,
            count: 1,
            texts: ["a\0b"],
          },
        ]),
        reveal: () => {},
      });
      coordinator.setTerm("typed");
    });
    await flush();
    const ranges = highlightMap.get("find-match")?.ranges ?? [];
    expect(ranges.map((r) => r.toString())).toEqual(["a\0b"]);
  });

  it("prefers the longest variant where one is a prefix of another", async () => {
    // Decomposed é: "e" + combining acute.
    const { ranges } = await highlight("e\u0301", ["e", "e\u0301"]);
    expect(ranges.map((r) => r.toString())).toEqual(["e\u0301"]);
  });

  it("paints up to the cap but steps through every DOM match; N stops at the source count", async () => {
    const { ranges, coordinator } = await highlight(
      "needle ".repeat(1001),
      "needle",
      3
    );
    expect(ranges).toHaveLength(1000);
    // The source counted 3; the DOM has 1001, so a fourth step stays in the
    // row (a source-count step would have wrapped) while N stops at 3.
    for (let i = 0; i < 3; i++) act(() => coordinator.next());
    await flush();
    expect(coordinator.getState()).toMatchObject({
      activeOccurrence: 3,
      activeOrdinal: 2,
    });
    expect(highlightMap.get("find-active")?.ranges[0]?.startOffset).toBe(
      3 * "needle ".length
    );
  });

  it("steps through the DOM matches, not the source estimate", async () => {
    const { ranges, coordinator } = await highlight(
      "needle and Needle",
      ["needle", "Needle"],
      5
    );
    expect(ranges).toHaveLength(2);
    act(() => coordinator.next());
    expect(coordinator.getState()).toMatchObject({
      activeOccurrence: 1,
      activeOrdinal: 1,
    });
    act(() => coordinator.next()); // past the two DOM matches: wraps
    expect(coordinator.getState()).toMatchObject({
      activeOccurrence: 0,
      activeOrdinal: 0,
    });
  });
});

// ---- The hook: registry contributions + flash fallback ---------------------

describe("useFindHighlights", () => {
  it("registers match ranges and the active occurrence with the registry", async () => {
    stubHighlightApi();
    const coordinator = renderRows(
      <Row anchorId="e1">needle one needle two</Row>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1"),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();

    const matchHighlight = highlightMap.get("find-match");
    expect(matchHighlight?.ranges).toHaveLength(2);
    const activeHighlight = highlightMap.get("find-active");
    expect(activeHighlight?.ranges).toHaveLength(1);
    // Survey activated occurrence 0 — the first rendered occurrence.
    expect(activeHighlight?.ranges[0]?.toString()).toBe("needle");
    expect(activeHighlight?.ranges[0]?.startOffset).toBe(0);
  });

  it("moves the active highlight when stepping", async () => {
    stubHighlightApi();
    const coordinator = renderRows(<Row anchorId="e1">needle x needle</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1"),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();

    act(() => coordinator.next());
    await flush();

    const activeHighlight = highlightMap.get("find-active");
    expect(activeHighlight?.ranges).toHaveLength(1);
    expect(activeHighlight?.ranges[0]?.startOffset).toBe(9);
  });

  it("centres the active occurrence through the enclosing virtual scroller, once", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 5000, 10, 10)], { item: () => null });
    const scrollToContentOffset = vi.fn();
    const scroller: VirtualScroller = {
      contentOffsetOf: (clientTop) => clientTop + 1000,
      viewportRect: () => new DOMRect(0, 0, 800, 600),
      scrollToContentOffset,
      onRowMeasured: () => () => {},
    };
    const coordinator = renderRows(
      <VirtualScrollerContext.Provider value={scroller}>
        <Row anchorId="e1">needle</Row>
      </VirtualScrollerContext.Provider>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(highlightMap.get("find-active")?.ranges).toHaveLength(1);
    // Content offset of the range top (6000) less half the free viewport.
    expect(scrollToContentOffset).toHaveBeenCalledTimes(1);
    expect(scrollToContentOffset).toHaveBeenCalledWith(6000 - (600 - 10) / 2);

    // A DOM mutation re-applies the highlights without scrolling again.
    act(() => {
      screen.getByTestId("row-e1").append(document.createTextNode(" needle"));
    });
    await waitFor(() =>
      expect(highlightMap.get("find-match")?.ranges).toHaveLength(2)
    );
    expect(scrollToContentOffset).toHaveBeenCalledTimes(1);
  });

  it("centres once the row has been measured when the range had no box at first", async () => {
    stubHighlightApi();
    let measured = false;
    Range.prototype.getClientRects = () =>
      Object.assign(measured ? [new DOMRect(0, 5000, 10, 10)] : [], {
        item: () => null,
      });
    const scrollToContentOffset = vi.fn();
    const listeners = new Set<(node: Element) => void>();
    const scroller: VirtualScroller = {
      contentOffsetOf: (clientTop) => clientTop + 1000,
      viewportRect: () => new DOMRect(0, 0, 800, 600),
      scrollToContentOffset,
      onRowMeasured: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const coordinator = renderRows(
      <VirtualScrollerContext.Provider value={scroller}>
        <Row anchorId="e1">needle</Row>
      </VirtualScrollerContext.Provider>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(scrollToContentOffset).not.toHaveBeenCalled();

    measured = true;
    act(() => {
      for (const l of listeners) l(screen.getByTestId("row-e1"));
    });
    expect(scrollToContentOffset).toHaveBeenCalledTimes(1);
    act(() => {
      for (const l of listeners) l(screen.getByTestId("row-e1"));
    });
    expect(scrollToContentOffset).toHaveBeenCalledTimes(1);
  });

  it("centres an occurrence whose box straddles the viewport's bottom edge", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 595, 10, 10)], { item: () => null });
    const scrollToContentOffset = vi.fn();
    const scroller: VirtualScroller = {
      contentOffsetOf: (clientTop) => clientTop + 1000,
      viewportRect: () => new DOMRect(0, 0, 800, 600),
      scrollToContentOffset,
      onRowMeasured: () => () => {},
    };
    const coordinator = renderRows(
      <VirtualScrollerContext.Provider value={scroller}>
        <Row anchorId="e1">needle</Row>
      </VirtualScrollerContext.Provider>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(scrollToContentOffset).toHaveBeenCalledWith(1595 - (600 - 10) / 2);
  });

  it("centres an occurrence inside the scroller's box that sits behind a sticky header", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 50, 10, 10)], { item: () => null });
    const header = document.createElement("header");
    document.body.append(header);
    document.elementFromPoint = () => header;
    const scrollToContentOffset = vi.fn();
    const scroller: VirtualScroller = {
      contentOffsetOf: (clientTop) => clientTop + 1000,
      viewportRect: () => new DOMRect(0, 0, 800, 600),
      scrollToContentOffset,
      onRowMeasured: () => () => {},
    };
    const coordinator = renderRows(
      <VirtualScrollerContext.Provider value={scroller}>
        <Row anchorId="e1">needle</Row>
      </VirtualScrollerContext.Provider>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(scrollToContentOffset).toHaveBeenCalledWith(1050 - (600 - 10) / 2);

    // Uncovered and inside the box: nothing to do.
    scrollToContentOffset.mockClear();
    document.elementFromPoint = () => screen.getByTestId("row-e1");
    act(() => coordinator.setTerm(""));
    act(() => coordinator.setTerm("needle"));
    await flush();
    expect(scrollToContentOffset).not.toHaveBeenCalled();
    header.remove();
  });

  it("falls back to DOM scrolling for a row outside a VirtualList", async () => {
    stubHighlightApi();
    // A range below the window's viewport, so the fallback must scroll.
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 5000, 10, 10)], { item: () => null });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const coordinator = renderRows(<Row anchorId="e1">needle</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("centres the occurrence of a row that mounts already active (the list jumped to it), even when the row's position left it in view", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 700, 10, 10)], { item: () => null });
    const scrollToContentOffset = vi.fn();
    const listeners = new Set<(node: Element) => void>();
    const scroller: VirtualScroller = {
      contentOffsetOf: (clientTop) => clientTop + 1000,
      viewportRect: () => new DOMRect(0, 0, 800, 900),
      scrollToContentOffset,
      onRowMeasured: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const captured: { coordinator?: FindCoordinator } = {};
    const Probe = () => {
      const coordinator = useFindCoordinatorOptional();
      useEffect(() => {
        captured.coordinator = coordinator ?? undefined;
      }, [coordinator]);
      return null;
    };
    const ui = (mounted: boolean) => (
      <FindProvider>
        <Probe />
        <VirtualScrollerContext.Provider value={scroller}>
          {mounted ? <Row anchorId="e1">needle</Row> : null}
        </VirtualScrollerContext.Provider>
      </FindProvider>
    );
    const { rerender } = render(ui(false));
    const coordinator = captured.coordinator!;
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(coordinator.getState().activeRow).toBe(0);

    // The virtualizer renders the row once its jump reaches it; the target
    // is taken only after the list measured the band (estimated sizes before
    // that would move it).
    rerender(ui(true));
    expect(scrollToContentOffset).not.toHaveBeenCalled();
    // A re-survey (live poll) re-runs the row's effect meanwhile: still
    // waiting for the measurement, still a jump.
    act(() => {
      coordinator.updateSource(
        "test",
        rowsSource([
          {
            anchor: { id: "e1" },
            index: 0,
            count: 1,
            texts: ["needle", "Needle"],
          },
        ])
      );
    });
    await flush();
    expect(scrollToContentOffset).not.toHaveBeenCalled();
    act(() => {
      for (const l of listeners) l(screen.getByTestId("row-e1"));
    });
    expect(scrollToContentOffset).toHaveBeenCalledTimes(1);
    expect(scrollToContentOffset).toHaveBeenCalledWith(1700 - (900 - 10) / 2);
  });

  it("leaves the scroll alone when the occurrence is already in view", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 100, 10, 10)], { item: () => null });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const coordinator = renderRows(<Row anchorId="e1">needle</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(highlightMap.get("find-active")?.ranges).toHaveLength(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("clears contributions when the term clears", async () => {
    stubHighlightApi();
    const coordinator = renderRows(<Row anchorId="e1">needle</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1"),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    expect(highlightMap.get("find-match")).toBeDefined();

    act(() => coordinator.setTerm(""));
    await flush();
    expect(highlightMap.get("find-match")).toBeUndefined();
    expect(highlightMap.get("find-active")).toBeUndefined();
  });

  it("clears its contributions when the row unmounts", async () => {
    stubHighlightApi();
    const captured: { coordinator?: FindCoordinator } = {};
    const Probe = () => {
      const coordinator = useFindCoordinatorOptional();
      useEffect(() => {
        captured.coordinator = coordinator ?? undefined;
      }, [coordinator]);
      return null;
    };
    const ui = (withRow: boolean) => (
      <FindProvider>
        <Probe />
        {withRow ? <Row anchorId="e1">needle</Row> : null}
      </FindProvider>
    );
    const { rerender } = render(ui(true));
    act(() => {
      captured.coordinator!.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1"),
        reveal: () => {},
      });
      captured.coordinator!.setTerm("needle");
    });
    await flush();
    expect(highlightMap.get("find-match")).toBeDefined();

    rerender(ui(false));
    expect(highlightMap.get("find-match")).toBeUndefined();
    expect(highlightMap.get("find-active")).toBeUndefined();
  });

  it("flashes the row instead when Custom Highlights are unsupported", async () => {
    // No stub: CSS.highlights and Highlight are absent in jsdom.
    const coordinator = renderRows(<Row anchorId="e1">needle</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1"),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();

    const row = document.querySelector('[data-testid="row-e1"]');
    expect(row?.classList.contains("find-flash")).toBe(true);
  });

  it("announces again when the row becomes the active anchor again", async () => {
    // No Custom Highlights: the announcement is the flash class.
    const source = rowsSource([
      {
        anchor: { id: "e1" },
        index: 0,
        count: 1,
        texts: ["needle"],
      },
      {
        anchor: { id: "e2" },
        index: 0,
        count: 1,
        texts: ["needle"],
      },
    ]);
    const coordinator = renderRows(
      <>
        <Row anchorId="e1">needle</Row>
        <Row anchorId="e2">needle</Row>
      </>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source,
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    const row1 = screen.getByTestId("row-e1");
    expect(row1.classList.contains("find-flash")).toBe(true);
    act(() => {
      row1.dispatchEvent(new Event("animationend"));
    });
    expect(row1.classList.contains("find-flash")).toBe(false);

    act(() => coordinator.next());
    await flush();
    expect(screen.getByTestId("row-e2").classList.contains("find-flash")).toBe(
      true
    );
    expect(row1.classList.contains("find-flash")).toBe(false);

    act(() => coordinator.next()); // wraps back to e1
    await flush();
    expect(row1.classList.contains("find-flash")).toBe(true);
  });

  it("scrolls a range that renders later, once", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 5000, 10, 10)], { item: () => null });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // The projection has one occurrence; the row renders it only later
    // (async markdown / Prism churn).
    const coordinator = renderRows(<Row anchorId="e1">pending</Row>);
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    const row = screen.getByTestId("row-e1");
    expect(row.classList.contains("find-flash")).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => {
      row.append(document.createTextNode(" needle"));
    });
    await waitFor(() =>
      expect(highlightMap.get("find-active")?.ranges).toHaveLength(1)
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => {
      row.append(document.createTextNode(" needle"));
    });
    await waitFor(() =>
      expect(highlightMap.get("find-match")?.ranges).toHaveLength(2)
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("waits for a pending markdown render, then announces the rendered text once", async () => {
    stubHighlightApi();
    Range.prototype.getClientRects = () =>
      Object.assign([new DOMRect(0, 5000, 10, 10)], { item: () => null });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const coordinator = renderRows(
      <Row anchorId="e1">
        <span data-markdown-pending="true">needle</span>
      </Row>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    const row = screen.getByTestId("row-e1");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(row.classList.contains("find-flash")).toBe(false);

    act(() => {
      row.querySelector("span")!.removeAttribute("data-markdown-pending");
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    act(() => {
      row.append(document.createTextNode(" needle"));
    });
    await waitFor(() =>
      expect(highlightMap.get("find-match")?.ranges).toHaveLength(2)
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("withdraws its DOM count while markdown is pending, so stepping uses the source count", async () => {
    stubHighlightApi();
    const coordinator = renderRows(
      <Row anchorId="e1">
        <span>needle</span>
      </Row>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 3),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    // One DOM match: Enter wraps within the row.
    act(() => coordinator.next());
    expect(coordinator.getState().activeOccurrence).toBe(0);

    const span = screen.getByTestId("row-e1").querySelector("span")!;
    act(() => span.setAttribute("data-markdown-pending", "true"));
    await flush(); // the observer's microtask has run
    act(() => coordinator.next());
    expect(coordinator.getState().activeOccurrence).toBe(1);

    act(() => span.removeAttribute("data-markdown-pending"));
    await waitFor(() =>
      expect(coordinator.getState().activeOccurrence).toBe(0)
    );
  });

  it("opens a closed <details> holding the active occurrence before centring it", async () => {
    stubHighlightApi();
    // A closed <details> lays out nothing: no box until it is open.
    Range.prototype.getClientRects = function (this: Range) {
      const details = this.startContainer.parentElement?.closest("details");
      const boxed = !details || details.open;
      return Object.assign(boxed ? [new DOMRect(0, 5000, 10, 10)] : [], {
        item: () => null,
      });
    };
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const coordinator = renderRows(
      <Row anchorId="e1">
        <details>
          <summary>tool</summary>
          needle
        </details>
      </Row>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: occurrencesSource("e1", 1),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();
    const details = screen.getByTestId("row-e1").querySelector("details")!;
    expect(details.open).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().activeOrdinal).toBe(0);

    // The user closing it again is respected: no re-open on later mutations.
    act(() => {
      details.open = false;
      details.append(document.createTextNode(" needle"));
    });
    await waitFor(() =>
      expect(highlightMap.get("find-match")?.ranges).toHaveLength(2)
    );
    expect(details.open).toBe(false);
  });

  it("flashes a row that renders none of the source's matches, and stepping moves on", async () => {
    stubHighlightApi();
    // The source matched link URLs the row does not render.
    const coordinator = renderRows(
      <>
        <Row anchorId="e1">nothing rendered</Row>
        <Row anchorId="e2">needle</Row>
      </>
    );
    act(() => {
      coordinator.registerSurface({
        scopeId: "test",
        source: rowsSource([
          {
            anchor: { id: "e1" },
            index: 0,
            count: 2,
            texts: ["needle"],
          },
          {
            anchor: { id: "e2" },
            index: 0,
            count: 1,
            texts: ["needle"],
          },
        ]),
        reveal: () => {},
      });
      coordinator.setTerm("needle");
    });
    await flush();

    const row = screen.getByTestId("row-e1");
    expect(row.classList.contains("find-flash")).toBe(true);
    expect(highlightMap.get("find-active")).toBeUndefined();
    expect(coordinator.getState()).toMatchObject({
      activeRow: 0,
      activeOrdinal: null,
      total: { occurrences: 3 },
    });

    act(() => coordinator.next());
    await flush();
    // N counts the skipped row's source estimate: the total is not rewritten.
    expect(coordinator.getState()).toMatchObject({
      activeRow: 1,
      activeOrdinal: 2,
    });
    expect(highlightMap.get("find-active")?.ranges[0]?.toString()).toBe(
      "needle"
    );
  });
});
