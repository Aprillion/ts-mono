# Transcript find-in-page — behavioral spec

Source of truth for the find/search rework. Tests encode this; the
implementation must satisfy it. (Revised after neutral review.)

## Purpose

Find-in-page over a sample's transcript and the other sample tabs. The
transcript renders one agent **swimlane** at a time, virtualizes rows, and can
collapse event panels.

## Sources and scope of the invariant

A **source** owns matching for the content currently in a tab:
- The **transcript** is a *selecting source*: it owns a canonical, ordered
  match list, selects the exact occurrence, and reports its ordinal.
- The **Messages** tab uses a scroll-only `VirtualList`; **static** tabs
  (Scoring/Metadata/JSON) have no source.

Exactly one source is **active** at a time (the visible tab). Counter/ordinal
state resets on source change. The hard invariant below is REQUIRED of the
selecting source. For scroll-only/static content the UI shows an
**unknown-ordinal** state (a "no N-of-M" affordance), never a number that can
lie — i.e. those tabs must not display an ordinal that isn't validated against a
counted match.

## Hard invariant (selecting source)

**The "X of N" counter always equals the position of the currently-highlighted
match.** At rest after any navigation, ordinal `i` is shown **iff** the i-th
match (match order below) is the one highlighted/visible in the DOM. The count
and the highlight are the same enumeration. A DOM selection must be **validated**
to map back to a counted match before the counter updates; if it doesn't map,
the counter does not change (and such a selection is never produced by our own
navigation).

## The field manifest (keystone)

The renderer and the matcher MUST share one **field manifest** so they cannot
drift. For a given sample the manifest is the ordered list of searchable
**fields** that are *renderable/revealable* for the active source — including
fields in virtualized rows, collapsed panels, and inactive event tabs that are
not mounted right now but have a reveal path. Each field carries its identity
and canonical text `{ eventId, rowKey, fieldKey, fieldIndex, text }` plus, at
the **adapter layer**, how to reveal it (see below). The **pure matcher** takes
only the identity+text — it never models reveal mechanics; revealability lives
with the DOM adapter, which knows the reveal path per field identity.

- The matcher builds the match list ONLY from the manifest (never from a
  separate data extractor that could disagree with what's rendered).
- `text` is the canonical searchable text of that field. **Render contract:**
  once revealed, the field's single canonical DOM element's `textContent`
  equals `text` exactly (so offsets map to a Range). This equality across
  markdown, syntax highlighting, expandable/tabbed panels, and Summary/Messages
  duplication is the riskiest contract — tests must assert it.
- **Markdown fields** (message text, model output, reasoning, …) are NOT raw —
  the UI renders them through markdown. So `text` for a markdown field is the
  `textContent` produced by the SAME pipeline `MarkdownDiv` uses
  (`renderMarkdown` → `sanitizeRenderedHtml` → post-process), run off-DOM via a
  shared `canonicalMarkdownText(markdown, renderer)` helper that lives beside
  the markdown renderer (NOT a hand-rolled stripper). Because that pipeline is
  async and `MarkdownDiv` shows escaped-raw then swaps in final HTML, the
  manifest text for markdown fields is computed async, and the adapter must
  wait for the field's final render and verify `textContent === text` before
  selecting. **Fail closed:** a field whose canonical text cannot be reproduced
  and later verified (e.g. MathJax/SVG/async-only content) is NOT in the
  manifest — never count a match you cannot then select exactly.
- The renderer annotates the canonical element with its identity
  (`data-search-event-id`, `data-search-field-key`, `data-search-field-index` —
  separate attributes). DOM annotations are how the adapter *locates/validates*
  a mounted field after reveal; they are NOT the source of the full manifest.
- A field rendered in more than one place (e.g. Summary vs Messages) declares
  exactly one **canonical** annotated element; duplicates are not annotated.

**Content vs chrome is field-level, not "the whole title".** Title/header
*values* are content and ARE fields: the model name in `Model Call: gpt-4`
(field `model` = `gpt-4`), the tool title/function, step name, info source.
Only the static label/prefix/suffix around them ("Model Call:", role headers
USER/ASSISTANT, tab labels, token/time, icons, outline, sample heading) is
chrome and is never a field.

## Match order

- Across events: the sample's **event/document order** (chronological; lanes
  interleave as events occur).
- Within an event: the **manifest order** (= rendered display order).
- Next wraps N→1, Prev 1→N.

## Coverage / revealability

- Every counted match is reachable by stepping (1→N→1).
- **Fail-closed field scope.** A field is in the manifest ONLY if its canonical
  text can be reproduced off-DOM AND verified to equal the rendered element's
  `textContent` at select time. Initially that is: plain-text fields (model
  name, tool function, step name, error/traceback) verbatim, and plain markdown
  body fields via `canonicalMarkdownText`. Fields whose rendered text the
  renderer transforms in ways not yet reproduced off-DOM (citation injection,
  JSON pretty-printing, reasoning special-casing, images) are EXCLUDED until
  their canonicalization is added — never counted-but-unselectable. Coverage
  grows field-kind by field-kind; the invariant holds for whatever is in scope.
