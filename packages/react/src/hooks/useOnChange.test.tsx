// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOnChange } from "./useOnChange";

describe("useOnChange", () => {
  it("calls the latest handler after commits where the value changed, not on mount", () => {
    const seen: string[] = [];
    const Probe = ({ value, tag }: { value: string; tag: string }) => {
      useOnChange(value, (next) => seen.push(`${tag}:${next}`));
      return null;
    };

    const { rerender } = render(<Probe value="a" tag="t1" />);
    expect(seen).toEqual([]);

    rerender(<Probe value="a" tag="t2" />);
    expect(seen).toEqual([]);

    rerender(<Probe value="b" tag="t3" />);
    expect(seen).toEqual(["t3:b"]);
  });
});
