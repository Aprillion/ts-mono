import type { Virtualizer } from "@tanstack/react-virtual";

/**
 * Scroll by a DOM-pixel delta through the virtualizer, dropping its
 * scroll-to-index anchor. The cache write is load-bearing: virtual-core only
 * learns the offset from the scroll event a frame later, and a row re-measured
 * before that rewrites scrollTop from the stale cache (design/find.md step 8).
 */
export function scrollVirtualizerBy(
  virtualizer: Virtualizer<HTMLElement, Element>,
  el: HTMLElement,
  deltaPx: number,
  scale: number
): void {
  const target = virtualizer.getOffsetForAlignment(
    (el.scrollTop + deltaPx) * scale,
    "start"
  );
  virtualizer.scrollToOffset(target, { behavior: "auto" });
  virtualizer.scrollOffset = target;
}