- A field is counted ONLY if the adapter can **reveal** it: scroll the
  virtualized row in, switch lane, switch tab, expand the panel / "show all
  messages" / compact tool call / nested child, then await layout. Content that
  cannot be revealed (no addressable reveal path, events without a usable id,
  hidden/filtered event types) is NOT in the manifest, hence not counted.
- Navigation reveals first, then selects; it never selects `display:none` text
  and reports it as active.

## Variants (exact algorithm for tests)

- Offsets `start/end` are **UTF-16 code-unit indices into the field's original
  `text`** (not the folded text). Matching is case-insensitive via lowercasing
  both needle and haystack; lowercasing must be length-preserving per code unit
  for the offsets to map (it is for the ASCII/BMP terms in practice; document
  that surrogate-pair/locale-special-casing terms are out of scope).
- Variant set: **reuse `prepareSearchTerm` from `@tsmono/util` exactly as-is**
  (it is the existing chat counter's behavior — keep it identical, do not
  "improve" it). It returns the lower-cased literal (`simple`), and when the
  term contains a `"` or `:` also an all-quotes-stripped form (`unquoted`) and a
  JSON-escaped form (`jsonEscaped`). Build the distinct set of those variant
  strings in that order; drop empty.
- Enumeration within one field's `text`: scan left-to-right; at each index take
  the **longest** matching variant (so `"foo"` in `"foo"` yields one match at
  `[0,5]` for the literal, not an overlapping `[1,4]`); on an equal-length tie
  take the **first in variant order** (literal, then unquoted, then jsonEscaped,
  after de-dupe); advance past it by its length; never emit overlapping matches.
  Each emitted `Match` records the variant and `{start,end}` of the occurrence.
- The selector selects exactly that occurrence (same `{start,end}` in the
  canonical element). A selection Range may span split text nodes within it.

## Stepping behavior

- Typing (debounced) resolves the first match in order and, via the selecting
  source, reveals + selects it while the find input stays focused (Chrome shows
  that selection greyed/inactive). The ordinal becomes "1 of N" once settled.
- The first Enter after typing **promotes the same match**: it repaints it as
  the active highlight (blurs the input so Chrome stops greying it). It does NOT
  advance — same ordinal. Subsequent Enter / Shift+Enter / F3 / Ctrl+G /
  Prev / Next **step** to the next/previous match.
- For the selecting source, navigation/typing must NOT use native `window.find`
  (it can select chrome and desync); selection is always produced via the
  manifest field element + offsets.
- Staleness: every navigation is tagged with the active
  `(source, sampleId, manifest-generation, searchId)`. **manifest-generation**
  increments whenever the manifest's fields or their revealability can change —
  i.e. on a change to the sample's events/rows, the active filter, the active
  tab/source, or the sample itself. A stale async reveal/select (tab switch,
  sample change, superseded search, new term, regenerated manifest) must not
  move the selection or counter — even if the term is unchanged.

## Module boundary

Pure, DOM-free **match model** (subagent rebuilds this from spec + tests):
- `SearchField` (the matcher's input) is identity + text only:
  `{ eventId, rowKey, fieldKey, fieldIndex, text }` — NO reveal modelling.
- `buildMatchList(manifest, term): Match[]` — ordered (document order across
  events, manifest order within); content-only by construction; variant-aware
  via `prepareSearchTerm` from `@tsmono/util`. Each `Match`:
  `{ rowKey, eventId, fieldKey, fieldIndex, variant, start, end }` where
  `start/end` are offsets into that field's canonical `text`.
- `matchIndexFromField(matches, { eventId, fieldKey, fieldIndex, start, end }):
  number | null` — pure lookup validating a selection back to an ordinal; null
  if no counted match has exactly that identity+range.

DOM adapter (kept/adapted glue; verified via Playwright harness, not pure unit
tests): builds the manifest from the event/render model; reveals a match's
field (scroll/lane/tab/expand via its own reveal map keyed by field identity);
maps `{fieldEl, start, end}` to a `Range` and sets the
selection; validates the resulting live selection via `matchIndexFromField`
before reporting an ordinal. On validation failure for our own navigation it
must NOT report success or leave a stale ordinal — it restores the previously
validated selection (or shows the unknown-ordinal state), never a number that
doesn't match the highlight.

Render contract (mechanical, DOM-testable): each searchable field renders one
canonical element carrying the three `data-search-*` attributes; the element's
text equals the manifest field `text`.

## Out of scope (keep as-is)

FindBandUI rendering, the reveal/caret mechanics, the dark-flash/loading fixes,
the header-phantom `data-unsearchable`, the dead-code removal, cross-lane scroll
plumbing (adapted, not rewritten).
