import { createContext, useContext } from "react";

/** What a row rendered by a VirtualList may ask of its scroller: convert a
 *  client-space box to the list's content-space offset and scroll there
 *  through the virtualizer, so the library's own reconciliation targets the
 *  requested offset instead of re-centring the last row jump. */
export interface VirtualScroller {
  /** Content-space offset of a client-space top coordinate. */
  contentOffsetOf(clientTop: number): number;
  /** The scroller's client-space box. */
  viewportRect(): DOMRect;
  scrollToContentOffset(offset: number): void;
  /** Called with a row element after the list has measured it (post-commit);
   *  returns the unsubscribe. */
  onRowMeasured(listener: (node: Element) => void): () => void;
}

export const VirtualScrollerContext = createContext<VirtualScroller | null>(
  null
);

/** The enclosing VirtualList's scroller, or null outside one. */
export const useVirtualScroller = (): VirtualScroller | null =>
  useContext(VirtualScrollerContext);
