// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  fieldSelectionFromRange,
  findFieldElement,
  rangeForOffsets,
} from "./searchDomAdapter";

// DOM adapter core: maps between the (DOM-free) match model and the rendered
// DOM. Tested against a SYNTHETIC annotated DOM (no real renderer), since the
// renderer's job is only to put these attributes on the right elements (its own
// contract test covers that). Offsets are UTF-16 indices into the annotated
// element's textContent; ranges may span split text nodes (markdown emits
// nested spans).

function annotated(
  eventId: string,
  fieldKey: string,
  fieldIndex: number,
  html: string
): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("data-search-event-id", eventId);
  el.setAttribute("data-search-field-key", fieldKey);
  el.setAttribute("data-search-field-index", String(fieldIndex));
  el.innerHTML = html;
  return el;
}

describe("findFieldElement", () => {
  it("locates the annotated element by exact identity", () => {
    const root = document.createElement("div");
    const a = annotated("e1", "output", 0, "first");
    const b = annotated("e1", "user", 0, "second");
    root.append(a, b);
    expect(findFieldElement(root, { eventId: "e1", fieldKey: "user", fieldIndex: 0 })).toBe(b);
  });

  it("returns null when no element has that identity", () => {
    const root = document.createElement("div");
    root.append(annotated("e1", "output", 0, "x"));
    expect(
      findFieldElement(root, { eventId: "e1", fieldKey: "user", fieldIndex: 3 })
    ).toBeNull();
  });
});

describe("rangeForOffsets", () => {
  it("builds a Range over [start,end] in textContent across split text nodes", () => {
    // textContent === "answer here"
    const el = annotated("e1", "output", 0, "an<b>sw</b>er here");
    document.body.append(el);
    expect(rangeForOffsets(el, 0, 6)?.toString()).toBe("answer");
    expect(rangeForOffsets(el, 7, 11)?.toString()).toBe("here");
  });

  it("returns null for out-of-bounds offsets", () => {
    const el = annotated("e1", "output", 0, "short");
    document.body.append(el);
    expect(rangeForOffsets(el, 3, 99)).toBeNull();
  });
});

describe("fieldSelectionFromRange", () => {
  it("round-trips identity + offsets from a range inside an annotated field", () => {
    const el = annotated("e7", "output", 2, "alpha beta");
    document.body.append(el);
    const r = rangeForOffsets(el, 6, 10)!; // "beta"
    expect(fieldSelectionFromRange(r)).toEqual({
      eventId: "e7",
      fieldKey: "output",
      fieldIndex: 2,
      start: 6,
      end: 10,
    });
  });

  it("returns null for a selection outside any annotated field (chrome)", () => {
    const chrome = document.createElement("div");
    chrome.textContent = "Model Call:";
    document.body.append(chrome);
    const r = document.createRange();
    r.selectNodeContents(chrome);
    expect(fieldSelectionFromRange(r)).toBeNull();
  });
});
