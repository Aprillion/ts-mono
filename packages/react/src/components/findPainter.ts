import type { FindLanding } from "./ExtendedFindContext";
import { findScrollableParent } from "./findBandDom";
import { foldText } from "./findFold";

export interface FindPainter {
  paint(landing: FindLanding, term: string): void;
  clear(): void;
}

const kMatchHighlight = "find-match";
const kActiveHighlight = "find-active";
const kUserInputEvents = [
  "wheel",
  "pointerdown",
  "keydown",
  "touchmove",
] as const;

/**
 * Paints the term in every mounted row with the CSS Custom Highlight API and
 * centres the landed row's active occurrence, again after each mutation of
 * the rows until the user scrolls (design/find.md steps 7-10). The registry
 * is document-global: two Highlights, created once, only ever gain and lose
 * ranges.
 */
export const createFindPainter = (): FindPainter => {
  const supported =
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS;
  const matches = supported ? new Highlight() : null;
  const active = supported ? new Highlight() : null;
  if (matches && active) {
    active.priority = 1;
    CSS.highlights.set(kMatchHighlight, matches);
    CSS.highlights.set(kActiveHighlight, active);
  }

  let landing: FindLanding | null = null;
  // The virtualizer's row container: its children are the mounted rows.
  let rows: HTMLElement | null = null;
  let foldedTerm = "";
  let activeRange: Range | null = null;
  let userScrolled = false;
  let scroller: HTMLElement | null = null;
  const observer = new MutationObserver(() => {
    rebuild();
    centreIfOffScreen();
  });
  const observe = (next: HTMLElement | null) => {
    observer.disconnect();
    rows = next;
    if (rows) {
      observer.observe(rows, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  };
  const onUserInput = () => {
    userScrolled = true;
  };

  const listen = (next: HTMLElement | null) => {
    if (scroller === next) return;
    for (const type of kUserInputEvents) {
      scroller?.removeEventListener(type, onUserInput);
      next?.addEventListener(type, onUserInput, { passive: true });
    }
    scroller = next;
  };

  const rebuild = () => {
    matches?.clear();
    active?.clear();
    activeRange = null;
    if (!landing || !rows) return;
    const landed = landing.element();
    for (const row of rows.children) {
      const ranges = matchRanges(row, foldedTerm);
      for (const range of ranges) matches?.add(range);
      if (row === landed) activeRange = ranges[landing.occurrence] ?? null;
    }
    if (activeRange) active?.add(activeRange);
  };

  const centreIfOffScreen = () => {
    if (!landing || !activeRange || userScrolled) return;
    // A scroller not yet overflowing at paint time resolved to null.
    if (!scroller) listen(findScrollableParent(landing.element()));
    if (!scroller) return;
    const rect = activeRange.getBoundingClientRect();
    if (rect.height === 0) return;
    const view = scroller.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    landing.scrollBy(rect.top + rect.height / 2 - (view.top + view.height / 2));
  };

  return {
    paint(next, term) {
      landing = next;
      foldedTerm = foldText(term);
      userScrolled = false;
      const element = next.element();
      // An unmounted row keeps the container that will repaint it on mount.
      if (element) {
        observe(element.parentElement);
        listen(findScrollableParent(element));
      }
      rebuild();
      centreIfOffScreen();
    },
    clear() {
      landing = null;
      observe(null);
      listen(null);
      rebuild();
    },
  };
};

/** Ranges of `term` in the folded text of `root`; text nodes are joined into
 *  one stream, so a match may span elements. */
export const matchRanges = (root: Node, term: string): Range[] => {
  const foldedTerm = foldText(term);
  if (foldedTerm.length === 0) return [];
  const nodes: FoldedNode[] = [];
  let stream = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-unsearchable]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const folded = foldTextNode(node, stream.length);
    nodes.push(folded);
    stream += folded.text;
  }

  const ranges: Range[] = [];
  let nodeIndex = 0;
  for (
    let at = stream.indexOf(foldedTerm);
    at !== -1;
    at = stream.indexOf(foldedTerm, at + foldedTerm.length)
  ) {
    while ((nodes[nodeIndex + 1]?.start ?? Infinity) <= at) nodeIndex++;
    const startNode = nodes[nodeIndex];
    let endIndex = nodeIndex;
    const end = at + foldedTerm.length;
    while ((nodes[endIndex + 1]?.start ?? Infinity) < end) endIndex++;
    const endNode = nodes[endIndex];
    if (!startNode || !endNode) break;
    const range = document.createRange();
    range.setStart(startNode.node, startNode.toRaw(at - startNode.start));
    range.setEnd(endNode.node, endNode.toRawEnd(end - endNode.start));
    ranges.push(range);
  }
  return ranges;
};

interface FoldedNode {
  node: Text;
  /** Stream offset of the node's folded text. */
  start: number;
  text: string;
  /** Folded offset in the node to the raw code-unit offset a range starts at. */
  toRaw: (folded: number) => number;
  /** Folded offset to the raw offset a range ends at. */
  toRawEnd: (folded: number) => number;
}

// The fold changes lengths outside ASCII (İ → i, ﬁ → fi). A term covering only
// part of a code point's expansion (searching "f" over "ﬁ") rounds outwards to
// the whole code point, so the range is never empty.
const foldTextNode = (node: Text, start: number): FoldedNode => {
  const raw = node.data;
  const text = foldText(raw);
  if (!/[\u0080-\uffff]/.test(raw)) {
    const identity = (folded: number) => folded;
    return { node, start, text, toRaw: identity, toRawEnd: identity };
  }
  const starts: number[] = [];
  const ends: number[] = [];
  let rawIndex = 0;
  for (const char of raw) {
    for (let i = 0; i < foldText(char).length; i++) {
      starts.push(rawIndex);
      ends.push(rawIndex + char.length);
    }
    rawIndex += char.length;
  }
  starts.push(raw.length);
  return {
    node,
    start,
    text,
    toRaw: (folded) => starts[folded] ?? raw.length,
    // The later of: where the next folded unit starts (so combining marks,
    // which fold to nothing, stay inside the range) and the end of the code
    // point holding the previous unit (so a partial expansion rounds out).
    toRawEnd: (folded) =>
      Math.max(
        starts[folded] ?? raw.length,
        folded === 0 ? 0 : (ends[folded - 1] ?? 0)
      ),
  };
};
