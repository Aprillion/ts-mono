import type { MatchSelection } from "./transcriptMatches";

const EVENT_ID_ATTR = "data-search-event-id";
const FIELD_KEY_ATTR = "data-search-field-key";
const FIELD_INDEX_ATTR = "data-search-field-index";

/** Identity of a manifest field, as carried by the renderer's annotations. */
export interface FieldIdentity {
  eventId: string;
  fieldKey: string;
  fieldIndex: number;
}

/**
 * Locate the canonical annotated element for a field identity within `root`,
 * matching all three `data-search-*` attributes exactly. Null if none.
 */
export function findFieldElement(
  root: ParentNode,
  { eventId, fieldKey, fieldIndex }: FieldIdentity
): Element | null {
  const selector =
    `[${EVENT_ID_ATTR}="${cssEscape(eventId)}"]` +
    `[${FIELD_KEY_ATTR}="${cssEscape(fieldKey)}"]` +
    `[${FIELD_INDEX_ATTR}="${cssEscape(String(fieldIndex))}"]`;
  return root.querySelector(selector);
}

/**
 * Build a DOM `Range` covering the [start, end) UTF-16 substring of
 * `fieldEl.textContent`, walking its text nodes in order (markdown emits nested
 * spans, so start and end may land in different text nodes). Null if the offsets
 * are out of bounds (negative, start > end, or end past the text length).
 */
export function rangeForOffsets(
  fieldEl: Element,
  start: number,
  end: number
): Range | null {
  if (start < 0 || end < start) return null;

  const doc = fieldEl.ownerDocument;
  const startPos = locateOffset(doc, fieldEl, start);
  const endPos = locateOffset(doc, fieldEl, end);
  if (startPos === null || endPos === null) return null;

  const range = doc.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  return range;
}

/**
 * Recover a field selection from a live `Range`: the nearest ancestor of
 * `range.startContainer` carrying the three `data-search-*` attributes, plus
 * `start`/`end` as UTF-16 offsets of the range within THAT element's
 * textContent. Null if the range is not inside an annotated field (e.g. chrome).
 */
export function fieldSelectionFromRange(range: Range): MatchSelection | null {
  const fieldEl = closestAnnotated(range.startContainer);
  if (!fieldEl) return null;

  const start = offsetWithin(fieldEl, range.startContainer, range.startOffset);
  const end = offsetWithin(fieldEl, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;

  return {
    eventId: fieldEl.getAttribute(EVENT_ID_ATTR)!,
    fieldKey: fieldEl.getAttribute(FIELD_KEY_ATTR)!,
    fieldIndex: Number(fieldEl.getAttribute(FIELD_INDEX_ATTR)),
    start,
    end,
  };
}

interface TextPosition {
  node: Text;
  offset: number;
}

/**
 * Walk `el`'s text nodes accumulating their lengths; return the text node and
 * in-node offset where the global UTF-16 `offset` falls. Boundary offset==length
 * resolves to the end of the last text node (so a range can end there). Null if
 * `offset` exceeds the total text length, or there is no text node to anchor to.
 */
function locateOffset(
  doc: Document,
  el: Element,
  offset: number
): TextPosition | null {
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    // `<=` so a boundary at the end of this node anchors here rather than
    // spilling into a later (possibly absent) node.
    if (offset <= consumed + len) {
      return { node, offset: offset - consumed };
    }
    consumed += len;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  // offset === total length with no further node: anchor at end of last node.
  if (last !== null && offset === consumed) {
    return { node: last, offset: last.data.length };
  }
  return null;
}

/** Nearest ancestor-or-self Element carrying all three annotation attributes. */
function closestAnnotated(node: Node): Element | null {
  const start =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  let el: Element | null = start;
  while (el) {
    if (
      el.hasAttribute(EVENT_ID_ATTR) &&
      el.hasAttribute(FIELD_KEY_ATTR) &&
      el.hasAttribute(FIELD_INDEX_ATTR)
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * UTF-16 offset of (`container`, `containerOffset`) within `el`'s textContent:
 * the summed lengths of every text node preceding `container`, plus the in-node
 * offset. Handles `container` being either a text node within `el` or `el`
 * itself (an element-anchored boundary, where `containerOffset` is a child
 * index). Null if `container` is not within `el`.
 */
function offsetWithin(
  el: Element,
  container: Node,
  containerOffset: number
): number | null {
  const doc = el.ownerDocument;

  // Resolve an element-anchored boundary to the equivalent text node + offset.
  let target: Node = container;
  let targetOffset = containerOffset;
  if (container.nodeType === Node.ELEMENT_NODE) {
    const child = container.childNodes[containerOffset];
    if (child) {
      target = child;
      targetOffset = 0;
    } else {
      // Boundary past the last child: the end of all text under `container`.
      target = container;
      targetOffset = (container.textContent ?? "").length;
      if (container === el) return targetOffset;
    }
  }

  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (node === target) return consumed + targetOffset;
    consumed += node.data.length;
    node = walker.nextNode() as Text | null;
  }

  // `target` was an element-anchored end-of-container boundary, not a text node.
  if (target.nodeType === Node.ELEMENT_NODE && el.contains(target)) {
    return consumed === 0 ? targetOffset : consumed;
  }
  return null;
}

/** Minimal CSS attribute-value escaping for selector use. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
