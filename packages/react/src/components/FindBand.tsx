import {
  ChangeEvent,
  FC,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { deepActiveElement, isEditableTarget } from "@tsmono/util";

import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { useOnChange } from "../hooks/useOnChange";
import { useUnmount } from "../hooks/useUnmount";

import {
  useExtendedFind,
  useFindSource,
  type FindSource,
} from "./ExtendedFindContext";
import { findScrollableParent, scrollRangeToCenter } from "./findBandDom";
import { FindBandUI } from "./FindBandUI";
import { createFindPainter, type FindPainter } from "./findPainter";
import { isFindNextShortcut, isFindShortcut } from "./findShortcuts";
import { useFindTargetSetter } from "./FindTargetContext";

const findConfig = {
  caseSensitive: false,
  wrapAround: false,
  wholeWord: false,
  searchInFrames: false,
  showDialog: false,
};

// Peter's type-ahead constants (R11): a one-character term waits longer.
const kFirstCharDebounceMs = 500;
const kDebounceMs = 300;
// Pending target for "last" while the count is incomplete (K124).
const kLastMatch = Infinity;

interface FindBandProps {
  onClose: () => void;
}

export const FindBand: FC<FindBandProps> = ({ onClose }) => {
  const searchBoxRef = useRef<HTMLInputElement>(null);
  const { extendedFindTerm, countAllMatches, getMatchCountersVersion } =
    useExtendedFind();
  const source = useFindSource();
  const setFindTarget = useFindTargetSetter();
  const lastFoundItem = useRef<{
    text: string;
    offset: number;
    parentElement: Element | null;
  } | null>(null);
  const currentSearchTerm = useRef<string>("");
  const needsCursorRestoreRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const focusTimeoutRef = useRef<number | null>(null);
  const searchIdRef = useRef(0);
  const cachedCount = useRef<{ term: string; version: number; count: number }>({
    term: "",
    version: -1,
    count: 0,
  });
  const lastNoResult = useRef<{ term: string; version: number } | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  // Tracks whether the most recent search returned no result, separate
  // from `matchCount`. On tabs that don't register a search source
  // (Scoring/Metadata/JSON) the counter is unknown but `window.find` may
  // still succeed — we use this flag for the "No results" UI instead.
  const [noResults, setNoResults] = useState(false);

  // Sourced path, design/find.md; the counter is derived from the source.
  const painter = useRef<FindPainter | null>(null);
  const revealId = useRef(0);
  const [term, setTerm] = useState("");
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const sourced = source && term ? source.count(term) : null;

  // Stable: handleSearch, and the document keydown listener, depend on it.
  const revealOrdinal = useCallback(
    (src: FindSource, searchTerm: string, ordinal: number) => {
      const paint = (painter.current ??= createFindPainter());
      setCurrentMatchIndex(ordinal);
      const id = ++revealId.current;
      src.reveal(searchTerm, ordinal, (landing) => {
        if (id !== revealId.current) return;
        if (landing) paint.paint(landing, searchTerm);
        else paint.clear();
      });
    },
    []
  );

  const clearMatches = useCallback(() => {
    setCurrentMatchIndex(0);
    painter.current?.clear();
  }, []);

  // Back to the open-but-empty state: no term, no ordinal, no highlights.
  const resetBand = useCallback(
    (clearInput = false) => {
      if (clearInput && searchBoxRef.current) searchBoxRef.current.value = "";
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }
      currentSearchTerm.current = "";
      lastFoundItem.current = null;
      revealId.current++;
      painter.current?.clear();
      setTerm("");
      setPendingOrdinal(null);
      setMatchCount(null);
      setCurrentMatchIndex(0);
      setNoResults(false);
      setFindTarget(null);
    },
    [setFindTarget]
  );

  const handleSearch = useCallback(
    async (back = false, auto = false) => {
      const searchTerm = searchBoxRef.current?.value ?? "";
      if (!searchTerm) {
        resetBand();
        return;
      }

      if (source) {
        const termChanged = searchTerm !== term;
        setPendingOrdinal(null);
        setNoResults(false);
        if (auto && !termChanged) return;
        if (termChanged) {
          revealId.current++;
          setTerm(searchTerm);
          setFindTarget({ term: searchTerm, eventId: "" });
        }
        const { total, complete } = source.count(searchTerm);
        let ordinal = termChanged
          ? back
            ? total
            : 1
          : back
            ? currentMatchIndex - 1
            : currentMatchIndex + 1;
        if (ordinal < 1) ordinal = complete ? total : kLastMatch;
        if (ordinal > total && !complete) {
          setPendingOrdinal(ordinal);
          source.loadMore?.();
          return;
        }
        if (total === 0) {
          clearMatches();
          return;
        }
        revealOrdinal(source, searchTerm, ordinal > total ? 1 : ordinal);
        return;
      }

      const thisSearchId = ++searchIdRef.current;
      const countersVersion = getMatchCountersVersion();

      // Typing more characters onto a term already known to miss can't
      // produce a match, so debounced auto-searches skip the (expensive)
      // full-document scans. Explicit searches (Enter, next/prev) always
      // run, which also re-checks content the version can't track.
      if (
        auto &&
        lastNoResult.current &&
        lastNoResult.current.version === countersVersion &&
        searchTerm.startsWith(lastNoResult.current.term)
      ) {
        setMatchCount(null);
        setNoResults(true);
        return;
      }

      const termChanged = currentSearchTerm.current !== searchTerm;
      if (termChanged) {
        lastFoundItem.current = null;
        currentSearchTerm.current = searchTerm;
        setCurrentMatchIndex(0);
      }

      // `total` only counts matches reported by registered search sources
      // (transcript, chat virtual list). Tabs that are plain static markup
      // — Scoring, Metadata, JSON — register no source, so total is 0 even
      // though `window.find` could highlight visible text just fine. Don't
      // bail on `total === 0`: try the find, and if it succeeds use the
      // index-1-of-unknown UI; if it doesn't, the post-search "no result"
      // branch handles it.
      let total: number;
      if (
        cachedCount.current.term === searchTerm &&
        cachedCount.current.version === countersVersion
      ) {
        total = cachedCount.current.count;
      } else {
        total = countAllMatches(searchTerm);
        cachedCount.current = {
          term: searchTerm,
          version: countersVersion,
          count: total,
        };
      }
      setMatchCount(total > 0 ? total : null);

      const focusedElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      const selection = window.getSelection();
      let savedRange: Range | null = null;
      if (selection && selection.rangeCount > 0) {
        savedRange = selection.getRangeAt(0).cloneRange();
      }

      const savedScrollParent = savedRange
        ? findScrollableParent(savedRange.startContainer.parentElement)
        : null;
      const savedScrollTop = savedScrollParent?.scrollTop ?? 0;

      const result = await findExtendedInDOM(
        searchTerm,
        back,
        lastFoundItem.current,
        extendedFindTerm
      );

      if (searchIdRef.current !== thisSearchId) {
        return;
      }

      setNoResults(!result);
      lastNoResult.current = result
        ? null
        : { term: searchTerm, version: countersVersion };
      if (!result && savedRange) {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(savedRange);
        }
        if (savedScrollParent) {
          savedScrollParent.scrollTop = savedScrollTop;
        }
      }

      if (result) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const parentElement = rangeParentElement(range);
          const isNewMatch = !isLastFoundItem(range, lastFoundItem.current);
          lastFoundItem.current = {
            text: range.toString(),
            offset: range.startOffset,
            parentElement,
          };

          // Publish the active term AFTER the find succeeds so consumers
          // (ExpandablePanel) auto-expand panels whose subtree contains the
          // term. Doing this after window.find avoids the auto-expand
          // re-render landing in the middle of the search, which could
          // detach the text node the selection is anchored on. The
          // transcript's search source overlays this with a per-event
          // target via its own setFindTarget call.
          if (termChanged) {
            setFindTarget({ term: searchTerm, eventId: "" });
          }

          if (isNewMatch) {
            setCurrentMatchIndex((prev) => {
              if (back) {
                return prev <= 1 ? total : prev - 1;
              } else {
                return prev >= total ? 1 : prev + 1;
              }
            });
          }

          if (scrollTimeoutRef.current !== null) {
            window.clearTimeout(scrollTimeoutRef.current);
          }
          scrollTimeoutRef.current = window.setTimeout(() => {
            scrollRangeToCenter(range);
          }, 100);
        }
      }

      focusedElement?.focus();
    },
    [
      setFindTarget,
      extendedFindTerm,
      countAllMatches,
      getMatchCountersVersion,
      source,
      term,
      currentMatchIndex,
      revealOrdinal,
      clearMatches,
      resetBand,
    ]
  );

  // Seeded on the first render, not through useOnChange: the band usually
  // mounts over a tab that already registered its source, and that first
  // source never arrives as a change.
  const scope = useRef<string | null>(source?.scopeId ?? null);
  useOnChange(source, (next) => {
    // A different document (another sample, another scanner result) or no
    // source at all: the term, the ordinal and the highlights were about
    // content that is gone (K125).
    if (!next) {
      scope.current = null;
      resetBand(true);
      return;
    }
    if (next.scopeId !== scope.current) {
      const hadScope = scope.current !== null;
      scope.current = next.scopeId;
      if (hadScope) {
        resetBand(true);
        return;
      }
    }
    // A term typed while no source was registered ran the window.find path.
    if (!term && searchBoxRef.current?.value) {
      handleSearch(false, true).catch(() => undefined);
      return;
    }
    if (pendingOrdinal === null) return;
    const { total, complete } = next.count(term);
    if (pendingOrdinal <= total) {
      setPendingOrdinal(null);
      revealOrdinal(next, term, pendingOrdinal);
    } else if (!complete) {
      next.loadMore?.();
    } else {
      setPendingOrdinal(null);
      if (total > 0)
        revealOrdinal(next, term, pendingOrdinal === kLastMatch ? total : 1);
      else clearMatches();
    }
  });

  // eslint-disable-next-line tsmono/no-raw-use-effect -- baselined at rule introduction; migrate to a named hook or derived state
  useEffect(() => {
    focusTimeoutRef.current = window.setTimeout(() => {
      searchBoxRef.current?.focus();
      searchBoxRef.current?.select();
    }, 10);

    const focusTimeout = focusTimeoutRef.current;

    return () => {
      // Read at teardown, not setup: handleSearch schedules the scroll
      // timeout long after mount, so a setup-time capture is always null.
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout);
      }
    };
  }, []);
  useUnmount(() => {
    setFindTarget(null);
    revealId.current++;
    painter.current?.clear();
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSearch(e.shiftKey);
      } else if (isFindNextShortcut(e)) {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSearch(e.shiftKey);
      } else if (isFindShortcut(e)) {
        searchBoxRef.current?.focus();
        searchBoxRef.current?.select();
      }
    },
    [onClose, handleSearch]
  );

  const findPrevious = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    handleSearch(true);
  }, [handleSearch]);

  const findNext = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    handleSearch(false);
  }, [handleSearch]);

  const restoreCursor = useCallback(() => {
    if (!needsCursorRestoreRef.current) return;
    needsCursorRestoreRef.current = false;
    const input = searchBoxRef.current;
    if (input) {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }, []);

  const runDebouncedSearch = useCallback(async () => {
    if (!searchBoxRef.current) return;
    await handleSearch(false, true);
    // Mark for cursor restore on next keypress (keeps find highlight visible)
    needsCursorRestoreRef.current = true;
  }, [handleSearch]);

  const searchAfterFirstChar = useDebouncedCallback(
    runDebouncedSearch,
    kFirstCharDebounceMs
  );
  const searchAfterTyping = useDebouncedCallback(
    runDebouncedSearch,
    kDebounceMs
  );
  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const [run, cancel] =
      e.target.value.length === 1
        ? [searchAfterFirstChar, searchAfterTyping]
        : [searchAfterTyping, searchAfterFirstChar];
    cancel.cancel();
    run();
  };

  const restoreCursorIfNeeded = useCallback(() => {
    const input = searchBoxRef.current;
    if (!input) return;
    // Only restore when the caret sits collapsed at position 0 — the
    // telltale of window.find() having stolen the selection. A caret the
    // user placed mid-text (or a selection they made) must stay put.
    if (
      input.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      input.value.length > 0
    ) {
      restoreCursor();
    } else {
      needsCursorRestoreRef.current = false;
    }
  }, [restoreCursor]);

  const handleBeforeInput = useCallback(() => {
    restoreCursorIfNeeded();
  }, [restoreCursorIfNeeded]);

  // Consolidated global keyboard handler
  // eslint-disable-next-line tsmono/no-raw-use-effect -- baselined at rule introduction; migrate to a named hook or derived state
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      // F3: Find next/previous
      if (e.key === "F3") {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSearch(e.shiftKey);
        return;
      }

      // Ctrl/Cmd+F: Focus search box (block browser find).
      if (isFindShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        searchBoxRef.current?.focus();
        searchBoxRef.current?.select();
        return;
      }

      // Ctrl/Cmd+G: Find next/previous
      if (isFindNextShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSearch(e.shiftKey);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Delete")
        return;

      const input = searchBoxRef.current;
      if (!input) return;

      if (document.activeElement !== input) {
        // Don't steal focus from another editable surface — users typing
        // into a textarea/input/contenteditable should keep their keystrokes.
        if (isEditableTarget(deepActiveElement())) return;

        // Typing from outside the input appends, so an unconditional
        // restore-to-end is right here; a caret inside the focused input
        // gets the position-0 guard instead.
        restoreCursor();
        input.focus();
      } else {
        restoreCursorIfNeeded();
      }
    };

    document.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [handleSearch, restoreCursor, restoreCursorIfNeeded]);

  return (
    <FindBandUI
      inputRef={searchBoxRef}
      onClose={onClose}
      onNext={findNext}
      onPrevious={findPrevious}
      onKeyDown={handleKeyDown}
      onBeforeInput={handleBeforeInput}
      onChange={handleInputChange}
      noResults={sourced ? sourced.total === 0 && sourced.complete : noResults}
      matchCount={sourced ? sourced.total : (matchCount ?? undefined)}
      matchIndex={currentMatchIndex > 0 ? currentMatchIndex - 1 : undefined}
      countIncomplete={sourced ? !sourced.complete : false}
    />
  );
};
// `Window.find` is a non-standard but widely-supported API not in lib.dom.
// Typed optional so hosts without it degrade to "No results" (via the
// extended-find path) instead of throwing mid-search.
declare global {
  interface Window {
    find?(
      searchTerm?: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrapAround?: boolean,
      wholeWord?: boolean,
      searchInFrames?: boolean,
      showDialog?: boolean
    ): boolean;
  }
}

