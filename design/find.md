# Find: band, source and painter

The find band (`packages/react/src/components/FindBand.tsx`) runs one engine over a `FindSource`
(`ExtendedFindContext.tsx`) when the mounted tab registers one; tabs without a source keep the `window.find`
path in the same component. The band owns the term, the 1-based active ordinal n, stepping and wrap. A source
owns which of its rows match, how many times, how to bring a row on screen, and — as `scopeId` — what document
it is searching: `count(term)` returns
`{total, complete}` and `reveal(term, n, onLanded)` hands back a `FindLanding` (row element, occurrence k
within it, a `scrollBy`) or null. The painter (`findPainter.ts`) owns the ranges in every mounted row and
centring the active one. The Messages tab's source is `useMessagesFindSource` in
`packages/inspect-components/src/chat/`. The provider holds the registered source as React state; the band
re-renders when it changes and reads `source.count(term)` during render, so the counter is derived, not stored.
`showFind` is app state and two routes render a band over it (`SampleDetailComponent` and `LogViewLayout`),
so the close on a tab, sample or epoch change lives once in `InlineSampleDisplay`. Both routes mount that
component to show the sample being searched (B49, K125). `useOnChange` there hides the band; the band's own
safety net is `scopeId`, which no host has to remember: a source that registers for a different document (or
no source at all) empties the band. It is what covers scout, which has no equivalent hook, and the paths
that unmount the sample view without passing through the hook. A source that registers before the band
mounts is seeded on the band's first render, not through `useOnChange`, which does not fire on mount.
Two rules decided in B112: Shift+Enter at 1 on an
incomplete count means the true last match (K124), and a tab or sample change hides the band (K125).

## Corpus and fold

