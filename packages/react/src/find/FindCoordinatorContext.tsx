import {
  createContext,
  FC,
  ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { FIND_IDLE_STATE, FindStore } from "./findStore";
import type { FindCoordinator, FindState, FindSurface } from "./types";

// The context carries the store itself (stable identity): state consumers
// subscribe via useSyncExternalStore, so a keystroke re-renders only the
// components that read find state — not the whole tree under the provider.
const FindCoordinatorContext = createContext<FindStore | null>(null);

interface FindProviderProps {
  children: ReactNode;
}

/** The find coordinator: a registry of per-scope FindSurfaces plus the
 *  query/match-window store FindBand and the per-row highlighter consume. */
export const FindProvider: FC<FindProviderProps> = ({ children }) => {
  const [store] = useState(() => new FindStore());
  useEffect(() => () => store.dispose(), [store]);
  return (
    <FindCoordinatorContext.Provider value={store}>
      {children}
    </FindCoordinatorContext.Provider>
  );
};

/** Null outside a FindProvider, for surfaces that integrate with find when
 *  available but must not require it. */
export const useFindCoordinatorOptional = (): FindCoordinator | null =>
  useContext(FindCoordinatorContext);

const noopSubscribe = () => () => {};

/** Live find state; the idle state outside a FindProvider. */
export const useFindState = (): FindState => {
  const store = useContext(FindCoordinatorContext);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getState : () => FIND_IDLE_STATE
  );
};

/** Register a surface for as long as the component is mounted (no-op
 *  outside a FindProvider). Registration is per scope; a new source identity
 *  is swapped in place and a change of `dataKey` (the surface's data changed
 *  under the same source) re-surveys, both keeping the window on screen.
 *  reveal() is read through a ref: it closes over fast-moving view state
 *  (selection, scroll handles). */
export const useFindSurface = (
  surface: FindSurface | null,
  dataKey?: unknown
): void => {
  const store = useContext(FindCoordinatorContext);
  const latest = useRef<FindSurface | null>(null);
  const lastDataKey = useRef(dataKey);
  useEffect(() => {
    latest.current = surface;
  });
  const scopeId = surface?.scopeId;
  const source = surface?.source;
  useEffect(() => {
    const current = latest.current;
    if (!store || scopeId === undefined || !current) return;
    return store.registerSurface({
      scopeId,
      source: current.source,
      reveal: (match, signal) => {
        latest.current?.reveal(match, signal);
      },
    });
  }, [store, scopeId]);
  useEffect(() => {
    if (store && scopeId !== undefined && source) {
      store.updateSource(scopeId, source);
    }
  }, [store, scopeId, source]);
  useEffect(() => {
    if (lastDataKey.current === dataKey) return;
    lastDataKey.current = dataKey;
    if (store && scopeId !== undefined) store.invalidate(scopeId);
  }, [store, scopeId, dataKey]);
};
