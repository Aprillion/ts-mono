const kNonAscii = /[\u0080-\uffff]+/g;
const kMarks = /\p{M}/gu;

/**
 * The one fold Find applies to counted text, rendered text, the term and
 * ExpandablePanel's auto-expand, matching a browser's find-in-page: NFKD,
 * combining marks dropped, lowercased (İstanbul and café match "istanbul"
 * and "cafe"). Final ς is folded to σ, the one lowercase mapping that
 * depends on context, so folding code point by code point (as the painter
 * does to map offsets) gives the same text as folding a whole string.
 */
export const foldText = (text: string): string =>
  text
    .replace(kNonAscii, (run) => run.normalize("NFKD").replace(kMarks, ""))
    .toLowerCase()
    .replaceAll("ς", "σ");