- Corpus (K1): the row of ordinal n comes from the data text (`messageSearchText`), and the occurrence k
  within that row comes from the rendered text of the row element, so the two corpora must hold the same
  occurrences in the same order. Both directions of a mismatch are bugs, and the second is the worse one: a
  data occurrence the DOM lacks paints no active range and says nothing (B48 minor, the counter keeps n),
  while a DOM occurrence the data lacks shifts k for every later occurrence in that row, so the active
  highlight lands on the wrong one. The data side therefore mirrors what a row renders, block by block and in
  document order: the role heading, then the content, then each tool call followed by its own output. A call
  block contributes its header, its summary, its input zone (the call's `view` when it has one), and then
  either the output well or the error. `toolCallSearchText` builds those from the same `resolveToolInput`,
  `substituteToolCallContent` and `resolveToolMessage` the renderer calls. A tool whose custom view replaces
  the block is mirrored by that view instead: the `answer` tool contributes its call line, and the `submit`
  tool contributes its answer once, which is why its output well is not counted a second time.
  Rendered text the data side cannot reproduce is taken out of the DOM corpus with `data-unsearchable`
  instead, so neither corpus holds it: the position chips (`MessageLabel`, an ordinal ornament with no
  counterpart in the message), the timestamp (formatted by a host-supplied `formatDateTime`), and any custom
  tool view the corpus does not mirror. Both sides ask one function which view a block renders
  (`defaultCustomToolView`, `kMirroredCustomViews`), so "the same views are hidden from both" holds by
  construction rather than by hand. The row's display mode and tool-call style are mirrored too: raw mode
  renders no custom view and reshapes no Codex output, and `compact` or `omit` count what that style shows.
  `messageCorpus.test.tsx` renders a row and asserts, for each term, the same sequence of occurrences with
  the same text unit and offset — a corpus entry on one side, a DOM text node on the other, so an agreement
  is also evidence the two are cut the same way. It does not check offsets under a fold that changes lengths;
  its fixtures are ASCII.

  Two divergences are known and NOT fixed. **Markdown is unmirrored**: content and tool output render through
  `MarkdownDiv`/`MessageContent` while the corpus emits the raw source, so `[docs](http://example.com/needle)`
  is counted with occurrences of `needle` and `http` that the DOM never shows, and paints one occurrence of
  `docs` that the data never holds; fence markers are counted and never painted. Every occurrence
  after one of those in the row gets the wrong `k`. The server-side projection this feature came from had a
  markdown-stripping step; the client has none, and every fixture is plain text. Second, server `tool_use`
  content blocks render through `ServerToolCall` and are emitted as the tool name plus `JSON.stringify` of
  its arguments. A host that supplies `renderToolCall` is the benign direction: its view is unsearchable
  while the corpus still counts the block, so matches go unpainted (B48) rather than shifting `k`.
- Fold (K7, assumption K119): one fold for count, paint, term and `ExpandablePanel`'s auto-expand, matching a
  browser's find: NFKD, combining marks dropped, `toLowerCase`, final ς folded to σ so per-node and
  whole-string folds agree (`foldText` in `findFold.ts`; the server's `textsearch.fold_text` is the same
  recipe with casefold). The painter maps folded offsets back to raw code units per code point; ASCII text is
  the identity map. A term that covers only part of a code point's expansion ("f" over "ﬁ") still counts as a
  match, and its range rounds outwards to the whole code point — an empty range would take the active slot
  and paint nothing. Combining marks, which fold away, stay inside the range that precedes them.

## States and events

States: **closed**; **empty** (open, no term); **term** (n of M, or n of M+ while `complete` is false);
**pending** (an ordinal past the loaded rows, or "last", waiting for the source to re-register). A new term
reveals 1 forward and M backward. An ordinal past M becomes pending when M is incomplete (`loadMore` if
offered) and wraps to 1 when complete; backward below 1 goes to M when complete and to pending "last" when
not. M = 0 and complete → "No results", highlights cleared; M = 0 and incomplete → pending, status blank. The
FindTarget term is set on every term change and cleared with the band.

| event | empty | term (n of M / M+) | pending (n′ requested) |
|---|---|---|---|
| typed, after debounce (500 ms for a 1-char term, 300 ms longer) | new term | unchanged term: nothing; other term: new term; empty: → empty, highlights and FindTarget cleared | pending dropped, then as term |
| Enter | new term | n < M → reveal n+1; n = M complete → reveal 1 (wrap); n = M incomplete → pending n+1, `loadMore` | replaces n′ with a step from the last revealed n |
| Shift+Enter | new term | n > 1 → reveal n−1; n = 1 complete → reveal M; n = 1 incomplete → pending "last": `loadMore` on every re-register until complete, then reveal M (K124) | as Enter, backwards |
| Esc | → closed | → closed: painter cleared, FindTarget null, in-flight landing ignored (R1) | → closed, pending dropped |
| source re-registered (more rows) | nothing | counter re-derived from the new source; n and view unchanged | n′ ≤ M′ → reveal n′; else incomplete → `loadMore`, stay pending; else complete → reveal M′ for "last", 1 for a finite n′, "No results" when M′ = 0 |
| tab, sample or epoch change | → closed | → closed (SampleDetailComponent hides the band; K125) | → closed |
| source registered with a new `scopeId` (another sample, result or log) | nothing | → empty: term, ordinal, pending, highlights and FindTarget dropped, the input cleared | → empty |
| source unregistered otherwise | nothing | → empty, as above; until one registers again the next search takes the `window.find` path | → empty |
| landing arrived (element, k) | — | paint every occurrence in every mounted row, the landed row's k-th active when rendered; centre it if outside the scroller (delta in DOM px, scaled for the virtualizer, R2) | as term (a landing from before the pending step) |
| landing null (row not rendered, or user input during the landing, R5) | — | painter cleared; counter unchanged (R3) | as term |
| user input on the scroller | — | later rebuilds only repaint; no re-centring until the next reveal | as term |
| mutation under the rows container (childList or characterData, R4): a row's markdown swap, a row mounted or unmounted by the virtualizer | — | ranges rebuilt for every mounted row, the active one from the landed row's current element (`landing.element()`); re-centre if the active range is off screen and no user input since the landing | as term |

A term's first reveal goes through the list; a later reveal of the same term to a mounted row (`rowElement(i)`
non-null) hands the painter the landing at once, inside the Enter handler, and the painter scrolls only if the
k-th occurrence is outside the scroller. "First" is per band, not per source: re-registering (paging, backfill)
keeps it, and the FindTarget going to null resets it, because closing the band collapses the panels again.
An unmounted row is aligned `start`, then the painter centres the occurrence if it is off screen.
virtual-core's `align: "auto"` is not used: a row taller than the scroller always resolves to "end", so a
same-row step scrolled to the row's end and back.

