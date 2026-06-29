import { RefObject, useCallback, useEffect, useMemo, useRef } from "react";

import type { Event } from "@tsmono/inspect-common/types";
import {
  useExtendedFind,
  useFindTargetSetter,
  type ExtendedFindFn,
  type FindDirection,
} from "@tsmono/react/components";

import type { SwimlaneRow } from "../timeline/swimlaneRows";
import type { TranscriptViewNodesHandle } from "../TranscriptViewNodes";

import {
  findFieldElement,
  rangeForOffsets,
  fieldSelectionFromRange,
} from "./searchDomAdapter";
import { buildEventToRowMap } from "./sampleSearch";
import { buildSearchManifest } from "./transcriptManifestBuilder";
import {
  buildMatchList,
  matchIndexFromField,
  type Match,
  type SearchField,
} from "./transcriptMatches";

const DEFAULT_ID = "transcript-sample";
const SETTLE_LIMIT = 90;

export interface UseTranscriptSearchSourceOptions {
  events: Event[];
  rows: SwimlaneRow[];
  selected: string | null;
  onSelect: (rowKey: string | null) => void;
  viewNodesRef: RefObject<TranscriptViewNodesHandle | null>;
  /** Suppress headroom-driven swimlane collapse during programmatic scrolls.
   *  Without this, scrolling between matches makes the swimlane bar flicker
   *  collapsed→expanded as the headroom hook misreads our scroll as a user
   *  gesture. Pass `true` to enable the debounced lock; the hook releases it
   *  automatically once the scroll settles. */
  onHeadroomResetAnchor?: (debounce?: boolean) => void;
  /** Force the headroom hidden state to match the search direction so a
   *  Next press collapses the swimlane (like a manual scroll-down) and a
   *  Prev press reveals it (like a scroll-up). Without this, the headroom
   *  hook only reflects whatever residual scroll motion useScrollDirection
   *  detected, which doesn't reliably correspond to the user's intent. */
  onHeadroomSetHidden?: (hidden: boolean) => void;
  /** Stable registration ID. Default `"transcript-sample"`. */
  id?: string;
}

/**
 * Registers the transcript as a *selecting* search source (see
 * design/transcript-find-spec.md). The transcript owns a canonical, ordered
 * match list, selects the exact occurrence, and reports a *validated* ordinal
 * so the counter equals the highlight (the hard invariant).
 *
 * - The shared field manifest (`buildSearchManifest`) is the single source of
 *   counted text; `buildMatchList(manifest, term)` is the ordered match list.
 *   Count = matches.length, cached per (manifest-generation, term).
 * - Step/next/prev advances an index over the matches (wrapping). For the
 *   target match it reuses the existing reveal plumbing (row switch, find
 *   target / auto-expand, scroll), then locates the annotated field element,
 *   maps the match's offsets to a `Range`, sets the selection, and VALIDATES
 *   the live selection back to an ordinal via `matchIndexFromField`. Only a
 *   validated ordinal is reported — fail closed, never advance the counter to a
 *   match it could not select.
 * - Navigation is tagged with (sampleId, manifest-generation, searchId) so a
 *   stale async reveal/select cannot move the selection or counter.
 *
 * Preconditions: must be mounted inside an `ExtendedFindProvider`. The
 * `FindTargetProvider` is optional — its setter no-ops when absent.
 */