function windowFind(searchTerm: string, back: boolean): boolean {
  return (
    window.find?.(
      searchTerm,
      findConfig.caseSensitive,
      back,
      findConfig.wrapAround,
      findConfig.wholeWord,
      findConfig.searchInFrames,
      findConfig.showDialog
    ) ?? false
  );
}

function positionSelectionForWrap(back: boolean): void {
  if (!back) return;
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

async function findExtendedInDOM(
  searchTerm: string,
  back: boolean,
  lastFoundItem: {
    text: string;
    offset: number;
    parentElement: Element | null;
  } | null,
  extendedFindTerm: (
    term: string,
    direction: "forward" | "backward"
  ) => Promise<boolean>
) {
  let result = false;
  let hasTriedExtendedSearch = false;
  let extendedSearchSucceeded = false;
  const maxAttempts = 25;

  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    result = windowFind(searchTerm, back);

    if (result) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const isUnsearchable = inUnsearchableElement(range);
        const isSameAsLast = isLastFoundItem(range, lastFoundItem);

        if (!isUnsearchable && !isSameAsLast) {
          break;
        }

        if (isSameAsLast) {
          if (!hasTriedExtendedSearch) {
            hasTriedExtendedSearch = true;
            window.getSelection()?.removeAllRanges();

            const foundInVirtual = await extendedFindTerm(
              searchTerm,
              back ? "backward" : "forward"
            );

            if (foundInVirtual) {
              extendedSearchSucceeded = true;
              await waitForTextInDOM(searchTerm);
              continue;
            }
          }

          if (extendedSearchSucceeded) {
            // Extended search scrolled to new content but old match is still in DOM.
            // Collapse past it so windowFind advances to the new match.
            const sel = window.getSelection();
            if (sel?.rangeCount) {
              sel.getRangeAt(0).collapse(!back);
            }
          } else {
            window.getSelection()?.removeAllRanges();
            positionSelectionForWrap(back);
          }

          result = windowFind(searchTerm, back);
          if (result) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const r = sel.getRangeAt(0);
              if (inUnsearchableElement(r)) {
                continue;
              }
            }
          }
          break;
        }
      }
    } else if (!hasTriedExtendedSearch) {
      hasTriedExtendedSearch = true;
      window.getSelection()?.removeAllRanges();

      const foundInVirtual = await extendedFindTerm(
        searchTerm,
        back ? "backward" : "forward"
      );

      if (foundInVirtual) {
        extendedSearchSucceeded = true;
        await waitForTextInDOM(searchTerm);
        continue;
      }

      positionSelectionForWrap(back);
      result = windowFind(searchTerm, back);
      if (result) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          if (inUnsearchableElement(r)) {
            continue;
          }
        }
      }
      break;
    } else {
      break;
    }
  }

  if (result) {
    const sel = window.getSelection();
    if (sel?.rangeCount && inUnsearchableElement(sel.getRangeAt(0))) {
      sel.removeAllRanges();
      result = false;
    }
  }

  return result;
}