## Ordering of one reveal (Enter on a row that is not rendered)

1. Enter is a discrete event. The band sets the FindTarget term (same tick) when the term changed and calls
   `source.reveal(term, n, onLanded)`. The source maps n to (row i, occurrence k) from its per-row counts and
   calls `listHandle.scrollToIndex({index: i, align: "start", onDone})`. The chat list passes
   `smoothScroll={false}`, so this is `settleScrollToIndex` in `VirtualList.tsx`.
2. `settleScrollToIndex`, synchronously: `virtualizer.scrollToIndex(i)` computes the target from estimated
   sizes (400 px per unmeasured row), writes scrollTop through `scrollToFn`, sets
   `virtualizer.scrollState = {index: i, align, startedAt}` and schedules `reconcileScroll` for the next
   animation frame. Row i is not in the DOM yet.
3. The scroll event updates the virtualizer's offset and re-renders `VirtualList` with a range that includes i;
   the row's `ref={measureElement}` callback runs in that commit and `resizeItem` gets its real height. Rows
   entirely above the viewport shift scrollTop by their estimate error (our override of
   `shouldAdjustScrollPositionOnItemSizeChange`: `item.end <= scrollOffset`); row i spans the viewport, so not.
4. Same commit, before paint: `MarkdownDiv` mounts with escaped text and `ExpandablePanel` mounts expanded
   because a FindTarget exists; passive effects collapse panels whose text lacks the term and enqueue the async
   markdown render (flushed synchronously for a discrete event, in a scheduler task for the debounced path,
   still inside step 5's window). Their "more" toggles appear later from each panel's own ResizeObserver and
   can resize rows after step 6.
5. Next animation frame: virtual-core's `reconcileScroll` and the settle loop both re-derive the target from the
   now-measured sizes and write scrollTop again if it moved. The settle loop re-issues `scrollToIndex(i)` every
   frame and stops after three frames where scrollTop moved at most 1 px (or 30 frames). Each write re-creates
   `scrollState`, so the index anchor is alive throughout; layout work in this window restarts the count. User
   input in this window ends the loop with `onDone(null)`.
6. `finish()`: `lastAutoScrollTopRef` is set, the auto-scroll guard release is booked for the next frame, then
   `onDone(rowElement)` runs synchronously with the element `virtualizer.elementsCache` holds for i. Final
   here: row i's box, panel expansion, the sizes of rows in the viewport. Not final: the markdown HTML inside
   row i.
7. `onDone` → `onLanded({element, occurrence: k, scrollBy})` → band → `painter.paint(landing, term)`. The
   painter takes the element's parent as the rows container, or keeps the previous container when the row is
   not mounted so that the row is repainted when it mounts, and for each of the container's children walks the
   text
   nodes (TreeWalker, skipping `data-unsearchable`), folds each into one stream with node start offsets (so
   `foo <strong>bar</strong>` matches "foo bar"), builds one Range per occurrence and adds all to the
   `find-match` Highlight; the landed row's k-th goes to `find-active` (both created once: the registry is
   document-global). Then it calls `scrollBy(delta)` with the delta that centres the active rect if it is
   outside the scroller's client box.
