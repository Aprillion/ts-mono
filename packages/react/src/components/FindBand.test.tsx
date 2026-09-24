// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FC, ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRegistration } from "../hooks/useRegistration";
import { testIcons } from "../test/test-icons";

import { ComponentIconProvider } from "./ComponentIconContext";
import {
  ExtendedFindProvider,
  useExtendedFind,
  type FindLanding,
  type FindSource,
} from "./ExtendedFindContext";
import { FindBand } from "./FindBand";
import {
  FindTargetProvider,
  useFindTarget,
  type FindTarget,
} from "./FindTargetContext";

const Providers: FC<{ children: ReactNode }> = ({ children }) => (
  <ComponentIconProvider icons={testIcons}>
    <ExtendedFindProvider>
      <FindTargetProvider>{children}</FindTargetProvider>
    </ExtendedFindProvider>
  </ComponentIconProvider>
);

const MatchCounter: FC<{ count: number }> = ({ count }) => {
  const { registerMatchCounter } = useExtendedFind();

  // eslint-disable-next-line tsmono/no-raw-use-effect -- baselined at rule introduction; migrate to a named hook or derived state
  useEffect(
    () => registerMatchCounter("find-band-test", () => count),
    [count, registerMatchCounter]
  );

  return null;
};

const SourceRegistration: FC<{ source: FindSource }> = ({ source }) => {
  const { registerFindSource } = useExtendedFind();
  useRegistration(registerFindSource, source);
  return null;
};

/** A source over `rowCounts` matches per row (per term when a map is given)
 *  whose reveal lands synchronously on the one mounted row, an element
 *  holding `rendered` occurrences of the term. */
const fakeSource = (
  rowCounts: number[] | Record<string, number[]>,
  options: { complete?: boolean; rendered?: number; scopeId?: string } = {}
) => {
  const countsOf = (term: string) =>
    Array.isArray(rowCounts) ? rowCounts : (rowCounts[term] ?? []);
  const totalOf = (term: string) =>
    countsOf(term).reduce((sum, count) => sum + count, 0);
  const rows = document.createElement("div");
  document.body.append(rows);
  const reveal = vi.fn(
    (
      term: string,
      ordinal: number,
      onLanded: (landing: FindLanding | null) => void
    ) => {
      const element = document.createElement("div");
      rows.replaceChildren(element);
      element.textContent = Array(options.rendered ?? 1)
        .fill(term)
        .join(" ");
      let remaining = ordinal;
      for (const count of countsOf(term)) {
        if (remaining <= count) break;
        remaining -= count;
      }
      onLanded({
        element: () => element,
        occurrence: remaining - 1,
        scrollBy: vi.fn(),
      });
    }
  );
  const loadMore = vi.fn();
  const source: FindSource = {
    scopeId: options.scopeId ?? "scope",
    count: (term) => ({
      total: totalOf(term),
      complete: options.complete ?? true,
    }),
    reveal,
    loadMore: options.complete === false ? loadMore : undefined,
  };
  return { source, reveal, loadMore };
};

const status = () => screen.getByTestId("find-band-match-count");
const statusText = () => status().textContent;

const renderFindBand = (onClose = vi.fn(), children?: ReactNode) => {
  render(
    <Providers>
      <FindBand onClose={onClose} />
      {children}
    </Providers>
  );
  const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
  input.value = "needle";
  return { input, onClose };
};

