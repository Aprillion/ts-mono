// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { FindLanding } from "./ExtendedFindContext";
import { createFindPainter, matchRanges } from "./findPainter";

class HighlightStub extends Set<Range> {
  priority = 0;
}

let registry: Map<string, HighlightStub>;

const rangeText = (name: string): string[] =>
  [...(registry.get(name) ?? [])].map((range) => range.toString());

const landingFor = (
  element: HTMLElement,
  occurrence = 0
): FindLanding & { scrollBy: Mock<(deltaPx: number) => void> } => ({
  element: () => element,
  occurrence,
  scrollBy: vi.fn<(deltaPx: number) => void>(),
});

/** A scroller whose client box spans y 0..500; text rects come from `rectTop`. */
const mountScroller = (html: string, rectTop: number) => {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", {
    value: 5000,
    configurable: true,
  });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  scroller.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 500 });
  const row = document.createElement("div");
  row.innerHTML = html;
  scroller.append(row);
  document.body.append(scroller);
  setRangeRect(rectTop);
  return { scroller, row };
};

// jsdom's Range has no layout; give every range one rect at `top`.
const setRangeRect = (top: number) => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => DOMRect.fromRect({ x: 0, y: top, width: 60, height: 20 }),
  });
};

beforeEach(() => {
  registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", HighlightStub);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

describe("matchRanges", () => {
  it("matches across element boundaries and folds case", () => {
    const root = document.createElement("div");
    root.innerHTML = "Foo <strong>Bar</strong> and foo bar";
    expect(matchRanges(root, "foo bar").map(String)).toEqual([
      "Foo Bar",
      "foo bar",
    ]);
  });

  it("matches under the browser fold and maps ranges back to raw offsets", () => {
    const root = document.createElement("div");
    root.innerHTML = "İstanbul, ﬁne café; <b>Istanbul</b> cafe\u0301";
    expect(matchRanges(root, "istanbul").map(String)).toEqual([
      "İstanbul",
      "Istanbul",
    ]);
    expect(matchRanges(root, "cafe").map(String)).toEqual([
      "café",
      "cafe\u0301",
    ]);
    expect(matchRanges(root, "fine").map(String)).toEqual(["ﬁne"]);
    // A term covering part of a ligature paints the whole code point, never
    // an empty range that would consume the active slot and show nothing.
    expect(matchRanges(root, "fi").map(String)).toEqual(["ﬁ"]);
    expect(matchRanges(root, "f").map(String)).toEqual(["ﬁ", "f", "f"]);
    expect(matchRanges(root, "kumquat")).toHaveLength(0);
  });

  it("skips unsearchable subtrees and empty terms", () => {
    const root = document.createElement("div");
    root.innerHTML = 'needle <span data-unsearchable="true">needle</span>';
    expect(matchRanges(root, "needle")).toHaveLength(1);
    expect(matchRanges(root, "")).toHaveLength(0);
  });
});

describe("createFindPainter", () => {
  it("paints one shared highlight per name and marks the active occurrence", () => {
    const { row } = mountScroller("needle <em>needle</em>", 100);
    const painter = createFindPainter();

    painter.paint(landingFor(row, 1), "Needle");

    expect(rangeText("find-match")).toEqual(["needle", "needle"]);
    expect(rangeText("find-active")).toEqual(["needle"]);
    expect([...(registry.get("find-active") ?? [])][0]).toBe(
      [...(registry.get("find-match") ?? [])][1]
    );
    expect(registry.get("find-active")?.priority).toBe(1);

    painter.clear();
    expect(rangeText("find-match")).toEqual([]);
    expect(rangeText("find-active")).toEqual([]);
  });

  it("stops observing the rows and the scroller when cleared", () => {
    const { scroller, row } = mountScroller("needle", 100);
    const removeListener = vi.spyOn(scroller, "removeEventListener");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const painter = createFindPainter();
    painter.paint(landingFor(row), "needle");
    // A leaked observer is invisible in the ranges — clear() drops the landing,
    // so a rebuild it triggers produces the same empty result. Count the
    // disconnect instead.
    const disconnectsBeforeClear = disconnect.mock.calls.length;

    painter.clear();

    expect(disconnect.mock.calls.length).toBe(disconnectsBeforeClear + 1);
    expect(removeListener.mock.calls.map((call) => call[0]).sort()).toEqual([
      "keydown",
      "pointerdown",
      "touchmove",
      "wheel",
    ]);
  });

  it("centres an off-screen active range through scrollBy and leaves a visible one alone", () => {
    const { row } = mountScroller("needle", 1000);
    const painter = createFindPainter();
    const landing = landingFor(row);

    painter.paint(landing, "needle");
    // rect centre 1010 vs scroller centre 250
    expect(landing.scrollBy).toHaveBeenCalledWith(760);

    setRangeRect(100);
    const visible = landingFor(row);
    painter.paint(visible, "needle");
    expect(visible.scrollBy).not.toHaveBeenCalled();
  });

  it("rebuilds ranges after the row's HTML is replaced and re-centres until the user scrolls", async () => {
    const { scroller, row } = mountScroller("needle", 1000);
    const painter = createFindPainter();
    const landing = landingFor(row);
    painter.paint(landing, "needle");
    const before = [...(registry.get("find-active") ?? [])][0];

    row.innerHTML = "<p>needle</p>";
    await Promise.resolve();

    const after = [...(registry.get("find-active") ?? [])][0];
    expect(after).not.toBe(before);
    expect(after?.toString()).toBe("needle");
    expect(landing.scrollBy).toHaveBeenCalledTimes(2);

    scroller.dispatchEvent(new Event("wheel"));
    row.innerHTML = "<p><b>needle</b></p>";
    await Promise.resolve();

    expect(rangeText("find-active")).toEqual(["needle"]);
    expect(landing.scrollBy).toHaveBeenCalledTimes(2);
  });

  it("paints every mounted row, and a row mounted later", async () => {
    const { scroller, row } = mountScroller("needle one", 100);
    const rows = document.createElement("div");
    scroller.append(rows);
    const other = document.createElement("div");
    other.textContent = "needle two";
    rows.append(other, row);
    const painter = createFindPainter();

    painter.paint(landingFor(row), "needle");
    expect(rangeText("find-match")).toEqual(["needle", "needle"]);
    expect([...(registry.get("find-match") ?? [])][0]?.startContainer).toBe(
      other.firstChild
    );
    expect([...(registry.get("find-active") ?? [])][0]?.startContainer).toBe(
      row.firstChild
    );

    const later = document.createElement("div");
    later.textContent = "needle three";
    rows.append(later);
    await Promise.resolve();
    expect(rangeText("find-match")).toEqual(["needle", "needle", "needle"]);
    expect(rangeText("find-active")).toEqual(["needle"]);
  });

  it("paints no active range when the row renders fewer occurrences than asked for", () => {
    const { row } = mountScroller("needle", 100);
    const painter = createFindPainter();

    painter.paint(landingFor(row, 3), "needle");
    expect(rangeText("find-match")).toEqual(["needle"]);
    expect(rangeText("find-active")).toEqual([]);
  });

  it("follows the row to a new element when the list re-renders it", async () => {
    const { scroller, row } = mountScroller("needle", 100);
    const rows = document.createElement("div");
    scroller.append(rows);
    rows.append(row);
    let current: HTMLElement | null = row;
    const painter = createFindPainter();
    painter.paint(
      { element: () => current, occurrence: 0, scrollBy: vi.fn() },
      "needle"
    );
    expect(rangeText("find-active")).toEqual(["needle"]);

    // Scrolled out of the render window: the row unmounts.
    current = null;
    row.remove();
    await Promise.resolve();
    expect(rangeText("find-active")).toEqual([]);

    // Scrolled back: a new element for the same row.
    const again = document.createElement("div");
    again.textContent = "needle";
    current = again;
    rows.append(again);
    await Promise.resolve();
    expect(rangeText("find-active")).toEqual(["needle"]);
    expect([...(registry.get("find-active") ?? [])][0]?.startContainer).toBe(
      again.firstChild
    );

    // The row observer moved with it.
    again.firstChild!.textContent = "moved needle";
    await Promise.resolve();
    expect([...(registry.get("find-active") ?? [])][0]?.startOffset).toBe(6);
  });

  it("keeps observing the rows when the landed row is not mounted", async () => {
    const { scroller, row } = mountScroller("needle", 100);
    const rows = document.createElement("div");
    scroller.append(rows);
    rows.append(row);
    let current: HTMLElement | null = row;
    const painter = createFindPainter();
    const landing = {
      element: () => current,
      occurrence: 0,
      scrollBy: vi.fn(),
    };
    painter.paint(landing, "needle");
    expect(rangeText("find-active")).toEqual(["needle"]);

    // Repainted while the row sits outside the virtualizer's window.
    current = null;
    row.remove();
    painter.paint(landing, "needle");
    expect(rangeText("find-match")).toEqual([]);

    const again = document.createElement("div");
    again.textContent = "needle";
    current = again;
    rows.append(again);
    await Promise.resolve();
    expect(rangeText("find-active")).toEqual(["needle"]);
  });

  it("centres once the scroller starts overflowing", async () => {
    const { scroller, row } = mountScroller("needle", 1000);
    Object.defineProperty(scroller, "scrollHeight", {
      value: 500,
      configurable: true,
    });
    const painter = createFindPainter();
    const landing = landingFor(row);

    painter.paint(landing, "needle");
    expect(landing.scrollBy).not.toHaveBeenCalled();

    Object.defineProperty(scroller, "scrollHeight", {
      value: 5000,
      configurable: true,
    });
    row.append(document.createTextNode(" more"));
    await Promise.resolve();
    expect(landing.scrollBy).toHaveBeenCalledWith(760);
  });

  it("rebuilds ranges after a text node's data changes in place", async () => {
    const { row } = mountScroller("needle here", 100);
    const painter = createFindPainter();
    painter.paint(landingFor(row), "needle");
    const before = [...(registry.get("find-active") ?? [])][0];

    const text = row.firstChild;
    if (!(text instanceof Text)) throw new Error("text node expected");
    text.data = "moved: needle";
    await Promise.resolve();

    const after = [...(registry.get("find-active") ?? [])][0];
    expect(after).not.toBe(before);
    expect(after?.toString()).toBe("needle");
    expect(after?.startOffset).toBe(7);
  });
});
