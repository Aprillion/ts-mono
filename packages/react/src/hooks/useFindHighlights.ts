import { RefObject, useId, useLayoutEffect, useRef } from "react";

import {
  useVirtualScroller,
  type VirtualScroller,
} from "../virtual/VirtualScrollerContext";

import {
  useFindCoordinatorOptional,
  useFindState,
} from "../find/FindCoordinatorContext";
import {
  clearHighlightContribution,
  flashElement,
  setHighlightContribution,
  supportsCustomHighlights,
} from "../find/highlightRegistry";
import { findScrollableParent, scrollRangeToCenter } from "../find/rangeScroll";

// Per-row cap on painted ranges (matches beyond it still count). A guess,
// not calibrated; bounds Range churn on megabyte tool outputs.
const ROW_HIGHLIGHT_CAP = 1000;

/** Marks row chrome the source's text leaves out (chips, timestamps,
 *  metadata, indicators). Distinct from `data-unsearchable`, which the legacy
 *  window.find path also honours — this one must not change what that path
 *  finds. */
const FIND_CHROME_ATTR = "data-find-chrome";
const SKIPPED_SUBTREES = `[data-unsearchable], [${FIND_CHROME_ATTR}]`;
const MARKDOWN_PENDING = "[data-markdown-pending]";

interface TextSegment {
  node: Node;
  start: number;
}

/**
 * Per-row highlighting over the CSS Custom Highlight API: every DOM
 * occurrence of the texts the source matched in this row, plus the active one
 * when this row is active. While mounted the row is attached to the
 * coordinator and reports its DOM match count once its markdown has
 * rendered; that count drives stepping inside it. A row that renders none of
 * its matches flashes instead (a jump is never silent), as does every row
 * where the API is missing. The active occurrence is centred once per
 * activation, once its range has a box: inside a VirtualList through the
 * virtualizer, re-run after the list measures the row.
 */
export function useFindHighlights(
  ref: RefObject<Element | null>,
  anchorId: string | null | undefined
): void {
  const { rows, activeRow, activeOccurrence } = useFindState();
  const coordinator = useFindCoordinatorOptional();
  const scroller = useVirtualScroller();
  const row =
    anchorId === null || anchorId === undefined
      ? undefined
      : rows.find((r) => r.anchor.id === anchorId);
  // The active occurrence within THIS row, or null when the active row is
  // elsewhere. Keyed so the effect re-runs (and re-flashes) per step.
  const active =
    row && activeRow !== null && rows[activeRow] === row
      ? activeOccurrence
      : null;
  // One key per distinct text set (length-prefixed, so any character may
  // appear in a text), so the effect re-runs only when this row's texts
  // change — not per window growth elsewhere or per re-survey.
  const variantsKey = row ? encodeTexts([...new Set(row.texts)]) : "";
  const inWindow = row !== undefined;
  const contributionId = useId();
  // A row that mounts already active was jumped to by the list, which can
  // only aim at the row: its occurrence is centred even if the row's
  // position happened to leave it in view — once the list has measured the
  // band it mounted, since until then rows sit at estimated sizes and a
  // target computed against them is moved by the correction. A step onto a
  // mounted row's occurrence scrolls only when it is out of view. Refs, not
  // effect locals: the effect re-runs freely before the measurement lands.
  const jumpedTo = useRef<boolean | null>(null);
  const measured = useRef(false);

  useLayoutEffect(() => {
    if (!coordinator || anchorId === null || anchorId === undefined) return;
    return coordinator.attachRow(anchorId);
  }, [coordinator, anchorId]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (root && jumpedTo.current === null) jumpedTo.current = active !== null;
    if (!root || anchorId === null || anchorId === undefined || !inWindow) {
      clearHighlightContribution(contributionId);
      return;
    }
    const pattern = variantsKey
      ? variantsPattern(decodeTexts(variantsKey))
      : null;

    let flashed = false;
    let scrolled = false;
    let markdownWasPending = false;
    if (!scroller) measured.current = true;
    const apply = () => {
      // Text still to be replaced by rendered markdown would be announced at
      // the wrong place with the wrong count; announce again once it renders.
      const markdownPending = root.querySelector(MARKDOWN_PENDING) !== null;
      if (markdownPending) markdownWasPending = true;
      else if (markdownWasPending) {
        markdownWasPending = false;
        flashed = false;
        scrolled = false;
      }
      const { ranges, activeRange, count } = computeRowRanges(
        root,
        pattern,
        active
      );
      coordinator?.reportRowCount(anchorId, markdownPending ? null : count);
      const settled = active !== null && !markdownPending;
      if (!supportsCustomHighlights()) {
        if (settled && !flashed) {
          flashed = true;
          flashElement(root);
        }
        return;
      }
      if (settled) {
        if (activeRange !== null) {
          const force = jumpedTo.current === true;
          if (!scrolled && (measured.current || !force)) {
            openEnclosingDetails(activeRange, root);
            scrolled = revealRange(activeRange, root, scroller, force);
            if (scrolled) jumpedTo.current = false;
          }
        } else if (!flashed) {
          flashed = true;
          flashElement(root);
        }
      }
      setHighlightContribution(contributionId, ranges, activeRange);
    };
    apply();

    const unsubscribeMeasure = scroller?.onRowMeasured((node) => {
      if (!node.contains(root)) return;
      measured.current = true;
      apply();
    });
    const observer = new MutationObserver(apply);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-markdown-pending"],
    });
    return () => {
      observer.disconnect();
      unsubscribeMeasure?.();
      clearHighlightContribution(contributionId);
    };
  }, [
    ref,
    anchorId,
    inWindow,
    variantsKey,
    active,
    scroller,
    coordinator,
    contributionId,
  ]);
}

