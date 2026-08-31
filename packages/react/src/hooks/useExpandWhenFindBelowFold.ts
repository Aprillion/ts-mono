import { useLayoutEffect, useState, type RefObject } from "react";

import { rangeExceedsFold } from "../find/findClip";
import { useFindState } from "../find/FindCoordinatorContext";

import {
  computeRowRanges,
  encodeTexts,
  variantsPattern,
} from "./useFindHighlights";

/**
 * Expand a collapsed panel only when the active Find occurrence sits below
 * its fold. Matching the typed letter anywhere in the subtree grew every
 * assistant message on the first keystroke.
 *
 * Panels not under a `data-find-anchor` row still use a substring check so
 * the legacy window.find path can open a clipped hit.
 */
export function useExpandWhenFindBelowFold(
  contentRef: RefObject<HTMLElement | null>,
  foldPx: number,
  fallbackTerm: string | undefined
): boolean {
  const { rows, activeRow, activeOccurrence } = useFindState();
  const [expand, setExpand] = useState(false);
  const active = activeRow !== null ? rows[activeRow] : undefined;
  const texts = active?.texts;
  const anchorId = active?.anchor.id;
  const textsKey = texts ? encodeTexts(texts) : "";

  useLayoutEffect(() => {
    const scan = () => {
      const root = contentRef.current;
      if (!root) {
        setExpand(false);
        return;
      }
      const row = root.closest("[data-find-anchor]");
      if (row instanceof HTMLElement) {
        if (
          !anchorId ||
          row.dataset.findAnchor !== anchorId ||
          activeOccurrence === null ||
          !texts ||
          texts.length === 0
        ) {
          setExpand(false);
          return;
        }
        const { activeRange } = computeRowRanges(
          row,
          variantsPattern(texts),
          activeOccurrence
        );
        if (!activeRange || !root.contains(activeRange.startContainer)) {
          setExpand(false);
          return;
        }
        setExpand(rangeExceedsFold(root, activeRange, foldPx));
        return;
      }
      if (!fallbackTerm) {
        setExpand(false);
        return;
      }
      const text = root.textContent || "";
      setExpand(text.toLowerCase().includes(fallbackTerm.toLowerCase()));
    };
    scan();
    const root = contentRef.current;
    if (!root) return;
    const observer = new MutationObserver(scan);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-markdown-pending"],
    });
    return () => observer.disconnect();
  }, [
    anchorId,
    activeOccurrence,
    textsKey,
    texts,
    foldPx,
    fallbackTerm,
    contentRef,
  ]);

  return expand;
}
