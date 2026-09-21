import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

// The search context provides global search assistance. We generally use the
// browser to perform searches using 'find', but this allows for virtual lists
// and other virtualized components to register themselves to be notified when a
// search is requested and no matches are found. In this case, they can 'look ahead'
// and scroll an item into view if it is likely/certain to contain the search term.

export type FindDirection = "forward" | "backward";

// Find will call this when an extended find is requested
export type ExtendedFindFn = (
  term: string,
  direction: FindDirection,
  onContentReady: () => void
) => Promise<boolean>;

// Count total matches across all data items
export type ExtendedCountFn = (term: string) => number;

export interface FindCount {
  total: number;
  /** False while the source holds a loaded prefix of its rows (shown as M+). */
  complete: boolean;
}

/** A revealed match: the row's current element (null while the virtualizer
 *  has it unmounted) and the 0-based occurrence within it. */
export interface FindLanding {
  element: () => HTMLElement | null;
  occurrence: number;
  /** DOM-pixel delta through the list (VirtualListHandle.scrollBy). */
  scrollBy: (deltaPx: number) => void;
}

/** A tab's find engine; contract and states in design/find.md. */
export interface FindSource {
  /** What is being searched — a sample, a scanner result. The band starts
   *  over when a source registers with a different one. */
  scopeId: string;
  count(term: string): FindCount;
  /** Null when the row of the 1-based `ordinal` is not rendered. */
  reveal(
    term: string,
    ordinal: number,
    onLanded: (landing: FindLanding | null) => void
  ): void;
  loadMore?: () => void;
}

// The context provides an extended search function and a way for the active
// virtual lists to register themselves.
interface ExtendedFindContextType {
  extendedFindTerm: (
    term: string,
    direction: FindDirection
  ) => Promise<boolean>;
  registerVirtualList: (id: string, searchFn: ExtendedFindFn) => () => void;
  countAllMatches: (term: string) => number;
  registerMatchCounter: (id: string, countFn: ExtendedCountFn) => () => void;
  // Bumped on every counter (un)registration. Counters re-register when
  // their underlying data changes, so this doubles as a cheap content
  // version for invalidating cached countAllMatches results.
  getMatchCountersVersion: () => number;
  registerFindSource: (source: FindSource) => () => void;
}

const ExtendedFindContext = createContext<ExtendedFindContextType | null>(null);
const FindSourceContext = createContext<FindSource | null>(null);

interface ExtendedFindProviderProps {
  children: ReactNode;
}

export const ExtendedFindProvider = ({
  children,
}: ExtendedFindProviderProps) => {
  const virtualLists = useRef<Map<string, ExtendedFindFn>>(new Map());
  const matchCounters = useRef<Map<string, ExtendedCountFn>>(new Map());
  const matchCountersVersion = useRef(0);
  const [findSource, setFindSource] = useState<FindSource | null>(null);

  const registerFindSource = useCallback((source: FindSource) => {
    setFindSource(source);
    return () => {
      setFindSource((current) => (current === source ? null : current));
    };
  }, []);

  const extendedFindTerm = useCallback(
    async (term: string, direction: FindDirection): Promise<boolean> => {
      for (const [, searchFn] of virtualLists.current) {
        const found = await new Promise<boolean>((resolve) => {
          let callbackFired = false;

          const onContentReady = () => {
            if (!callbackFired) {
              callbackFired = true;
              resolve(true);
            }
          };

          searchFn(term, direction, onContentReady)
            .then((found) => {
              if (!found && !callbackFired) {
                callbackFired = true;
                resolve(false);
              }
            })
            .catch(() => {
              if (!callbackFired) {
                callbackFired = true;
                resolve(false);
              }
            });
        });

        if (found) {
          return true;
        }
      }
      return false;
    },
    []
  );

  const registerVirtualList = useCallback(
    (id: string, searchFn: ExtendedFindFn): (() => void) => {
      virtualLists.current.set(id, searchFn);
      return () => {
        virtualLists.current.delete(id);
      };
    },
    []
  );

  const countAllMatches = useCallback((term: string): number => {
    let total = 0;
    for (const [, countFn] of matchCounters.current) {
      total += countFn(term);
    }
    return total;
  }, []);

  const registerMatchCounter = useCallback(
    (id: string, countFn: ExtendedCountFn): (() => void) => {
      matchCounters.current.set(id, countFn);
      matchCountersVersion.current++;
      return () => {
        matchCounters.current.delete(id);
        matchCountersVersion.current++;
      };
    },
    []
  );

  const getMatchCountersVersion = useCallback(
    () => matchCountersVersion.current,
    []
  );

  // Stable across the source-state re-renders, or every registry consumer
  // (the registering list among them) re-renders per registration.
  const contextValue = useMemo<ExtendedFindContextType>(
    () => ({
      extendedFindTerm,
      registerVirtualList,
      countAllMatches,
      registerMatchCounter,
      getMatchCountersVersion,
      registerFindSource,
    }),
    [
      extendedFindTerm,
      registerVirtualList,
      countAllMatches,
      registerMatchCounter,
      getMatchCountersVersion,
      registerFindSource,
    ]
  );

  return (
    <ExtendedFindContext.Provider value={contextValue}>
      <FindSourceContext.Provider value={findSource}>
        {children}
      </FindSourceContext.Provider>
    </ExtendedFindContext.Provider>
  );
};

export const useExtendedFind = (): ExtendedFindContextType => {
  const context = useExtendedFindOptional();
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider");
  }
  return context;
};

export const useFindSource = (): FindSource | null =>
  useContext(FindSourceContext);

/** Null outside an ExtendedFindProvider, for components (e.g. VirtualList)
 *  that integrate with find when available but must not require it. */
export const useExtendedFindOptional = (): ExtendedFindContextType | null =>
  useContext(ExtendedFindContext);
