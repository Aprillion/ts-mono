import { useEffect, type RefObject } from "react";

import type { FindRow } from "../find/types";

/** Retry a Find reveal that was waiting on a paged-in prefix: when more
 *  rows arrive, scroll if the row is now loaded, else ask for another page. */
export function usePendingFindReveal(
  pendingRef: RefObject<{ row: FindRow; signal: AbortSignal } | null>,
  revealLoaded: (row: FindRow) => boolean,
  hasMoreRows: boolean | undefined,
  onLoadMoreRows: (() => void) | undefined
): void {
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.signal.aborted || revealLoaded(pending.row)) {
      pendingRef.current = null;
    } else if (hasMoreRows) {
      onLoadMoreRows?.();
    }
  }, [pendingRef, revealLoaded, hasMoreRows, onLoadMoreRows]);
}