/**
 * The nearest element to a range's start. Null only for a detached range —
 * commonAncestorContainer is often a text node, hence the walk up.
 */
function rangeParentElement(range: Range): Element | null {
  const ancestor = range.commonAncestorContainer;
  return (
    range.startContainer.parentElement ??
    (ancestor instanceof Element ? ancestor : ancestor.parentElement)
  );
}

function isLastFoundItem(
  range: Range,
  lastFoundItem: {
    text: string;
    offset: number;
    parentElement: Element | null;
  } | null
) {
  if (!lastFoundItem) return false;

  const currentText = range.toString();
  const currentOffset = range.startOffset;
  const currentParentElement = rangeParentElement(range);

  return (
    currentText === lastFoundItem.text &&
    currentOffset === lastFoundItem.offset &&
    currentParentElement === lastFoundItem.parentElement
  );
}

function inUnsearchableElement(range: Range) {
  let element: Element | null = selectionParentElement(range);

  // Check if this match is inside an unsearchable element
  let isUnsearchable = false;
  while (element) {
    if (
      element.hasAttribute("data-unsearchable") ||
      getComputedStyle(element).userSelect === "none"
    ) {
      isUnsearchable = true;
      break;
    }
    element = element.parentElement;
  }
  return isUnsearchable;
}