8. `listHandle.scrollBy(delta)` → `scrollVirtualizerBy`: target = `(el.scrollTop + delta) × scale`, clamped by
   `getOffsetForAlignment`, written through `virtualizer.scrollToOffset`, then `virtualizer.scrollOffset` is set
   to the target. `scrollToOffset` replaces `scrollState` with `{index: null, lastTargetOffset}`, so the index
   anchor from step 2 is gone and a later size change of row i cannot pull the view back to the row's centre.
   Setting the cache guards virtual-core's offset cache, which only updates from the scroll event a frame after
   a write: a ResizeObserver callback in the frame of our write runs `resizeItem` → `applyScrollAdjustment`,
   which rewrites scrollTop as cached offset + delta and would discard the write (the typed path hit this on a
   real log, where the FindTarget change resizes panels around onDone). `applyScrollAdjustment` sets the cache
   the same way for its own writes; the compensation then shifts our position by the delta.
9. Up to about 450 ms later the markdown promise resolves, `setRenderedHtml` re-renders `MarkdownDiv` and its
   innerHTML is replaced. Live Ranges inside it collapse and paint nothing. The painter's MutationObserver
   (childList and characterData, subtree, on the rows container) fires as a microtask after the mutating
   script, rebuilds the ranges of every mounted row and, if the active rect is now outside the scroller and no
   user input has been seen, scrolls again as in step 8. Each rebuild is idempotent. A rebuild of 8 rows
   with 2.8k–5.6k ranges took 6–8 ms in Chromium and 28–58 ms in Firefox, where the time is
   `Highlight.add` of every range, so recomputing only the mutated rows does not shorten it and
   `Highlight.delete` of a row's ranges costs seconds. Centring from a mount effect was rejected because it
   runs inside the settle window of step 5 and is overwritten.
10. Stop condition: the painter listens for wheel, pointerdown, keydown and touchmove on the scroller once per
    paint; the first one flips `userScrolled` and later rebuilds only repaint. The next paint resets it. The
    scroller is the nearest ancestor already overflowing by 100 px, so a short one resolves to null; the
    painter re-resolves it before each centring, when the rows that made it overflow are mounted.
11. Known, not handled: closing the band does not cancel the settle loop of step 5. R1 covers the painter, so
    Enter then Esc paints nothing, but the view still travels to the row the Enter asked for. Cancelling it
    would need a cancel on `VirtualListHandle` and an owner for it on the band's unmount.
12. Not observed by the painter: a panel expanding after onDone without a DOM mutation. Expansion is driven by
    the FindTarget term set in step 1 and resolved in step 4, before the settle ends. A change that sets the
    term after reveal must add attribute observation.
13. Paging (rows a loaded prefix) or a feed still loading (rows=[] on tab remount, live backfill): `count`
    reports `complete: false`. When rows change the chat list registers a new source object; the band sees it
    as new context state and finishes a pending step per the table. Letting the source drain pages on its own
    was rejected because the band holds the ordinal that decides when enough rows arrived.

Known live gap (review T3): a live sample regrouping rows can shrink M below n−1; the live commit owns it.

Geometry is final at onDone for everything but markdown-rendered blocks, and after the last mutation for
those; it is not final between step 2 and finish() (estimates) or inside row i before the markdown swap.

Still in place for the tabs without a source (Transcript, Scoring, Metadata, JSON) and for scout's lists: the
`window.find` driver, `findExtendedInDOM` and `waitForTextInDOM` in `FindBand.tsx`, the caret restore, and the
`registerVirtualList` / `registerMatchCounter` registries. `useTranscriptSearchSource` feeds them, and so does
every `VirtualList` that does not opt out with `findScope="none"` — that default is what lets a list reach a
match in a row it has never rendered. A list that registers a `FindSource` opts out: the band never takes the
legacy path over it, and the default accessor would otherwise re-`JSON.stringify` every row on every change.
They go when those lists get sources.
