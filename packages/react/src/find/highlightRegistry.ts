// Shared registry over the CSS Custom Highlight API. CSS.highlights is a
// page-global map, so rows can't each own a Highlight object — instead they
// contribute/retract Range sets keyed by an id and the registry rebuilds the
// two named highlights ("find-match" for every occurrence, "find-active"
// for the active occurrence in the active row).

export const FIND_MATCH_HIGHLIGHT = "find-match";
export const FIND_ACTIVE_HIGHLIGHT = "find-active";

interface Contribution {
  matches: Range[];
  active: Range | null;
}

const contributions = new Map<string, Contribution>();

export function supportsCustomHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function rebuild(): void {
  if (!supportsCustomHighlights()) return;
  const matchRanges: Range[] = [];
  const activeRanges: Range[] = [];
  for (const c of contributions.values()) {
    matchRanges.push(...c.matches);
    if (c.active) activeRanges.push(c.active);
  }
  setNamedHighlight(FIND_MATCH_HIGHLIGHT, matchRanges);
  setNamedHighlight(FIND_ACTIVE_HIGHLIGHT, activeRanges);
}

// Ranges are added one by one: a spread constructor call caps out at the
// engine's argument limit (tens of thousands of ranges).
function setNamedHighlight(name: string, ranges: Range[]): void {
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  const highlight = new Highlight();
  for (const range of ranges) highlight.add(range);
  CSS.highlights.set(name, highlight);
}

export function setHighlightContribution(
  id: string,
  matches: Range[],
  active: Range | null
): void {
  if (matches.length === 0 && active === null) {
    clearHighlightContribution(id);
    return;
  }
  contributions.set(id, { matches, active });
  rebuild();
}

export function clearHighlightContribution(id: string): void {
  if (!contributions.delete(id)) return;
  rebuild();
}

const FLASH_CLASS = "find-flash";

/** Briefly flash an element (the never-silent-jump fallback): used when
 *  Custom Highlights are unsupported, or when the active occurrence isn't in
 *  the row's rendered text. The `.find-flash` rule in the shared theme
 *  stylesheet owns the animation; the class comes off when it ends. */
export function flashElement(el: Element): void {
  if (el.classList.contains(FLASH_CLASS)) {
    // Re-adding the class in the same frame wouldn't restart the animation;
    // replaying the running one does.
    for (const animation of el.getAnimations()) {
      animation.cancel();
      animation.play();
    }
    return;
  }
  el.classList.add(FLASH_CLASS);
  el.addEventListener("animationend", () => el.classList.remove(FLASH_CLASS), {
    once: true,
  });
}
