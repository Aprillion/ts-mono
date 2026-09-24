import { describe, expect, it } from "vitest";

import { foldText } from "./findFold";

describe("foldText", () => {
  it("folds like a browser's find: case, marks and compatibility forms", () => {
    expect(foldText("İstanbul")).toBe("istanbul");
    expect(foldText("café")).toBe("cafe");
    expect(foldText("café")).toBe("cafe");
    expect(foldText("ﬁsh")).toBe("fish");
    expect(foldText("ΟΔΟΣ ΟΔΟΣ")).toBe("οδοσ οδοσ");
    // Final sigma folds to σ, so the two spellings meet on one form.
    expect(foldText("οδοσ οδος")).toBe("οδοσ οδοσ");
    expect(foldText("Plain ASCII")).toBe("plain ascii");
  });

  it("gives the same text per code point and as a whole", () => {
    const raw = "İstanbul ﬁ café ΟΔΟΣ";
    expect(Array.from(raw, foldText).join("")).toBe(foldText(raw));
  });
});
