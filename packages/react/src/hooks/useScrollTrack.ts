import { RefObject, useCallback, useEffect, useRef } from "react";

/**
 * Track which element is currently at the top of a scroll container.
 *
 * Calls `onElementVisible` when the element nearest the detection point (the
 * top of the viewport, just below any sticky chrome) changes. At the very
 * bottom of the scroll range the detection point drops to the viewport bottom,
 * so the final elements — which can't be scrolled to the top — can still
 * become current.
 */
export function useScrollTrack(
  elementIds: string[],
  onElementVisible: (id: string) => void,
  scrollRef?: RefObject<HTMLElement | null>,
  options?: { topOffset?: number; checkInterval?: number }
) {
  const currentVisibleRef = useRef<string | null>(null);
  const lastCheckRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const findTopmostVisibleElement = useCallback(() => {
    const container = scrollRef?.current;
    const containerRect = container?.getBoundingClientRect();
    const topOffset = options?.topOffset ?? 50;

    // Define viewport bounds
    const viewportTop = containerRect
      ? containerRect.top + topOffset
      : topOffset;
    const viewportBottom = containerRect
      ? containerRect.bottom
      : window.innerHeight;

    // The detection point sits at the top of the viewport (just below the
    // sticky chrome): the "current" element is whatever sits at the top, which
    // is exactly where a scroll-to-element lands its target. The one exception
    // is the very bottom of the scroll range, where the final elements
    // physically can't reach the top — there we detect against the bottom of
    // the viewport so the last item can still become current.
    //
    // Detection stays binary (top, or bottom only at the end of the range)
    // rather than sliding progressively downward near the bottom: a sliding
    // point corrupts explicit navigation, landing a jump target at the top yet
    // detecting an element one or two rows further down.
    let detectionPoint = viewportTop;
    if (container) {
      const maxScroll = container.scrollHeight - container.clientHeight;
      const atBottom = maxScroll > 0 && container.scrollTop / maxScroll >= 0.99;
      if (atBottom) {
        detectionPoint = viewportBottom - 50;
      }
    }

    let closestId: string | null = null;
    let closestDistance = Infinity;

    const elementIdSet = new Set(elementIds);

    const elements = container
      ? container.querySelectorAll("[id]")
      : document.querySelectorAll("[id]");

    for (const element of elements) {
      const id = element.id;

      if (elementIdSet.has(id)) {
        const rect = element.getBoundingClientRect();

        if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
          const elementCenter = rect.top + rect.height / 2;
          const distance = Math.abs(elementCenter - detectionPoint);

          if (distance < closestDistance) {
            closestDistance = distance;
            closestId = id;
          }
        }
      }
    }

    return closestId;
  }, [elementIds, scrollRef, options?.topOffset]);

  const checkVisibility = useCallback(() => {
    const now = Date.now();
    const checkInterval = options?.checkInterval ?? 100;

    if (now - lastCheckRef.current < checkInterval) {
      return;
    }

    lastCheckRef.current = now;
    const topmostId = findTopmostVisibleElement();

    if (topmostId !== currentVisibleRef.current) {
      currentVisibleRef.current = topmostId;
      if (topmostId) {
        onElementVisible(topmostId);
      }
    }
  }, [findTopmostVisibleElement, onElementVisible, options?.checkInterval]);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      checkVisibility();
      rafRef.current = null;
    });
  }, [checkVisibility]);

  useEffect(() => {
    if (elementIds.length === 0) return;

    const scrollElement = scrollRef?.current || window;

    checkVisibility();

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    const intervalId = setInterval(checkVisibility, 1000);

    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      clearInterval(intervalId);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [elementIds, scrollRef, handleScroll, checkVisibility]);
}
