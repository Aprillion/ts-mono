/** Non-overlapping occurrences of the folded `term` in the folded `text`. */
export const countOccurrences = (text: string, term: string): number => {
  if (term.length === 0) return 0;
  let count = 0;
  for (
    let at = text.indexOf(term);
    at !== -1;
    at = text.indexOf(term, at + term.length)
  ) {
    count++;
  }
  return count;
};

export const rowMatchCounts = (
  rows: readonly (readonly string[])[],
  term: string
): number[] =>
  rows.map((texts) =>
    texts.reduce((sum, text) => sum + countOccurrences(text, term), 0)
  );

export interface RowOccurrence {
  rowIndex: number;
  /** 0-based within the row. */
  occurrence: number;
}

export const locateOrdinal = (
  counts: readonly number[],
  ordinal: number
): RowOccurrence | null => {
  if (ordinal < 1) return null;
  let remaining = ordinal;
  for (let rowIndex = 0; rowIndex < counts.length; rowIndex++) {
    const count = counts[rowIndex] ?? 0;
    if (remaining <= count) return { rowIndex, occurrence: remaining - 1 };
    remaining -= count;
  }
  return null;
};
