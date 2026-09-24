// @vitest-environment jsdom
import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";

import { scrollVirtualizerBy } from "../scrollVirtualizerBy";

/**
 * A virtual-core instance over a jsdom element whose scroll events never
 * fire: the virtualizer's cached scrollOffset only moves when the test says
 * so, which is the frame between a programmatic write and its scroll event.
 * `scale` mimics use-scaled-virtualizer: content offsets are divided by it
 * before reaching scrollTop.
 */
const mount = (
  rows: number,
  rowHeight: number,
  viewport: number,
  scale = 1
) => {
  const el = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    value: (rows * rowHeight) / scale,
  });
  Object.defineProperty(el, "clientHeight", { value: viewport });
  let onOffset: ((offset: number, isScrolling: boolean) => void) | null = null;
  const virtualizer = new Virtualizer<HTMLElement, Element>({
    count: rows,
    estimateSize: () => rowHeight,
    getScrollElement: () => el,
    scrollToFn: (offset, { adjustments }) => {
      el.scrollTop = (offset + (adjustments ?? 0)) / scale;
    },
    observeElementRect: (_instance, cb) => {
      cb({ width: 800, height: viewport });
    },
    observeElementOffset: (_instance, cb) => {
      onOffset = cb;
      cb(el.scrollTop * scale, false);
    },
  });
  virtualizer._willUpdate();
  virtualizer.getVirtualItems();
  return {
    el,
    virtualizer,
    /** Deliver the scroll event for the current DOM position. */
    settleScrollEvent: () => onOffset?.(el.scrollTop * scale, false),
  };
};

describe("scrollVirtualizerBy", () => {
  it("keeps the write when a row above is re-measured before the scroll event", () => {
    const { el, virtualizer, settleScrollEvent } = mount(100, 400, 900);
    virtualizer.scrollToIndex(30, { align: "center" });
    settleScrollEvent();
    const before = el.scrollTop;

    scrollVirtualizerBy(virtualizer, el, 700, 1);
    expect(el.scrollTop).toBe(before + 700);

    // TanStack compensates a resize above the fold from its cached offset.
    virtualizer.resizeItem(5, 397);

    expect(el.scrollTop).toBe(before + 700 - 3);
  });

  it("moves the DOM by the delta when the list is scaled", () => {
    const { el, virtualizer, settleScrollEvent } = mount(100, 400, 900, 2);
    virtualizer.scrollToIndex(30, { align: "center" });
    settleScrollEvent();
    const before = el.scrollTop;

    scrollVirtualizerBy(virtualizer, el, 700, 2);

    expect(el.scrollTop).toBe(before + 700);
  });

  it("clamps to the scrollable range", () => {
    const { el, virtualizer, settleScrollEvent } = mount(10, 400, 900);
    settleScrollEvent();
    scrollVirtualizerBy(virtualizer, el, 100000, 1);
    expect(el.scrollTop).toBe(10 * 400 - 900);
  });
});
