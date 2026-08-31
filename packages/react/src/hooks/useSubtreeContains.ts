import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether `rootRef`'s subtree currently contains any of `needles`, or
 * (if those are empty) a case-insensitive `fallback`. Updates when the
 * query changes and when the subtree mutates — not on every parent render.
 */
export function useSubtreeContains(
  rootRef: RefObject<HTMLElement | null>,
  needles: readonly string[],
  fallback: string | undefined
): boolean {
  const [contains, setContains] = useState(false);

  useLayoutEffect(() => {
    const scan = () => {
      const root = rootRef.current;
      if (!fallback || !root) {
        setContains(false);
        return;
      }
      const text = root.textContent ?? "";
      setContains(
        needles.length > 0
          ? needles.some((needle) => text.includes(needle))
          : text.toLowerCase().includes(fallback.toLowerCase())
      );
    };
    scan();
    const root = rootRef.current;
    if (!root || !fallback) return;
    const observer = new MutationObserver(scan);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [fallback, needles, rootRef]);

  return contains;
}
