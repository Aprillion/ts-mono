// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createRef, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";
import {
  ExtendedFindProvider,
  FindTargetProvider,
  useFindSource,
  useFindTargetSetter,
  type FindLanding,
} from "@tsmono/react/components";
import type { VirtualListHandle } from "@tsmono/react/virtual";

import { buildMessageRows, messageRowOptions } from "./rowsModel";
import { useMessagesFindSource } from "./useMessagesFindSource";

const rowsOf = (contents: string[]) =>
  buildMessageRows(
    contents.map((content, i): ChatMessage =>
      testAssistantMessage({ id: `m-${i}`, content })
    ),
    messageRowOptions()
  );

const mockList = () => {
  const scrollToIndex = vi.fn<VirtualListHandle["scrollToIndex"]>();
  const scrollBy = vi.fn<VirtualListHandle["scrollBy"]>();
  const rowElement = vi.fn<VirtualListHandle["rowElement"]>(() => null);
  const handle: VirtualListHandle = {
    scrollToIndex,
    scrollBy,
    rowElement,
    scrollTo: () => {},
    getState: () => {},
    jumpToStart: () => {},
    jumpToEnd: () => {},
  };
  return { handle, scrollToIndex, scrollBy, rowElement };
};

/** Mounts the source hook and reads back what it registered. */
const mountSource = (
  handle: VirtualListHandle,
  initial: {
    rows: ReturnType<typeof rowsOf>;
    hasMoreRows?: boolean;
    onLoadMoreRows?: () => void;
    loading?: boolean;
  }
) => {
  const listHandle = createRef<VirtualListHandle | null>();
  listHandle.current = handle;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ExtendedFindProvider>
      <FindTargetProvider>{children}</FindTargetProvider>
    </ExtendedFindProvider>
  );
  const view = renderHook(
    (props: typeof initial) => {
      useMessagesFindSource({ listHandle, ...props });
      return { source: useFindSource(), setTarget: useFindTargetSetter() };
    },
    { wrapper, initialProps: initial }
  );
  const setTarget = (term: string | null) => {
    act(() => {
      view.result.current.setTarget(
        term === null ? null : { term, eventId: "" }
      );
    });
  };
  return { ...view, setTarget };
};

describe("useMessagesFindSource", () => {
  it("counts matches over folded messageSearchText and reveals the ordinal's row", () => {
    const list = mockList();
    const { result } = mountSource(list.handle, {
      rows: rowsOf(["no hit", "Needle and needle", "needle in İstanbul"]),
    });
    const source = result.current.source;
    if (!source) throw new Error("source not registered");

    expect(source.count("NEEDLE")).toEqual({ total: 3, complete: true });
    expect(source.count("istanbul")).toEqual({ total: 1, complete: true });

    const onLanded = vi.fn<(landing: FindLanding | null) => void>();
    source.reveal("needle", 3, onLanded);
    const call = list.scrollToIndex.mock.calls[0]?.[0];
    expect(call?.index).toBe(2);
    expect(call?.align).toBe("start");

    const element = document.createElement("div");
    call?.onDone?.(element);
    const landing = onLanded.mock.calls[0]?.[0];
    expect(landing?.element()).toBeNull();
    list.rowElement.mockReturnValue(element);
    expect(landing?.element()).toBe(element);
    expect(list.rowElement).toHaveBeenCalledWith(2);
    expect(landing?.occurrence).toBe(0);
    landing?.scrollBy(40);
    expect(list.scrollBy).toHaveBeenCalledWith(40);

    list.rowElement.mockReturnValue(null);
    source.reveal("needle", 2, onLanded);
    expect(list.scrollToIndex.mock.calls[1]?.[0].index).toBe(1);

    source.reveal("needle", 4, onLanded);
    expect(onLanded).toHaveBeenLastCalledWith(null);
  });

  it("hands a mounted row to the painter without scrolling to it", () => {
    const list = mockList();
    const element = document.createElement("div");
    list.rowElement.mockImplementation((index) =>
      index === 1 ? element : null
    );
    const { result } = mountSource(list.handle, {
      rows: rowsOf(["needle", "needle, needle"]),
    });
    const onLanded = vi.fn<(landing: FindLanding | null) => void>();
    // A term's first reveal goes through the list (its panels expand then).
    result.current.source?.reveal("needle", 3, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
    result.current.source?.reveal("needle", 2, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
    const landing = onLanded.mock.calls[0]?.[0];
    expect(landing?.element()).toBe(element);
    expect(landing?.occurrence).toBe(0);
    result.current.source?.reveal("dle", 2, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("keeps a term's first reveal across re-registration but not across the band closing", () => {
    const list = mockList();
    const element = document.createElement("div");
    list.rowElement.mockReturnValue(element);
    const { result, rerender, setTarget } = mountSource(list.handle, {
      rows: rowsOf(["needle", "needle"]),
    });
    const onLanded = vi.fn<(landing: FindLanding | null) => void>();
    setTarget("needle");
    result.current.source?.reveal("needle", 1, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);

    // A page or a live backfill re-registers a new source object.
    rerender({ rows: rowsOf(["needle", "needle", "needle"]) });
    result.current.source?.reveal("needle", 2, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);

    // Closing the band collapses the panels again, so the list must re-run.
    setTarget(null);
    result.current.source?.reveal("needle", 2, onLanded);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("reports rows that are still loading as an incomplete count", () => {
    const { result, rerender } = mountSource(mockList().handle, {
      rows: rowsOf([]),
      loading: true,
    });
    expect(result.current.source?.count("needle")).toEqual({
      total: 0,
      complete: false,
    });
    expect(result.current.source?.loadMore).toBeUndefined();

    rerender({ rows: rowsOf(["needle"]), loading: false });
    expect(result.current.source?.count("needle")).toEqual({
      total: 1,
      complete: true,
    });
  });

  it("reports a loaded prefix as incomplete and offers loadMore until the last page", () => {
    const list = mockList();
    const loadMore = vi.fn();
    const { result, rerender } = mountSource(list.handle, {
      rows: rowsOf(["needle"]),
      hasMoreRows: true,
      onLoadMoreRows: loadMore,
    });
    const first = result.current.source;
    if (!first) throw new Error("source not registered");
    expect(first.count("needle")).toEqual({ total: 1, complete: false });
    first.loadMore?.();
    expect(loadMore).toHaveBeenCalledOnce();

    rerender({ rows: rowsOf(["needle", "needle"]), hasMoreRows: false });
    const second = result.current.source;
    if (!second) throw new Error("source not registered");
    expect(second).not.toBe(first);
    expect(second.count("needle")).toEqual({ total: 2, complete: true });
    expect(second.loadMore).toBeUndefined();
  });
});
