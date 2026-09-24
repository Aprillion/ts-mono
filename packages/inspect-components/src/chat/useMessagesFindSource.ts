import { RefObject, useMemo, useRef } from "react";

import {
  foldText,
  useExtendedFindOptional,
  useFindTarget,
  type FindSource,
} from "@tsmono/react/components";
import { useOnChange, useRegistration } from "@tsmono/react/hooks";
import type { VirtualListHandle } from "@tsmono/react/virtual";

import { messageSearchText } from "./messageSearchText";
import { locateOrdinal, rowMatchCounts } from "./messagesFind";
import type { MessageRow } from "./rowsModel";

interface MessagesFindSourceOptions {
  rows: MessageRow[];
  listHandle: RefObject<VirtualListHandle | null>;
  hasMoreRows?: boolean;
  onLoadMoreRows?: () => void;
  /** Rows still arriving with no page to request (first read, backfill). */
  loading?: boolean;
}

/** The Messages tab's FindSource (design/find.md), registered while mounted. */
export const useMessagesFindSource = ({
  rows,
  listHandle,
  hasMoreRows = false,
  onLoadMoreRows,
  loading = false,
}: MessagesFindSourceOptions): void => {
  // React Compiler would hoist the per-source count cache below into one slot
  // shared by every source, serving the first page's counts for all of them.
  "use no memo";
  const find = useExtendedFindOptional();
  // Band state, not source state: a re-registration (paging, backfill) must
  // not re-run the list for a term already revealed, but a closed band has
  // collapsed the panels again, so the next reveal goes through the list.
  const revealed = useRef("");
  useOnChange(useFindTarget(), (target) => {
    if (!target) revealed.current = "";
  });
  // Registered through an effect: a new object per render would re-register.
  const source = useMemo<FindSource>(() => {
    const foldedRows = rows.map((row) =>
      messageSearchText(row.resolved).map(foldText)
    );
    // A one-slot Map, not a reassigned `let`: the compiler's lint rejects a
    // binding written after render, and the memo is opted out of it anyway.
    const cache = new Map<string, { counts: number[]; total: number }>();
    const countsFor = (term: string) => {
      const folded = foldText(term);
      let entry = cache.get(folded);
      if (!entry) {
        const counts = rowMatchCounts(foldedRows, folded);
        entry = { counts, total: counts.reduce((sum, n) => sum + n, 0) };
        cache.clear();
        cache.set(folded, entry);
      }
      return entry;
    };
    return {
      count: (term) => ({
        total: countsFor(term).total,
        complete: !hasMoreRows && !loading,
      }),
      reveal: (term, ordinal, onLanded) => {
        const at = locateOrdinal(countsFor(term).counts, ordinal);
        const list = listHandle.current;
        if (!at || !list) {
          onLanded(null);
          return;
        }
        const landing = {
          element: () => list.rowElement(at.rowIndex),
          occurrence: at.occurrence,
          scrollBy: (deltaPx: number) => list.scrollBy(deltaPx),
        };
        // After a term's first reveal (which expands its panels) a mounted row
        // is measured: the painter alone places the occurrence, where
        // virtual-core's "auto" would first align an edge of a row taller
        // than the scroller.
        if (term === revealed.current && list.rowElement(at.rowIndex)) {
          onLanded(landing);
          return;
        }
        revealed.current = term;
        list.scrollToIndex({
          index: at.rowIndex,
          align: "start",
          onDone: (element) => onLanded(element ? landing : null),
        });
      },
      loadMore: hasMoreRows ? onLoadMoreRows : undefined,
    };
  }, [rows, hasMoreRows, onLoadMoreRows, loading, listHandle]);
  useRegistration(find?.registerFindSource, source);
};