export function useTranscriptSearchSource(
  options: UseTranscriptSearchSourceOptions
): void {
  const {
    events,
    rows,
    selected,
    onSelect,
    viewNodesRef,
    onHeadroomResetAnchor,
    onHeadroomSetHidden,
    id = DEFAULT_ID,
  } = options;
  const {
    registerVirtualList,
    registerMatchCounter,
    reportMatchIndex,
    registerSelectingSource,
  } = useExtendedFind();
  const setFindTarget = useFindTargetSetter();

  const eventToRow = useMemo(() => buildEventToRowMap(rows), [rows]);

  // manifest-generation: the manifest (its fields + their offsets) can change
  // only when the sample's events or the row map change. Bumping a generation
  // invalidates the cached manifest, every cached match list, and any in-flight
  // reveal tagged with the old generation (staleness, per spec). The async
  // build for a generation is started eagerly so the count is ready by the time
  // the user types.
  const generationRef = useRef(0);
  const manifestRef = useRef<{
    generation: number;
    promise: Promise<SearchField[]>;
    manifest: SearchField[] | null;
  } | null>(null);

  const ensureManifest = useCallback((): Promise<SearchField[]> => {
    const generation = generationRef.current;
    const current = manifestRef.current;
    if (current && current.generation === generation) return current.promise;
    const promise = buildSearchManifest(events, eventToRow).then(
      (manifest) => {
        // Discard a resolution whose generation was superseded mid-build.
        if (generationRef.current === generation && manifestRef.current) {
          manifestRef.current.manifest = manifest;
        }
        return manifest;
      }
    );
    manifestRef.current = { generation, promise, manifest: null };
    return promise;
  }, [events, eventToRow]);

  // Bump the generation and kick off the build whenever the inputs change.
  useEffect(() => {
    generationRef.current += 1;
    manifestRef.current = null;
    void ensureManifest();
  }, [ensureManifest]);

  // Match-list cache, keyed by (generation, term). Only valid once the
  // generation's manifest has resolved; until then `count` reads 0 (FindBand
  // re-counts on the next keystroke, by which point the manifest is ready).
  const matchCacheRef = useRef<{
    generation: number;
    term: string;
    matches: Match[];
  } | null>(null);
  const getMatches = useCallback((term: string): Match[] => {
    const generation = generationRef.current;
    const manifest = manifestRef.current;
    if (!manifest || manifest.generation !== generation || !manifest.manifest) {
      return [];
    }
    const cached = matchCacheRef.current;
    if (
      cached &&
      cached.generation === generation &&
      cached.term === term
    ) {
      return cached.matches;
    }
    const matches = buildMatchList(manifest.manifest, term);
    matchCacheRef.current = { generation, term, matches };
    return matches;
  }, []);

  // Read `selected` across `await` boundaries to detect "already on this row".
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Index (into the current generation's match list) of the last match we
  // resolved and selected, with the term it was for. Drives wrap-around
  // stepping when the term is unchanged.
  const lastResolvedRef = useRef<{ index: number; term: string } | null>(null);
  // searchId: supersedes a prior in-flight searchFn so a stale async reveal
  // can't move the selection/counter. Combined with the generation check below
  // this realizes the (sampleId, manifest-generation, searchId) staleness key.
  const searchIdRef = useRef(0);
  // Self-correction timers scheduled at the end of searchFn. Tracked so unmount
  // can clear them — otherwise they fire against detached DOM.
  const pendingTimersRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const countFn = useCallback(
    (term: string): number => getMatches(term).length,
    [getMatches]
  );

  const searchFn: ExtendedFindFn = useCallback(
    async (term, direction, onContentReady) => {
      const mySearchId = ++searchIdRef.current;
      const myGeneration = generationRef.current;
      const isStale = () =>
        mySearchId !== searchIdRef.current ||
        myGeneration !== generationRef.current;

      // The manifest is async; wait for this generation's build before
      // matching. A generation bump or superseding search makes us stale.
      await ensureManifest();
      if (isStale()) return false;

      const matches = getMatches(term);
      if (matches.length === 0) return false;

      // Match the headroom UI to the user's search direction (forward press
      // collapses the swimlane like manual scroll-down; backward expands it),
      // and lock the scroll-direction tracker so its observations of the
      // imminent imperative scroll don't fight us.
      onHeadroomResetAnchor?.(true);
      onHeadroomSetHidden?.(direction === "forward");

      // Starting position: continue from the last resolved match when the term
      // is unchanged; otherwise start before the first (so forward → 0).
      const last = lastResolvedRef.current;
      let position = last && last.term === term ? last.index : -1;

      // Iterate forward/backward until a match's field actually reveals and the
      // resulting selection validates. Events deeply nested under collapsed
      // spans (or filtered out) are counted but never reach the DOM; without a
      // skip the user gets stuck at the boundary. Cap attempts so a totally
      // unreachable cluster doesn't spin.
      const SKIP_LIMIT = Math.min(matches.length, 8);
      for (let attempt = 0; attempt < SKIP_LIMIT; attempt++) {
        const targetIndex = stepIndex(matches.length, position, direction);
        const next = matches[targetIndex]!;

        if (next.rowKey !== selectedRef.current) {
          onSelect(next.rowKey);
          const ready = await waitForRow(viewNodesRef, next.eventId);
          if (isStale()) return false;
          if (!ready) {
            position = targetIndex;
            continue;
          }
        }

        setFindTarget({ term, eventId: next.eventId });
        await raf();
        if (isStale()) return false;
        await raf();
        if (isStale()) return false;

        viewNodesRef.current?.scrollToEvent(next.eventId);
        const inDom = await waitForEventInDOM(next.eventId);
        if (isStale()) return false;

        const ordinal = inDom ? selectMatch(matches, targetIndex) : null;
        if (ordinal !== null) {
          lastResolvedRef.current = { index: ordinal, term };
          reportMatchIndex(ordinal + 1);
          onContentReady();

          // Async settling (Prism re-highlight, ExpandablePanel reflow on
          // setFindTarget) can detach the anchored text node and collapse the
          // highlight a few hundred ms later. Re-establish the SAME match if
          // that happens (no-op when it survives naturally).
          const reselectIndex = ordinal;
          const timer = window.setTimeout(() => {
            if (isStale()) return;
            reselectMatch(matches, reselectIndex);
          }, 300);
          pendingTimersRef.current.add(timer);
          return true;
        }

        // Unreachable / unselectable — advance past ALL matches sharing this
        // eventId (a single nested-but-unrendered event typically has many
        // occurrences; trying each would burn SKIP_LIMIT on identical failures).
        position = lastIndexForEvent(matches, targetIndex, direction);
      }
      return false;
    },
    [
      ensureManifest,
      getMatches,
      viewNodesRef,
      onSelect,
      setFindTarget,
      onHeadroomResetAnchor,
      onHeadroomSetHidden,
      reportMatchIndex,
    ]
  );

  useEffect(() => {
    const unCount = registerMatchCounter(id, countFn);
    const unSearch = registerVirtualList(id, searchFn);
    const unSelecting = registerSelectingSource(id);
    return () => {
      unCount();
      unSearch();
      unSelecting();
    };
  }, [
    id,
    registerMatchCounter,
    registerVirtualList,
    registerSelectingSource,
    countFn,
    searchFn,
  ]);
}

/** Index of the next/previous match (wrapping). `position` is the current index
 *  or -1 if none (forward → 0, backward → last). */
function stepIndex(
  len: number,
  position: number,
  dir: FindDirection
): number {
  if (position < 0) return dir === "forward" ? 0 : len - 1;
  return dir === "forward"
    ? (position + 1) % len
    : (position - 1 + len) % len;
}

/** The furthest index in `dir` still sharing `matches[from]`'s eventId — used to
 *  skip an entire unreachable event in one step. */
function lastIndexForEvent(
  matches: Match[],
  from: number,
  dir: FindDirection
): number {
  const eventId = matches[from]!.eventId;
  const stride = dir === "forward" ? 1 : -1;
  let last = from;
  for (
    let idx = from + stride;
    idx >= 0 && idx < matches.length && matches[idx]!.eventId === eventId;
    idx += stride
  ) {
    last = idx;
  }
  return last;
}

/**
 * Select the occurrence `matches[index]` refers to and VALIDATE it back to an
 * ordinal. Locates the annotated field element, maps the match's offsets to a
 * `Range`, sets the window selection, then reads the live selection back via
 * `fieldSelectionFromRange` → `matchIndexFromField`. Returns the validated
 * 0-based ordinal, or `null` if the field isn't mounted, the offsets don't map,
 * or the resulting selection doesn't validate (fail closed — the selection is
 * left untouched on the no-element / no-range path).
 */
function selectMatch(matches: Match[], index: number): number | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  const match = matches[index]!;
  const fieldEl = findFieldElement(document, match);
  if (!fieldEl) return null;
  const range = rangeForOffsets(fieldEl, match.start, match.end);
  if (!range) return null;

  const sel = window.getSelection();
  if (!sel) return null;
  sel.removeAllRanges();
  sel.addRange(range);

  const live = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!live) return null;
  const fieldSel = fieldSelectionFromRange(live);
  if (!fieldSel) return null;
  return matchIndexFromField(matches, fieldSel);
}