const encodeTexts = (texts: string[]): string =>
  texts.map((text) => `${text.length}:${text}`).join("");

const decodeTexts = (key: string): string[] => {
  const texts: string[] = [];
  for (let at = 0; at < key.length;) {
    const colon = key.indexOf(":", at);
    const length = Number(key.slice(at, colon));
    texts.push(key.slice(colon + 1, colon + 1 + length));
    at = colon + 1 + length;
  }
  return texts;
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Alternation of the matched texts, longest first so a variant that is a
 *  prefix of another cannot shadow it. Exact code points, no folding: the
 *  source already chose the substrings. */
export function variantsPattern(texts: string[]): RegExp {
  const sorted = [...texts].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.map(escapeRegExp).join("|"), "gu");
}

interface RowRanges {
  /** Painted occurrences, capped at ROW_HIGHLIGHT_CAP. */
  ranges: Range[];
  /** The requested occurrence, uncapped; null when the row renders fewer. */
  activeRange: Range | null;
  /** All DOM occurrences, uncapped. */
  count: number;
}

/** The row's text nodes outside skipped subtrees, in document order, each
 *  with its offset into their plain concatenation. */
function collectRowSegments(root: Element): {
  segments: TextSegment[];
  text: string;
} {
  const segments: TextSegment[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIPPED_SUBTREES)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node; (node = walker.nextNode());) {
    segments.push({ node, start: text.length });
    text += node.nodeValue ?? "";
  }
  return { segments, text };
}

/** Occurrences of the pattern in the row's rendered text as DOM Ranges (may
 *  span element boundaries). */
function computeRowRanges(
  root: Element,
  pattern: RegExp | null,
  activeOccurrence: number | null
): RowRanges {
  const { segments, text } = collectRowSegments(root);
  if (!pattern || segments.length === 0) {
    return { ranges: [], activeRange: null, count: 0 };
  }
  const toRange = (start: number, end: number): Range => {
    const range = document.createRange();
    const startSeg = segmentAt(segments, start);
    range.setStart(startSeg.node, start - startSeg.start);
    // end is exclusive: locate the segment containing the last character.
    const endSeg = segmentAt(segments, end - 1);
    range.setEnd(endSeg.node, end - endSeg.start);
    return range;
  };
  const ranges: Range[] = [];
  let activeRange: Range | null = null;
  let count = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    const end = start + found[0].length;
    if (count < ROW_HIGHLIGHT_CAP) ranges.push(toRange(start, end));
    if (count === activeOccurrence) {
      activeRange = ranges[count] ?? toRange(start, end);
    }
    count++;
  }
  return { ranges, activeRange, count };
}

/** A closed `<details>` lays out none of its content, so a match inside one
 *  has no box to centre (and would neither scroll nor flash): open every
 *  closed one between the range and the row. */
function openEnclosingDetails(range: Range, root: Element): void {
  for (
    let el = range.startContainer.parentElement;
    el && el !== root;
    el = el.parentElement
  ) {
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  }
}

/** Whether a range's box is wholly inside `viewport` and not covered by
 *  something outside its row (a sticky header or tab bar inside the scroller
 *  hides a match that is geometrically within the viewport). */
function isRangeVisible(
  rect: DOMRect,
  viewport: DOMRect,
  root: Element
): boolean {
  if (rect.top < viewport.top || rect.bottom > viewport.bottom) return false;
  const hitsRow = (y: number) => {
    const hit = document.elementFromPoint(rect.left + 1, y);
    return hit !== null && root.contains(hit);
  };
  return hitsRow(rect.top + 1) && hitsRow(rect.bottom - 1);
}

/** Centre the range when it is out of view (or unconditionally with
 *  `force`); false when it has no box yet (unmeasured or not laid out), so
 *  the caller retries on the next change. */
function revealRange(
  range: Range,
  root: Element,
  scroller: VirtualScroller | null,
  force: boolean
): boolean {
  const rect = range.getClientRects()[0];
  if (rect === undefined) return false;
  if (scroller) {
    const viewport = scroller.viewportRect();
    if (force || !isRangeVisible(rect, viewport, root)) {
      scroller.scrollToContentOffset(
        scroller.contentOffsetOf(rect.top) - (viewport.height - rect.height) / 2
      );
    }
    return true;
  }
  const parent = findScrollableParent(range.startContainer.parentElement);
  const viewport = parent
    ? parent.getBoundingClientRect()
    : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  if (force || !isRangeVisible(rect, viewport, root))
    scrollRangeToCenter(range);
  return true;
}

function segmentAt(segments: TextSegment[], pos: number): TextSegment {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo]!;
}
