# Find on the Messages tab

**Status:** implemented (Messages tab). Server side: inspect_ai
`design/find-messages.md`.

cmd+f on the Messages tab is answered by the backend, not the DOM. The
backend says **which rows match and roughly how many times**; the rendered
row says **exactly where**. Everything else in the viewer (transcript, JSON,
scoring, metadata, the log list) keeps its previous find path.

## Wire contract

`LogViewAPI.find_messages?` (optional member — absent, the Messages tab
registers no find surface and the band behaves as on any tab without one).
The view server implements it as `POST /api/find-messages/{log}`; hawk
supplies its own through `setApiFactory`.

```
request  { sample_id, epoch, text, direction: "forward" | "backward",
           cursor?: { anchor }, limit,
           projection?: { unlabeled_roles?: string[],
                          tool_call_style?: "complete" | "compact" | "omit",
                          display_mode?: "rendered" | "raw" } }
response { rows: { anchor, index, count, texts }[],
           total: { rows, occurrences, relation: "eq" | "gte" },
           complete }
```

- Matching is case- and diacritic-insensitive literal substring over the
  row's **projected** text: the text the tab renders it from under the same
  projection (unlabeled roles, tool call style, and display mode — `raw`
  searches the markdown source, `rendered` the source with markdown syntax
  stripped). `texts` are the exact substrings of that projected text that
  matched (not capped); `count` is how often; `index` is the
  row's 0-based position in the conversation, so a paged surface can load
  through a row it has not fetched yet.
- Rows come **in the direction of travel**, strictly past the cursor anchor:
  a backward page is nearest-first. `limit` is a row cap, 1–1000; the view
  server rejects anything else (422) and the client never exceeds it.
- Each page's `total` is **that page** (row/occurrence counts of the
  response). `relation: "gte"` until a request walks off a **sealed** source;
  the client sums pages and the band shows M+ until then. `complete: false`
  is a live sample (also M+). A page stops at `limit` or ~50ms after the
  first match so the first hits paint while the rest of the scan continues.

**Anchor rule** (`messageRowAnchorIds`, mirrored by the server): a row's
anchor is its head message id verbatim — the fold mints `msg-{index}` for a
message with none — unless a *prior row* was assigned that string, in which
case `#rowIndex` is appended, again while the result is already assigned.
Only prior rows' anchors collide (never folded tool message ids, never later
rows), so anchors are stable under live append:
`[dup, dup#2, dup, "", "", #4]` → `[dup, dup#2, dup#2#2, "", #4, #4#5]`;
`[a, a, a#1]` → `[a, a#1, a#1#2]`.

## Client

Coordinator (`@tsmono/react/find`: `FindStore`, `FindProvider`,
`useFindSurface`, `useFindHighlights`) plus one surface: `ChatViewVirtualList`
registers when its host passes `findMessages` (inspect's `SampleDisplay`
adapts `api.find_messages` in `messagesFind.ts`); scout's chat lists don't.

**Window.** A term change surveys forward (1000 rows — the view server's
  page maximum) and keeps that page as the window. While `total.relation` is
  `gte`, further pages accumulate M only (they do not grow the window to the
  whole hit set). Stepping inside the window is local; stepping past an edge
  issues a cursor page (200 rows); past a proven universe edge it re-windows
  from the opposite end. The page sizes are guesses bounded by the server's
  cap. A wrap's page is folded into M (or replaces M when that page is
  `eq`); a 1-row survey must not stay as "N of 1" against a suffix window.

**Sealed-page LRU.** Inspect's `messagesFindSource` caches sealed POST
  pages (128, a guess) keyed by log, sample, term, cursor, direction, limit,
  and projection. Backspace to a term whose pages already finished does not
  POST again. Live samples (`complete: false`) are not stored. A term never
  paused on is still a miss — the cache does not derive `"use"` from `"user"`.
  Typing waits 500ms on a lone first letter and 300ms from the second, so a
  query still being typed does not survey each prefix; Enter searches now.
  A live (`complete: false`) page drops that sample's sealed cache entries.

**One fetch at a time.** Steps taken while a page is in flight accumulate as
a signed count (Enter +1, Shift+Enter -1) and apply when the page commits, so
mashed Enter past a wrap lands on 1, 2, 3, … and Enter during the survey lands
on 1 of M. A count that nets to zero before a re-window page commits drops
that page (the window and position stay). A term change aborts the fetch and
drops the count; a data change re-surveys and applies the count after
relocating the active row.