/**
 * If a late settling pass (Virtuoso re-render, lazy syntax highlighting,
 * ExpandablePanel reflow) detached the selected text node, re-select the SAME
 * match. No-op when the existing highlight still validates to this ordinal.
 */
function reselectMatch(matches: Match[], index: number): void {
  if (typeof window === "undefined") return;
  const sel = window.getSelection();
  if (!sel) return;
  if (sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
    const fieldSel = fieldSelectionFromRange(sel.getRangeAt(0));
    if (fieldSel && matchIndexFromField(matches, fieldSel) === index) {
      return; // existing highlight is intact — don't disturb
    }
  }
  selectMatch(matches, index);
}

function raf(): Promise<void> {
  return new Promise((resolve) =>
    typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 0)
  );
}

/**
 * Wait for the freshly-selected row to mount: poll until the target eventId
 * is present in the flattened-node list, or the budget expires.
 * Returns false if the view is not mounted or the event never appears.
 */
async function waitForRow(
  viewNodesRef: RefObject<TranscriptViewNodesHandle | null>,
  eventId: string
): Promise<boolean> {
  for (let i = 0; i < SETTLE_LIMIT; i++) {
    const view = viewNodesRef.current;
    if (!view) {
      // No mounted view to wait on — bail immediately.
      return false;
    }
    if (view.getFlattenedNodes().some((n) => n.id === eventId)) return true;
    await raf();
  }
  return false;
}

/**
 * Wait until the event panel is actually rendered to the DOM. After
 * `scrollToEvent` triggers a Virtuoso scroll for an off-screen target, the
 * panel takes several frames to mount. Returns false on timeout. The budget
 * is shorter than for row mount because we use this to detect unreachable
 * matches and skip them — too long a wait makes skipping feel laggy.
 */
async function waitForEventInDOM(eventId: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const DOM_BUDGET = 30;
  for (let i = 0; i < DOM_BUDGET; i++) {
    if (document.getElementById(eventId)) return true;
    await raf();
  }
  return false;
}