function selectionParentElement(range: Range) {
  let element: Element | null;

  if (range.startContainer instanceof Element) {
    // This is a direct element
    element = range.startContainer;
  } else {
    // This isn't an element, try its parent
    element = range.startContainer.parentElement;
  }

  // Still not found, try the common ancestor container
  if (!element && range.commonAncestorContainer instanceof Element) {
    element = range.commonAncestorContainer;
  } else if (!element && range.commonAncestorContainer.parentElement) {
    element = range.commonAncestorContainer.parentElement;
  }
  return element;
}

/**
 * Polls until the search term appears in a searchable (non-unsearchable) DOM
 * text node. After the virtual list scrolls an item into view, the
 * onContentReady callback may fire before the content is actually rendered,
 * especially for large scroll distances. This ensures we wait for the text
 * to be present before calling window.find().
 */
function waitForTextInDOM(
  searchTerm: string,
  timeoutMs = 2000
): Promise<boolean> {
  const lowerTerm = searchTerm.toLowerCase();

  const isTextInSearchableDOM = () => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          let el = node.parentElement;
          while (el) {
            if (el.hasAttribute("data-unsearchable")) {
              return NodeFilter.FILTER_REJECT;
            }
            el = el.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.toLowerCase().includes(lowerTerm)) {
        return true;
      }
    }
    return false;
  };

  return new Promise((resolve) => {
    const interval = 50;
    let elapsed = 0;

    const check = () => {
      if (isTextInSearchableDOM()) {
        resolve(true);
        return;
      }
      elapsed += interval;
      if (elapsed >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, interval);
    };

    check();
  });
}
