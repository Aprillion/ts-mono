import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useRef,
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

// 1-based ordinal of the currently-highlighted match, or null when unresolved.
export type MatchIndexListener = (index: number | null) => void;

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
  // Search sources report the resolved match's ordinal; the find UI subscribes
  // so its counter tracks the highlighted match, not a blind step count.
  reportMatchIndex: (index: number | null) => void;
  subscribeMatchIndex: (listener: MatchIndexListener) => () => void;
  // A "selecting" source (the transcript) selects the exact match itself and
  // reports its ordinal, so explicit nav can step its match list directly. A
  // plain VirtualList only scrolls, so the find UI must NOT route through it.
  registerSelectingSource: (id: string) => () => void;
  hasSelectingSource: () => boolean;
}

const ExtendedFindContext = createContext<ExtendedFindContextType | null>(null);

interface ExtendedFindProviderProps {
  children: ReactNode;
}

export const ExtendedFindProvider = ({
  children,
}: ExtendedFindProviderProps) => {
  const virtualLists = useRef<Map<string, ExtendedFindFn>>(new Map());
  const matchCounters = useRef<Map<string, ExtendedCountFn>>(new Map());
  const matchIndexListeners = useRef<Set<MatchIndexListener>>(new Set());
  const selectingSources = useRef<Set<string>>(new Set());

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
      return () => {
        matchCounters.current.delete(id);
      };
    },
    []
  );

  const reportMatchIndex = useCallback((index: number | null): void => {
    for (const listener of matchIndexListeners.current) {
      listener(index);
    }
  }, []);

  const subscribeMatchIndex = useCallback(
    (listener: MatchIndexListener): (() => void) => {
      matchIndexListeners.current.add(listener);
      return () => {
        matchIndexListeners.current.delete(listener);
      };
    },
    []
  );

  const registerSelectingSource = useCallback((id: string): (() => void) => {
    selectingSources.current.add(id);
    return () => {
      selectingSources.current.delete(id);
    };
  }, []);

  const hasSelectingSource = useCallback(
    (): boolean => selectingSources.current.size > 0,
    []
  );

  const contextValue: ExtendedFindContextType = {
    extendedFindTerm,
    registerVirtualList,
    countAllMatches,
    registerMatchCounter,
    reportMatchIndex,
    subscribeMatchIndex,
    registerSelectingSource,
    hasSelectingSource,
  };

  return (
    <ExtendedFindContext.Provider value={contextValue}>
      {children}
    </ExtendedFindContext.Provider>
  );
};

export const useExtendedFind = (): ExtendedFindContextType => {
  const context = useContext(ExtendedFindContext);
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider");
  }
  return context;
};
