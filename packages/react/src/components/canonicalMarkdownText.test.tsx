// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { canonicalMarkdownText } from "./canonicalMarkdownText";
import { MarkdownDiv } from "./MarkdownDiv";

// The render contract (design/transcript-find-spec.md): a markdown field's
// canonical searchable text MUST equal the textContent the UI actually renders,
// so find offsets map into the rendered DOM. `canonicalMarkdownText` runs the
// SAME pipeline MarkdownDiv uses (renderMarkdown -> sanitize -> post-process)
// off-DOM; this test pins that equivalence so the two can never drift.

describe("canonicalMarkdownText === MarkdownDiv settled textContent", () => {
  it.each([
    ["plain", "just plain text"],
    ["bold+italic", "**bold** and _italic_ words"],
    ["link", "see the [docs](https://example.com) please"],
    ["inline code", "use the `find` command"],
    ["list", "- alpha\n- beta\n- gamma"],
    ["heading + paragraph", "# Title\n\nbody paragraph here"],
    ["blockquote", "> quoted line"],
  ])("matches for %s", async (_label, md) => {
    const expected = await canonicalMarkdownText(md);

    const { container } = render(<MarkdownDiv markdown={md} />);
    // MarkdownDiv shows escaped-raw first, then async-swaps the rendered HTML;
    // wait until its visible text settles to the canonical text.
    await waitFor(() => {
      expect(container.textContent).toBe(expected);
    });

    // And the canonical text is the searchable text, not the markdown source.
    expect(expected).not.toContain("**");
    expect(expected.length).toBeGreaterThan(0);
  });

  it("returns the empty string for empty markdown", async () => {
    expect((await canonicalMarkdownText("")).trim()).toBe("");
  });
});
