import { describe, expect, it } from "vitest";

import {
  countOccurrences,
  locateOrdinal,
  rowMatchCounts,
} from "./messagesFind";

describe("messagesFind", () => {
  it("counts non-overlapping occurrences and guards the empty term", () => {
    expect(countOccurrences("needle needle", "needle")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("needle", "")).toBe(0);
  });

  it("sums a row's texts", () => {
    expect(
      rowMatchCounts(
        [["needle", "no"], [], ["needle needle", "needle"]],
        "needle"
      )
    ).toEqual([1, 0, 3]);
  });

  it("maps an ordinal to its row and in-row occurrence", () => {
    const counts = [0, 2, 1];
    expect(locateOrdinal(counts, 1)).toEqual({ rowIndex: 1, occurrence: 0 });
    expect(locateOrdinal(counts, 2)).toEqual({ rowIndex: 1, occurrence: 1 });
    expect(locateOrdinal(counts, 3)).toEqual({ rowIndex: 2, occurrence: 0 });
    expect(locateOrdinal(counts, 4)).toBeNull();
    // 1-based: there is no ordinal 0, and a leading empty row must not answer
    // for it with occurrence -1.
    expect(locateOrdinal(counts, 0)).toBeNull();
    expect(locateOrdinal(counts, -1)).toBeNull();
  });
});
