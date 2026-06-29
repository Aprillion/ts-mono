import {
  FC,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useExtendedFind, useFindTargetSetter } from "@tsmono/react/components";
import { debounce } from "@tsmono/util";

import { useStore } from "../state/store";
import { findScrollableParent, scrollRangeToCenter } from "../utils/dom";

import { FindBandUI } from "./FindBandUI";

const findConfig = {
  caseSensitive: false,
  wrapAround: false,
  wholeWord: false,
  searchInFrames: false,
  showDialog: false,
};

export const FindBand: FC = () => {
  const searchBoxRef = useRef<HTMLInputElement>(null);
  const storeHideFind = useStore((state) => state.appActions.hideFind);
  const { extendedFindTerm, countAllMatches } = useExtendedFind();
  const setFindTarget = useFindTargetSetter();
  const lastFoundItem = useRef<{
    text: string;
    offset: number;
    parentElement: Element;
  } | null>(null);
  // The DOM range of the match found during typing. Refocusing the input after
  // the search clears the document selection, so a later "reveal" can't just
  // blur — it re-asserts this range to repaint the active highlight.
  const lastFoundRange = useRef<Range | null>(null);
  const currentSearchTerm = useRef<string>("");
  const needsCursorRestoreRef = useRef<boolean>(false);
  // Whether the current match has been "revealed" (input blurred so the native
  // selection renders as the active, not greyed-out, highlight) since the term
  // last changed. Lets the first Enter after typing reveal the already-found
  // match instead of skipping past it to the next one.
  const revealedRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const focusTimeoutRef = useRef<number | null>(null);
  const searchIdRef = useRef(0);
  const debouncedSearchRef = useRef<
    ((() => void) & { cancel: () => void }) | null
  >(null);
  const cachedCount = useRef<{ term: string; count: number }>({
    term: "",
    count: 0,
  });
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  // Tracks whether the most recent search returned no result, separate
  // from `matchCount`. On tabs that don't register a search source
  // (Scoring/Metadata/JSON) the counter is unknown but `window.find` may
  // still succeed — we use this flag for the "No results" UI instead.
  const [noResults, setNoResults] = useState(false);

  const handleSearch = useCallback(
    async (back = false, reveal = false) => {
      // Explicit navigation pre-empts any in-flight typing search so a trailing
      // debounced run can't refocus the input and undo the reveal.
      if (reveal) {
        debouncedSearchRef.current?.cancel();
      }
      const thisSearchId = ++searchIdRef.current;

      const searchTerm = searchBoxRef.current?.value ?? "";
      if (!searchTerm) {
        setMatchCount(null);
        setCurrentMatchIndex(0);
        setNoResults(false);
        setFindTarget(null);
        revealedRef.current = false;
        lastFoundRange.current = null;
        return;
      }

      const termChanged = currentSearchTerm.current !== searchTerm;
      if (termChanged) {
        lastFoundItem.current = null;
        lastFoundRange.current = null;
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
      if (cachedCount.current.term === searchTerm) {
        total = cachedCount.current.count;
      } else {
        total = countAllMatches(searchTerm);
        cachedCount.current = { term: searchTerm, count: total };
      }
      setMatchCount(total > 0 ? total : null);

      const focusedElement = document.activeElement as HTMLElement;
      // Capture the input's caret before the find: window.find moves the
      // document selection, dropping the input's own selection, so a plain
      // refocus afterwards lands the caret at 0. We restore it synchronously
      // below (typing path) so the caret never visibly jumps while typing.
      const inputEl = searchBoxRef.current;
      const caretStart =
        inputEl && focusedElement === inputEl ? inputEl.selectionStart : null;
      const caretEnd =
        inputEl && focusedElement === inputEl ? inputEl.selectionEnd : null;

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
          const parentElement =
            range.startContainer.parentElement ||
            (range.commonAncestorContainer as Element);
          const isNewMatch = !isLastFoundItem(range, lastFoundItem.current);
          lastFoundItem.current = {
            text: range.toString(),
            offset: range.startOffset,
            parentElement,
          };
          lastFoundRange.current = range.cloneRange();

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

      if (reveal && result) {
        // Explicit navigation that found a match. Drop focus out of the input:
        // a focused page input greys out the document's find selection, so the
        // matched text only renders as the ACTIVE highlight once the input is
        // blurred (this is the highlight bug on main, where Enter refocuses the
        // input). window.find also resets the input caret, so arm restoreCursor
        // for when the user resumes typing.
        searchBoxRef.current?.blur();
        needsCursorRestoreRef.current = true;
        revealedRef.current = true;
      } else {
        // Typing path, or an explicit search with no match: keep focus in the
        // input (so a no-result term can be corrected without refocusing) and
        // restore the caret synchronously so it never jumps to 0 between
        // keystrokes (the search-as-you-type caret bug).
        focusedElement?.focus();
        revealedRef.current = false;
        if (inputEl && caretStart !== null && caretEnd !== null) {
          inputEl.setSelectionRange(caretStart, caretEnd);
        }
      }
    },
    [setFindTarget, extendedFindTerm, countAllMatches]
  );

  useEffect(() => {
    focusTimeoutRef.current = window.setTimeout(() => {
      searchBoxRef.current?.focus();
      searchBoxRef.current?.select();
    }, 10);

    const scrollTimeout = scrollTimeoutRef.current;
    const focusTimeout = focusTimeoutRef.current;

    return () => {
      if (scrollTimeout !== null) {
        window.clearTimeout(scrollTimeout);
      }
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout);
      }
      setFindTarget(null);
    };
  }, [setFindTarget]);

  const revealCurrentMatch = useCallback(() => {
    debouncedSearchRef.current?.cancel();
    const range = lastFoundRange.current;
    if (
      !range ||
      range.collapsed ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    ) {
      // The typing-time match was detached/collapsed by a re-render (e.g. a
      // panel auto-expanding around the term), so there's nothing to
      // re-select — run a fresh reveal search instead.
      void handleSearch(false, true);
      return;
    }
    // Blur first so the input no longer owns focus, then re-assert the match
    // range: refocusing the input after the typing search dropped the document
    // selection, so a bare blur would reveal nothing. Re-adding it while the
    // body is focused paints it as the active (not greyed) highlight.
    searchBoxRef.current?.blur();
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    needsCursorRestoreRef.current = true;
    revealedRef.current = true;
  }, [handleSearch]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        storeHideFind();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // First plain Enter after typing reveals the match found during typing
        // (greyed-out while the input has focus) rather than skipping to the
        // next; subsequent Enters step. Shift+Enter always steps backward. Only
        // reveal when the box still holds the already-searched term — otherwise
        // a fast edit-then-Enter would reveal the previous term's stale match,
        // so fall through to a fresh search.
        if (
          !revealedRef.current &&
          lastFoundItem.current &&
          !e.shiftKey &&
          searchBoxRef.current?.value === currentSearchTerm.current
        ) {
          revealCurrentMatch();
        } else {
          void handleSearch(e.shiftKey, true);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        void handleSearch(e.shiftKey, true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        searchBoxRef.current?.focus();
        searchBoxRef.current?.select();
      }
    },
    [storeHideFind, handleSearch, revealCurrentMatch]
  );

  const findPrevious = useCallback(() => {
    void handleSearch(true, true);
  }, [handleSearch]);

  const findNext = useCallback(() => {
    void handleSearch(false, true);
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
    // handleSearch restores the caret synchronously on the typing path, so no
    // deferred restore is armed here (it would force the caret to the end,
    // breaking mid-text edits). The deferred restoreCursor is only for resuming
    // typing after a reveal blurred the input.
    await handleSearch(false);
  }, [handleSearch]);

  // Created in an effect (not useMemo) because runDebouncedSearch reads refs,
  // and the compiler can't prove debounce() won't invoke it during render.
  useEffect(() => {
    debouncedSearchRef.current = debounce(() => void runDebouncedSearch(), 100);
  }, [runDebouncedSearch]);

  const handleInputChange = useCallback(() => {
    debouncedSearchRef.current?.();
  }, []);

  const handleBeforeInput = useCallback(() => {
    const input = searchBoxRef.current;
    if (input) {
      const hasSelection = input.selectionStart !== input.selectionEnd;
      if (!hasSelection) {
        restoreCursor();
      }
    }
  }, [restoreCursor]);

  // Consolidated global keyboard handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      // F3: Find next/previous
      if (e.key === "F3") {
        e.preventDefault();
        void handleSearch(e.shiftKey, true);
        return;
      }

      // Ctrl/Cmd+F: Focus search box (block browser find)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        searchBoxRef.current?.focus();
        searchBoxRef.current?.select();
        return;
      }

      // Ctrl/Cmd+G: Find next/previous (Shift = previous; normalize case so the
      // Shift+G that reports as uppercase "G" still matches after a reveal blur).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.stopPropagation();
        void handleSearch(e.shiftKey, true);
        return;
      }

      // Enter after a reveal: the input is blurred, so a follow-up Enter lands
      // on document.body — keep stepping matches from that post-blur state, but
      // never steal Enter from a focused button/link/input/contenteditable.
      if (e.key === "Enter") {
        const active = document.activeElement;
        if (!active || active === document.body) {
          e.preventDefault();
          void handleSearch(e.shiftKey, true);
        }
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
        // Pierce shadow roots: document.activeElement only returns the shadow
        // host, so walk down to find the real focused element.
        let active: Element | null = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        const isEditable =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable);
        if (isEditable) return;
      }

      const hasSelection = input.selectionStart !== input.selectionEnd;
      if (!hasSelection) {
        restoreCursor();
      }

      if (document.activeElement !== input) {
        input.focus();
      }
    };

    document.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [handleSearch, restoreCursor]);

  return (
    <FindBandUI
      inputRef={searchBoxRef}
      onClose={storeHideFind}
      onNext={findNext}
      onPrevious={findPrevious}
      onKeyDown={handleKeyDown}
      onBeforeInput={handleBeforeInput}
      onChange={handleInputChange}
      noResults={noResults}
      matchCount={matchCount ?? undefined}
      matchIndex={
        matchCount !== null && matchCount > 0
          ? currentMatchIndex - 1
          : undefined
      }
    />
  );
};
// `Window.find` is a non-standard but widely-supported API not in lib.dom.
declare global {
  interface Window {
    find(
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
  return window.find(
    searchTerm,
    findConfig.caseSensitive,
    back,
    findConfig.wrapAround,
    findConfig.wholeWord,
    findConfig.searchInFrames,
    findConfig.showDialog
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
    parentElement: Element;
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

function isLastFoundItem(
  range: Range,
  lastFoundItem: {
    text: string;
    offset: number;
    parentElement: Element;
  } | null
) {
  if (!lastFoundItem) return false;

  const currentText = range.toString();
  const currentOffset = range.startOffset;
  const currentParentElement =
    range.startContainer.parentElement ||
    (range.commonAncestorContainer as Element);

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
  let element: Element | null = null;

  if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
    // This is a direct element
    element = range.startContainer as Element;
  } else {
    // This isn't an element, try its parent
    element = range.startContainer.parentElement;
  }

  // Still not found, try the common ancestor container
  if (
    !element &&
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
  ) {
    element = range.commonAncestorContainer as Element;
  } else if (!element && range.commonAncestorContainer.parentElement) {
    element = range.commonAncestorContainer.parentElement;
  }
  return element;
}

/**
 * Polls until the search term appears in a searchable (non-unsearchable) DOM
 * text node. After Virtuoso scrolls a virtual list item into view, the
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