describe("FindBand", () => {
  let windowFind: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    windowFind = vi.fn(() => false);
    Object.defineProperty(window, "find", {
      configurable: true,
      value: windowFind,
    });
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const { input } = renderFindBand(onClose);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { key: "Enter", shiftKey: false, backwards: false },
    { key: "Enter", shiftKey: true, backwards: true },
    { key: "g", ctrlKey: true, shiftKey: false, backwards: false },
    { key: "g", ctrlKey: true, shiftKey: true, backwards: true },
    { key: "F3", shiftKey: false, backwards: false },
    { key: "F3", shiftKey: true, backwards: true },
  ])(
    "searches with backwards=$backwards for $key",
    async ({ key, ctrlKey, shiftKey, backwards }) => {
      const { input } = renderFindBand();

      fireEvent.keyDown(input, { key, ctrlKey, shiftKey });

      await waitFor(() => expect(windowFind).toHaveBeenCalled());
      expect(windowFind.mock.calls.every((call) => call[2] === backwards)).toBe(
        true
      );
    }
  );

  it("finds previous on Cmd+Shift+G when focus is outside the input", async () => {
    renderFindBand(vi.fn(), <div data-testid="outside">content</div>);

    // Shift makes e.key uppercase; the global handler must still match
    fireEvent.keyDown(document.body, {
      key: "G",
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() => expect(windowFind).toHaveBeenCalled());
    expect(windowFind.mock.calls.every((call) => call[2] === true)).toBe(true);
  });

  it("intercepts Cmd+F with CapsLock (uppercase key) instead of native find", () => {
    const { input } = renderFindBand();
    input.blur();

    const event = fireEvent.keyDown(document.body, {
      key: "F",
      metaKey: true,
    });

    // preventDefault called → returns false; native browser find is blocked
    expect(event).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  // Runs a debounced search to completion, which arms the cursor-restore flag
  const armCursorRestore = async (input: HTMLInputElement) => {
    fireEvent.change(input, { target: { value: "needles" } });
    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("restores the caret to the end when the browser reset it to 0", async () => {
    const { input } = renderFindBand();
    await armCursorRestore(input);

    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "x" });

    expect(input.selectionStart).toBe(input.value.length);
  });

  it("respects a user-placed mid-text caret after a search", async () => {
    const { input } = renderFindBand();
    await armCursorRestore(input);

    input.focus();
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: "x" });

    expect(input.selectionStart).toBe(2);
  });

  it("doesn't steal keystrokes from a focused select", () => {
    const { input } = renderFindBand(
      vi.fn(),
      <select data-testid="dropdown">
        <option>alpha</option>
        <option>beta</option>
      </select>
    );
    const dropdown = screen.getByTestId("dropdown");
    dropdown.focus();

    fireEvent.keyDown(dropdown, { key: "b" });

    expect(document.activeElement).toBe(dropdown);
    expect(document.activeElement).not.toBe(input);
  });

  it("shows no-results state when DOM and extended search both miss", async () => {
    const { input } = renderFindBand();

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
  });

  it("degrades to No results when window.find is unavailable", async () => {
    Object.defineProperty(window, "find", {
      configurable: true,
      value: undefined,
    });
    const { input } = renderFindBand();

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
  });

  it("skips searching when the typed term extends a known miss", async () => {
    const { input } = renderFindBand();

    fireEvent.change(input, { target: { value: "needles" } });
    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
    const callsAfterMiss = windowFind.mock.calls.length;

    fireEvent.change(input, { target: { value: "needlesX" } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(windowFind.mock.calls.length).toBe(callsAfterMiss);
    expect(screen.getByText("No results").style.visibility).toBe("visible");
  });

  it("re-searches a known miss on explicit Enter", async () => {
    const { input } = renderFindBand();

    fireEvent.change(input, { target: { value: "needles" } });
    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
    const callsAfterMiss = windowFind.mock.calls.length;

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(windowFind.mock.calls.length).toBeGreaterThan(callsAfterMiss)
    );
  });

  it("shows No results when a counter reports matches but the find misses", async () => {
    const { input } = renderFindBand(vi.fn(), <MatchCounter count={3} />);

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("No results").style.visibility).toBe("visible")
    );
    expect(screen.queryByText("0 of 3")).toBeNull();
  });

  it("refreshes the match count after counters re-register", async () => {
    windowFind.mockImplementation(() => {
      const textNode = screen.getByTestId("search-content").firstChild;
      if (!textNode) return false;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 6);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    });
    const ui = (count: number) => (
      <Providers>
        <FindBand onClose={vi.fn()} />
        <MatchCounter count={count} />
        <div data-testid="search-content">needle needle</div>
      </Providers>
    );
    const { rerender } = render(ui(2));
    const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
    input.value = "needle";

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeTruthy());

    // Content changed: the counter re-registers with a new total
    rerender(ui(5));
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText(/of 5/)).toBeTruthy());
  });

  it("shows the registered match count and current index", async () => {
    windowFind.mockImplementation(() => {
      const textNode = screen.getByTestId("search-content").firstChild;
      if (!textNode) return false;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 6);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    });
    const { input } = renderFindBand(
      vi.fn(),
      <>
        <MatchCounter count={2} />
        <div data-testid="search-content">needle needle</div>
      </>
    );

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("1 of 2").style.visibility).toBe("visible")
    );
  });

  describe("with a registered source", () => {
    class HighlightStub extends Set<Range> {
      priority = 0;
    }
    let registry: Map<string, HighlightStub>;
    const highlighted = (name: string) => registry.get(name)?.size ?? 0;
    beforeEach(() => {
      registry = new Map();
      vi.stubGlobal("CSS", { highlights: registry });
      vi.stubGlobal("Highlight", HighlightStub);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("steps ordinals through the source, wraps, and never calls window.find", async () => {
      const { source, reveal } = fakeSource([2, 1]);
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={source} />
      );

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 3"));
      expect(reveal).toHaveBeenLastCalledWith(
        "needle",
        1,
        expect.any(Function)
      );
      expect(highlighted("find-match")).toBe(1);
      expect(highlighted("find-active")).toBe(1);

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("3 of 3"));
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 3"));
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await waitFor(() => expect(statusText()).toBe("3 of 3"));
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await waitFor(() => expect(statusText()).toBe("2 of 3"));

      expect(reveal.mock.calls.map((call) => call[1])).toEqual([
        1, 2, 3, 1, 3, 2,
      ]);
      expect(windowFind).not.toHaveBeenCalled();
    });

    it("restarts at 1, or M backward, when the term changes and clears highlights for a miss", async () => {
      const { source, reveal } = fakeSource({
        needle: [1, 1],
        other: [1, 1, 1],
      });
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={source} />
      );
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2"));

      input.value = "other";
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await waitFor(() => expect(statusText()).toBe("3 of 3"));
      expect(reveal).toHaveBeenLastCalledWith("other", 3, expect.any(Function));
      expect(highlighted("find-active")).toBe(1);

      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2"));
      expect(reveal).toHaveBeenLastCalledWith(
        "needle",
        1,
        expect.any(Function)
      );

      source.count = () => ({ total: 0, complete: true });
      input.value = "missing";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("No results"));
      expect(highlighted("find-match")).toBe(0);
      expect(reveal).toHaveBeenCalledTimes(4);

      input.value = "";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(status().style.visibility).toBe("hidden"));
    });

    it("paints no active range for a counted occurrence the row does not render, without a label", async () => {
      const { source } = fakeSource([3], { rendered: 1 });
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={source} />
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 3"));
      expect(highlighted("find-active")).toBe(1);

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 3"));
      expect(highlighted("find-match")).toBe(1);
      expect(highlighted("find-active")).toBe(0);
    });

    it("clears the painter when a landing reports null", async () => {
      const { source, reveal } = fakeSource([2]);
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={source} />
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(highlighted("find-active")).toBe(1));

      reveal.mockImplementationOnce((_term, _ordinal, onLanded) =>
        onLanded(null)
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2"));
      expect(highlighted("find-match")).toBe(0);
    });

    it("clears the find target and ignores a landing after the band closed", async () => {
      const { source, reveal } = fakeSource([1]);
      const landings: (() => void)[] = [];
      const rows = document.createElement("div");
      document.body.append(rows);
      reveal.mockImplementation((term, _ordinal, onLanded) => {
        const element = document.createElement("div");
        element.textContent = term;
        rows.replaceChildren(element);
        landings.push(() =>
          onLanded({ element: () => element, occurrence: 0, scrollBy: vi.fn() })
        );
      });
      const targets: (FindTarget | null)[] = [];
      const TargetProbe: FC = () => {
        targets.push(useFindTarget());
        return null;
      };
      const ui = (open: boolean) => (
        <Providers>
          {open ? <FindBand onClose={vi.fn()} /> : null}
          <SourceRegistration source={source} />
          <TargetProbe />
        </Providers>
      );
      const { rerender } = render(ui(true));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 1"));
      landings.shift()?.();
      expect(highlighted("find-match")).toBe(1);
      expect(targets[targets.length - 1]).toEqual({
        term: "needle",
        eventId: "",
      });

      rerender(ui(false));
      expect(targets[targets.length - 1]).toBeNull();
      expect(highlighted("find-match")).toBe(0);
      // A landing still in flight when the band went away paints nothing.
      for (const land of landings) land();
      expect(highlighted("find-match")).toBe(0);
    });

    it("shows a loaded prefix as M+ and finishes the step once more rows register", async () => {
      const first = fakeSource([2], { complete: false, rendered: 2 });
      const ui = (source: FindSource) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(first.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2+"));

      // Past the loaded rows: the band asks for a page and waits.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();
      expect(statusText()).toBe("2 of 2+");

      const grown = fakeSource([2, 1], { complete: true, rendered: 2 });
      rerender(ui(grown.source));
      await waitFor(() => expect(statusText()).toBe("3 of 3"));
      expect(grown.reveal).toHaveBeenCalledWith(
        "needle",
        3,
        expect.any(Function)
      );

      // Exhausted rows wrap the pending step to the first match.
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 3"));
    });

    it("waits for a source that has no rows yet instead of reporting No results", async () => {
      const empty = fakeSource([], { complete: false });
      empty.source.loadMore = undefined;
      const ui = (source: FindSource) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(empty.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";

      fireEvent.keyDown(input, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(status().style.visibility).toBe("hidden");

      rerender(ui(fakeSource([2]).source));
      await waitFor(() => expect(statusText()).toBe("1 of 2"));
    });

    it("re-derives the counter from a re-registered source and blanks it when the source leaves", async () => {
      const { source } = fakeSource([2]);
      const ui = (source: FindSource | null) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          {source ? <SourceRegistration source={source} /> : null}
        </Providers>
      );
      const { rerender } = render(ui(source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2"));

      const more = fakeSource([2, 2]);
      rerender(ui(more.source));
      await waitFor(() => expect(statusText()).toBe("1 of 4"));
      expect(more.reveal).not.toHaveBeenCalled();

      rerender(ui(null));
      await waitFor(() => expect(status().style.visibility).toBe("hidden"));
      expect(statusText()).toBe("");
    });

    it("drops a pending step when the source leaves", async () => {
      const first = fakeSource([1], { complete: false });
      const ui = (source: FindSource | null) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          {source ? <SourceRegistration source={source} /> : null}
        </Providers>
      );
      const { rerender } = render(ui(first.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 1+"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();

      rerender(ui(null));
      const grown = fakeSource([1, 1]);
      rerender(ui(grown.source));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(grown.reveal).not.toHaveBeenCalled();
    });

    it("treats Shift+Enter at 1 on an incomplete count as the last match, loading until complete", async () => {
      const first = fakeSource([2], { complete: false, rendered: 2 });
      const ui = (source: FindSource) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(first.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2+"));
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(first.loadMore).toHaveBeenCalledOnce();
      expect(statusText()).toBe("1 of 2+");

      const middle = fakeSource([2, 1], { complete: false, rendered: 2 });
      rerender(ui(middle.source));
      await waitFor(() => expect(middle.loadMore).toHaveBeenCalledOnce());
      expect(middle.reveal).not.toHaveBeenCalled();

      const last = fakeSource([2, 1, 3], { complete: true, rendered: 3 });
      rerender(ui(last.source));
      await waitFor(() => expect(statusText()).toBe("6 of 6"));
      expect(last.reveal).toHaveBeenCalledWith(
        "needle",
        6,
        expect.any(Function)
      );
    });

    it("runs the typed term against a source that registers after a window.find miss", async () => {
      const ui = (source: FindSource | null) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          {source ? <SourceRegistration source={source} /> : null}
        </Providers>
      );
      const { rerender } = render(ui(null));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("No results"));

      const { source, reveal } = fakeSource([2]);
      rerender(ui(source));
      await waitFor(() => expect(statusText()).toBe("1 of 2"));
      expect(reveal).toHaveBeenCalledWith("needle", 1, expect.any(Function));
    });

    it("drops a pending step when the debounce re-fires the unchanged term", async () => {
      const first = fakeSource([2], { complete: false, rendered: 2 });
      const ui = (source: FindSource) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(first.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2+"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();

      // Typed and deleted again: one debounced fire with the same term.
      fireEvent.change(input, { target: { value: "needleX" } });
      fireEvent.change(input, { target: { value: "needle" } });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const grown = fakeSource([2, 1], { complete: true, rendered: 3 });
      rerender(ui(grown.source));
      await waitFor(() => expect(statusText()).toBe("2 of 3"));
      expect(grown.reveal).not.toHaveBeenCalled();
    });

    it("clears highlights when a pending step resolves to no matches", async () => {
      const first = fakeSource([1], { complete: false });
      const ui = (source: FindSource) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(first.source));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 1+"));
      expect(highlighted("find-match")).toBe(1);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();

      const gone = fakeSource([], { complete: true });
      rerender(ui(gone.source));
      await waitFor(() => expect(statusText()).toBe("No results"));
      expect(highlighted("find-match")).toBe(0);
    });

    it("drops a window.find miss once a source has answered the term", async () => {
      const ui = (source: FindSource | null) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          {source ? <SourceRegistration source={source} /> : null}
        </Providers>
      );
      const { rerender } = render(ui(null));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("No results"));

      rerender(ui(fakeSource([2]).source));
      await waitFor(() => expect(statusText()).toBe("1 of 2"));

      rerender(ui(null));
      await waitFor(() => expect(status().style.visibility).toBe("hidden"));
      expect(statusText()).toBe("");
    });

    it("replaces a pending step with a step from the last revealed ordinal", async () => {
      const first = fakeSource([2], { complete: false, rendered: 2 });
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={first.source} />
      );

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2+"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();
      expect(statusText()).toBe("2 of 2+");

      // Backwards from the last revealed 2, not from the pending 3.
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await waitFor(() => expect(statusText()).toBe("1 of 2+"));
      expect(first.reveal).toHaveBeenLastCalledWith(
        "needle",
        1,
        expect.any(Function)
      );
    });

    it("keeps a landing that arrives while a step is pending", async () => {
      const first = fakeSource([2], { complete: false, rendered: 2 });
      const landings: (() => void)[] = [];
      const rows = document.createElement("div");
      document.body.append(rows);
      first.reveal.mockImplementation((term, ordinal, onLanded) => {
        const element = document.createElement("div");
        element.textContent = `${term} ${term}`;
        rows.replaceChildren(element);
        landings.push(() =>
          onLanded({
            element: () => element,
            occurrence: ordinal - 1,
            scrollBy: vi.fn(),
          })
        );
      });
      const { input } = renderFindBand(
        vi.fn(),
        <SourceRegistration source={first.source} />
      );

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("2 of 2+"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();

      // The reveal of 2 lands after the pending step was armed: it still
      // paints, and the counter keeps the pending state's ordinal.
      landings[landings.length - 1]?.();
      expect(highlighted("find-active")).toBe(1);
      expect(statusText()).toBe("2 of 2+");
    });

    it("clears the highlights when Escape closes the band", async () => {
      const first = fakeSource([1], { complete: false });
      const onClose = vi.fn();
      const ui = (source: FindSource, open: boolean) => (
        <Providers>
          {open ? <FindBand onClose={onClose} /> : null}
          <SourceRegistration source={source} />
        </Providers>
      );
      const { rerender } = render(ui(first.source, true));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 1+"));
      expect(highlighted("find-match")).toBe(1);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(first.loadMore).toHaveBeenCalledOnce();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(onClose).toHaveBeenCalledOnce();

      // The host unmounts the band on close, which takes the highlights and
      // the pending step with it.
      rerender(ui(first.source, false));
      expect(highlighted("find-match")).toBe(0);
    });

    // A smoke test for the empty column of the table, not a guard: with no
    // term and an empty input there is no path that could reveal anything.
    it("does nothing when a source registers with no term typed", async () => {
      const ui = (source: FindSource | null) => (
        <Providers>
          <FindBand onClose={vi.fn()} />
          {source ? <SourceRegistration source={source} /> : null}
        </Providers>
      );
      const { rerender } = render(ui(null));
      const { source, reveal } = fakeSource([2]);

      rerender(ui(source));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reveal).not.toHaveBeenCalled();
      expect(status().style.visibility).toBe("hidden");
    });

    // The product's order: the tab is mounted with its source, then Ctrl+F
    // mounts the band over it. A band that mounts first never sees the first
    // source through useOnChange.
    const openOverSource = (source: FindSource) => {
      const ui = (next: FindSource | null, open: boolean) => (
        <Providers>
          {open ? <FindBand onClose={vi.fn()} /> : null}
          {next ? <SourceRegistration source={next} /> : null}
        </Providers>
      );
      const view = render(ui(source, false));
      view.rerender(ui(source, true));
      const input = screen.getByPlaceholderText<HTMLInputElement>("Find");
      input.value = "needle";
      return {
        input,
        register: (next: FindSource | null) => view.rerender(ui(next, true)),
      };
    };

    it("starts over when a source for another document registers", async () => {
      const first = fakeSource([2], { scopeId: "sample-1" });
      const { input, register } = openOverSource(first.source);
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2"));
      expect(highlighted("find-match")).toBe(1);

      const other = fakeSource([2, 2], { scopeId: "sample-2" });
      register(other.source);

      await waitFor(() => expect(status().style.visibility).toBe("hidden"));
      expect(input.value).toBe("");
      expect(highlighted("find-match")).toBe(0);
      expect(other.reveal).not.toHaveBeenCalled();
    });

    it("keeps the term when the same document re-registers", async () => {
      const { input, register } = openOverSource(
        fakeSource([2], { scopeId: "sample-1" }).source
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2"));

      register(fakeSource([2, 2], { scopeId: "sample-1" }).source);
      await waitFor(() => expect(statusText()).toBe("1 of 4"));
      expect(input.value).toBe("needle");
    });

    it("starts over when the source leaves without a replacement", async () => {
      const { input, register } = openOverSource(fakeSource([2]).source);
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(statusText()).toBe("1 of 2"));
      expect(highlighted("find-match")).toBe(1);

      register(null);
      await waitFor(() => expect(input.value).toBe(""));
      expect(highlighted("find-match")).toBe(0);
      expect(status().style.visibility).toBe("hidden");
    });

    it("debounces typing 500 ms for a one-character term and 300 ms after, and ignores an unchanged term", () => {
      vi.useFakeTimers();
      try {
        const { source, reveal } = fakeSource([2]);
        const { input } = renderFindBand(
          vi.fn(),
          <SourceRegistration source={source} />
        );

        fireEvent.change(input, { target: { value: "n" } });
        vi.advanceTimersByTime(400);
        expect(reveal).not.toHaveBeenCalled();
        vi.advanceTimersByTime(150);
        expect(reveal).toHaveBeenCalledTimes(1);

        fireEvent.change(input, { target: { value: "ne" } });
        vi.advanceTimersByTime(250);
        expect(reveal).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        expect(reveal).toHaveBeenCalledTimes(2);
        expect(reveal).toHaveBeenLastCalledWith("ne", 1, expect.any(Function));

        fireEvent.change(input, { target: { value: "ne" } });
        vi.advanceTimersByTime(600);
        expect(reveal).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