**In-row stepping is DOM-true where the DOM exists.** A mounted row attaches
to the coordinator and reports its DOM match count (the matches of
`new RegExp(texts.map(escape).join("|"), "gu")` over its text nodes, chrome
marked `data-find-chrome` excluded) once its markdown has rendered, and
withdraws it while markdown is re-rendering; the step count inside a row is
that count while the row is mounted and reporting, the server count
otherwise. Enter walks every DOM match of the active row before moving to the
next row (Shift+Enter mirrors, entering a row at its last match). A row with
zero DOM matches (the projected text differs from the rendered one, e.g.
`foo__bar__baz` shown as `foobarbaz`, or a tool view that summarizes its
arguments) flashes and is skipped; its count is forgotten when it unmounts, so a stale zero
never skips a row.

**"N of M".** M is the server total, never rewritten from the DOM. N = source
counts of the rows before the active one + the DOM index clamped to the
active row's source count + 1; extra DOM matches don't raise N. N is known
from whichever universe edge the window touches (the end only under an exact
total) and null while the active row renders no match.

**Highlighting.** Every DOM occurrence of the row's `texts` is painted
through the CSS Custom Highlight API (`::highlight(find-match)`, the active
one `::highlight(find-active)`; up to 1000 ranges per row); the active one is
centred through the virtualizer once its markdown has rendered
(`data-markdown-pending`) and its range has a box — the list's post-commit
row measurement re-runs the reveal. The list's own jump only brings the row
into the rendered band (`align: "auto"`: no scroll when it is already in
view) — it can aim at the row, not the occurrence — so a row that mounts
already active centres its occurrence unconditionally, once the list has
measured the band it mounted (a target computed while rows sit at estimated
sizes is moved by the correction, and clamped short at the list end); a step
onto a mounted row's occurrence scrolls only when that occurrence is out of
view. Collapsed panels (`ExpandablePanel`)
expand when the active occurrence sits below the fold (`data-find-anchor`
plus `rangeExceedsFold`), not merely because some other window text is in
the panel; they mount collapsed and decide before paint, never
expanded-then-collapsed, so the centre target is computed against the
layout that stays. A closed `<details>` around the active
occurrence is opened before centring (it lays out nothing while closed).
Without Custom Highlights the row flashes.

**Live and paginated samples.** The list passes its rows as the surface's
data key: a data change re-surveys the term, keeping the current window on
screen until the new page lands, then relocates the active row by anchor
(clamping the occurrence, no reveal — a live append never yanks the view).
The re-survey runs from the top while that page holds the active row (N
stays known); an active row beyond it — after a wrap to the end of a
>1000-row universe — is re-surveyed from a cursor at its predecessor (for a
window's first row, the anchor the window itself follows), so it stays in
the window poll after poll instead of snapping to the top page's last row;
a row that stopped matching hands over to the nearest matching row by
`index`, else the first match, which is revealed. A page that fails leaves an
empty, coherent state (no rows, no total, no pending steps). Paginated
(chunked) samples are searched whole by the server; a match beyond the loaded
prefix is paged in through its `index` (the list's own load-more) and then
scrolled to.

## Why not

- **`window.find` / DOM search** — virtualized rows aren't in the DOM; the
  retry/poll machinery it needed was the bug.
- **GET so the browser cache stores pages** — live samples must not cache,
  hawk auth is part of the key, and cursor+projection are an awkward query
  string. Sealed pages are reused in the inspect adapter's LRU instead.
- **Occurrences or offsets on the wire** — they pin the server to the DOM's
  text; rows + literal variants let the DOM decide.
- **Any fold in JS** — `RegExp` `u`+`i` is simple case folding only
  (İstanbul/straße/café don't match their typed forms); `Intl.Collator`
  compares whole strings, not substrings. The server folds once
  (`NFKD` → drop marks → `casefold`).
- **A FIFO of step operations** — a signed count gives the same 1, 2, 3 past
  a wrap; an opposite step during a fetch cancels instead of waiting its
  turn, which is what a user correcting an overshoot wants.
- **Waiting for a mounted row's DOM report before stepping inside it** — the
  report lands in the same layout effect that mounts the row; a step in the
  gap uses the server count and the report clamps it, no hold needed.
- **Relocating a row beyond the survey page through a cursor page from its
  former neighbour** — a second round trip for a window of more than 1000
  matching rows; nearest-by-index lands next door.
