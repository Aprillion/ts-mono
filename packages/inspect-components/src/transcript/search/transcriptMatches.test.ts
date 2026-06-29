import { describe, expect, it } from "vitest";

import {
  buildMatchList,
  matchIndexFromField,
  type SearchField,
} from "./transcriptMatches";

// Pure match-model tests (see design/transcript-find-spec.md). No DOM: the
// manifest is supplied directly as an ordered list of renderable fields, and
// `buildMatchList` must preserve that order and enumerate variant occurrences
// per the spec. Offsets are UTF-16 code-unit indices into each field's `text`.

const field = (
  partial: Partial<SearchField> & Pick<SearchField, "fieldKey" | "text">
): SearchField => ({
  eventId: "e1",
  rowKey: "main",
  fieldIndex: 0,
  ...partial,
});

describe("buildMatchList — ordering", () => {
  it("emits matches in manifest order, fields then occurrences left-to-right", () => {
    const manifest: SearchField[] = [
      field({ eventId: "e1", fieldKey: "user", fieldIndex: 0, text: "find the cat then the cat" }),
      field({ eventId: "e1", fieldKey: "output", fieldIndex: 0, text: "cat" }),
      field({ eventId: "e2", fieldKey: "output", fieldIndex: 0, text: "a cat" }),
    ];
    const matches = buildMatchList(manifest, "cat");
    expect(
      matches.map((m) => [m.eventId, m.fieldKey, m.start, m.end])
    ).toEqual([
      ["e1", "user", 9, 12], // "find the [cat] then the cat"
      ["e1", "user", 22, 25], // "...then the [cat]"
      ["e1", "output", 0, 3],
      ["e2", "output", 2, 5],
    ]);
  });

  it("preserves a field's identity (rowKey/eventId/fieldIndex) on every match", () => {
    const manifest: SearchField[] = [
      field({ eventId: "e7", rowKey: "researcher", fieldKey: "output", fieldIndex: 2, text: "xx" }),
    ];
    const [m] = buildMatchList(manifest, "x");
    expect(m).toMatchObject({ eventId: "e7", rowKey: "researcher", fieldKey: "output", fieldIndex: 2 });
  });
});

describe("buildMatchList — variants", () => {
  it("is case-insensitive with offsets into the original text", () => {
    const matches = buildMatchList([field({ fieldKey: "output", text: "The CAT sat" })], "cat");
    expect(matches.map((m) => [m.start, m.end])).toEqual([[4, 7]]);
  });

  it("takes the longest variant and never overlaps: quoted term in quoted text", () => {
    // text is the 5 chars: " f o o " (quote, foo, quote). Literal `"foo"`
    // matches [0,5]; unquoted `foo` matches [1,4]; longest (literal) wins.
    const matches = buildMatchList([field({ fieldKey: "output", text: '"foo"' })], '"foo"');
    expect(matches).toHaveLength(1);
    expect([matches[0]!.start, matches[0]!.end, matches[0]!.variant]).toEqual([0, 5, "simple"]);
  });

  it("matches the unquoted variant when only it is present", () => {
    const matches = buildMatchList([field({ fieldKey: "output", text: "a foo b" })], '"foo"');
    expect(matches.map((m) => [m.start, m.end, m.variant])).toEqual([[2, 5, "unquoted"]]);
  });

  it("emits no matches for an empty or absent term", () => {
    expect(buildMatchList([field({ fieldKey: "output", text: "abc" })], "")).toEqual([]);
    expect(buildMatchList([field({ fieldKey: "output", text: "abc" })], "zzz")).toEqual([]);
  });
});

describe("matchIndexFromField — selection validation", () => {
  const manifest: SearchField[] = [
    field({ eventId: "e1", fieldKey: "user", fieldIndex: 0, text: "cat cat" }),
    field({ eventId: "e2", fieldKey: "output", fieldIndex: 0, text: "cat" }),
  ];
  const matches = buildMatchList(manifest, "cat"); // e1[0,3], e1[4,7], e2[0,3]

  it("returns the 0-based ordinal for an exact identity + range", () => {
    expect(matchIndexFromField(matches, { eventId: "e1", fieldKey: "user", fieldIndex: 0, start: 4, end: 7 })).toBe(1);
    expect(matchIndexFromField(matches, { eventId: "e2", fieldKey: "output", fieldIndex: 0, start: 0, end: 3 })).toBe(2);
  });

  it("returns null when the range or identity does not match a counted match", () => {
    expect(matchIndexFromField(matches, { eventId: "e1", fieldKey: "user", fieldIndex: 0, start: 1, end: 4 })).toBeNull();
    expect(matchIndexFromField(matches, { eventId: "e9", fieldKey: "output", fieldIndex: 0, start: 0, end: 3 })).toBeNull();
  });
});
