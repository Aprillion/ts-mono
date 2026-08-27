// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";
import {
  ComponentIconProvider,
  ComponentNavigationProvider,
  ExtendedFindProvider,
  FindBand,
  FindTargetProvider,
  useExtendedFind,
  type ComponentIcons,
} from "@tsmono/react/components";
import { FindProvider, useFindState } from "@tsmono/react/find";
import { ComponentStateProvider } from "@tsmono/react/state";
import { makeReactiveStateStore } from "@tsmono/react/testing";

import { DisplayModeContext, type DisplayMode } from "../content";

import {
  ChatViewRowsVirtualList,
  ChatViewVirtualList,
} from "./ChatViewVirtualList";
import type { FindMessages, MessagesFindQuery } from "./messagesFind";
import {
  buildMessageRows,
  messageRowOptions,
  type MessageRow,
} from "./rowsModel";

const messages: ChatMessage[] = [
  testAssistantMessage({ id: "m-1", content: "one" }),
  testAssistantMessage({ id: "m-2", content: "two" }),
];

// jsdom has no scrollTo; VirtualList calls it during mount/follow.
beforeEach(() => {
  Element.prototype.scrollTo = function () {};
});

/** Mounts the list over an inspectable store and returns the persisted follow flag. */
function mountFollow(props: {
  running: boolean;
  initialMessageId?: string;
  followRequested?: boolean;
}) {
  const { store, hooks } = makeReactiveStateStore();

  render(
    <ComponentStateProvider hooks={hooks}>
      <ExtendedFindProvider>
        <ChatViewVirtualList id="chat" messages={messages} {...props} />
      </ExtendedFindProvider>
    </ComponentStateProvider>
  );
  return store.get("chat-chat::follow");
}

describe("ChatViewRowsVirtualList paging", () => {
  const rowsOf = (count: number) =>
    buildMessageRows(
      Array.from({ length: count }, (_, i): ChatMessage => ({
        id: `m-${i}`,
        role: "user",
        content: `message ${i}`,
      })),
      messageRowOptions()
    );

  const mountRows = (props: {
    rows: ReturnType<typeof rowsOf>;
    hasMoreRows?: boolean;
    onLoadMoreRows?: () => void;
  }) => {
    const { hooks } = makeReactiveStateStore();
    const ui = (p: typeof props) => (
      <ComponentStateProvider hooks={hooks}>
        <ExtendedFindProvider>
          <ChatViewRowsVirtualList id="chat" {...p} />
        </ExtendedFindProvider>
      </ComponentStateProvider>
    );
    const view = render(ui(props));
    return { rerenderRows: (p: typeof props) => view.rerender(ui(p)) };
  };

  it("requests the next page when the loaded end is within the margin", () => {
    // a loaded prefix shorter than the margin: the mount-time check alone
    // must request more (there is no scroll event to re-trigger on)
    let calls = 0;
    mountRows({
      rows: rowsOf(5),
      hasMoreRows: true,
      onLoadMoreRows: () => calls++,
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("keeps paging when a page lands without the viewport moving", () => {
    // the regrow re-check rides on VirtualList replaying the range to the
    // new callback identity — no scroll event fires when rows are appended
    let calls = 0;
    const onLoadMoreRows = () => calls++;
    const { rerenderRows } = mountRows({
      rows: rowsOf(5),
      hasMoreRows: true,
      onLoadMoreRows,
    });
    const callsAfterMount = calls;
    rerenderRows({ rows: rowsOf(10), hasMoreRows: true, onLoadMoreRows });
    expect(calls).toBeGreaterThan(callsAfterMount);
  });

  it("never requests pages while the host reports no more rows", () => {
    let calls = 0;
    mountRows({
      rows: rowsOf(5),
      hasMoreRows: false,
      onLoadMoreRows: () => calls++,
    });
    expect(calls).toBe(0);
  });
});

const icons = Object.fromEntries(
  [
    "arrowDown",
    "arrowUp",
    "chevronDown",
    "chevronUp",
    "clearText",
    "close",
    "code",
    "confirm",
    "copy",
    "error",
    "menu",
    "next",
    "noSamples",
    "play",
    "previous",
    "toggleRight",
  ].map((name) => [name, `icon-${name}`])
) as unknown as ComponentIcons;

describe("ChatViewVirtualList find surface", () => {
  // jsdom has no layout (or ResizeObserver); give the scroller a viewport so
  // rows mount.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600)
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Reports which find engine the list registered with: the coordinator's
  // active scope, and the legacy counter's answer for text only the rows hold.
  const Probe = ({ onState }: { onState: (state: string) => void }) => {
    const { scopeId } = useFindState();
    const { countAllMatches } = useExtendedFind();
    useEffect(() => {
      onState(`${scopeId ?? "none"}/${countAllMatches("one")}`);
    });
    return null;
  };

  const noMatches: FindMessages = () =>
    Promise.resolve({
      rows: [],
      total: { rows: 0, occurrences: 0, relation: "eq" },
      complete: true,
    });

  const mount = async (findMessages?: FindMessages) => {
    const { hooks } = makeReactiveStateStore();
    let engines = "";
    const { container } = render(
      <ComponentStateProvider hooks={hooks}>
        <ComponentIconProvider icons={icons}>
          <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
            <FindProvider>
              <ExtendedFindProvider>
                <ChatViewVirtualList
                  id="chat"
                  messages={messages}
                  findMessages={findMessages}
                />
                <Probe onState={(state) => (engines = state)} />
              </ExtendedFindProvider>
            </FindProvider>
          </ComponentNavigationProvider>
        </ComponentIconProvider>
      </ComponentStateProvider>
    );
    await act(async () => {});
    return {
      rows: container.querySelectorAll("[data-message-id]").length,
      anchors: container.querySelectorAll("[data-find-anchor]").length,
      engines,
    };
  };

  it("queries the source under the view configuration it renders with, again when the rows change, and shows the source's No results", async () => {
    const { hooks } = makeReactiveStateStore();
    const queries: MessagesFindQuery[] = [];
    const findMessages: FindMessages = (query) => {
      queries.push(query);
      return noMatches(
        query,
        { direction: "forward", limit: 1 },
        new AbortController().signal
      );
    };
    const ui = (rows: MessageRow[], displayMode: DisplayMode = "raw") => (
      <ComponentStateProvider hooks={hooks}>
        <ComponentIconProvider icons={icons}>
          <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
            <DisplayModeContext.Provider value={{ displayMode }}>
              <FindProvider>
                <ExtendedFindProvider>
                  <FindTargetProvider>
                    <FindBand onClose={() => {}} />
                    <ChatViewRowsVirtualList
                      id="chat"
                      rows={rows}
                      findMessages={findMessages}
                      display={display}
                      tools={tools}
                    />
                  </FindTargetProvider>
                </ExtendedFindProvider>
              </FindProvider>
            </DisplayModeContext.Provider>
          </ComponentNavigationProvider>
        </ComponentIconProvider>
      </ComponentStateProvider>
    );
    const display = { unlabeledRoles: ["user"] };
    const tools = { callStyle: "compact" as const };
    const rows = buildMessageRows(messages, messageRowOptions(tools));
    const { rerender } = render(ui(rows));
    fireEvent.change(screen.getByPlaceholderText("Find"), {
      target: { value: "one" },
    });
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]).toEqual({
      text: "one",
      projection: {
        unlabeledRoles: ["user"],
        toolCallStyle: "compact",
        displayMode: "raw",
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("find-band-match-count").textContent).toBe(
        "No results"
      )
    );

    // Same messages, new row objects (a live poll): the term is re-queried.
    const polled = [...rows];
    rerender(ui(polled));
    await waitFor(() => expect(queries).toHaveLength(2));

    // The raw/rendered toggle changes what the rows show: re-queried too.
    rerender(ui(polled, "rendered"));
    await waitFor(() => expect(queries).toHaveLength(3));
    expect(queries[2]?.projection.displayMode).toBe("rendered");
  });

  it("loads pages through a matching row beyond the loaded prefix before revealing it", async () => {
    const { hooks } = makeReactiveStateStore();
    const all: ChatMessage[] = Array.from({ length: 6 }, (_, i) =>
      testAssistantMessage({ id: `m-${i}`, content: `msg ${i}` })
    );
    const rows = buildMessageRows(all, messageRowOptions());
    const onLoadMoreRows = vi.fn();
    const findMessages: FindMessages = () =>
      Promise.resolve({
        rows: [
          {
            anchor: { id: "m-5" },
            count: 1,
            texts: ["msg 5"],
            index: 5,
          },
        ],
        complete: true,
        total: { rows: 1, occurrences: 1, relation: "eq" },
      });
    const ui = (loaded: number) => (
      <ComponentStateProvider hooks={hooks}>
        <ComponentIconProvider icons={icons}>
          <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
            <FindProvider>
              <ExtendedFindProvider>
                <FindTargetProvider>
                  <FindBand onClose={() => {}} />
                  <ChatViewRowsVirtualList
                    id="chat"
                    rows={rows.slice(0, loaded)}
                    hasMoreRows={loaded < rows.length}
                    onLoadMoreRows={onLoadMoreRows}
                    findMessages={findMessages}
                  />
                </FindTargetProvider>
              </ExtendedFindProvider>
            </FindProvider>
          </ComponentNavigationProvider>
        </ComponentIconProvider>
      </ComponentStateProvider>
    );
    const { container, rerender } = render(ui(2));
    const scrollTops: number[] = [];
    Element.prototype.scrollTo = function (options?: ScrollToOptions | number) {
      if (typeof options === "object" && options.top !== undefined) {
        scrollTops.push(options.top);
      }
    };
    onLoadMoreRows.mockClear();
    fireEvent.change(within(container).getByPlaceholderText("Find"), {
      target: { value: "msg 5" },
    });
    await waitFor(() => expect(onLoadMoreRows).toHaveBeenCalled());
    rerender(ui(4));
    await waitFor(() =>
      expect(onLoadMoreRows.mock.calls.length).toBeGreaterThan(1)
    );
    expect(scrollTops).toEqual([]);
    rerender(ui(6));
    // The pending reveal jumps the list to the row once it is loaded.
    await waitFor(() => expect(scrollTops).not.toEqual([]));
    expect(
      within(container).getByTestId("find-band-match-count").textContent
    ).toBe("1 of 1");
    await waitFor(() =>
      expect(container.querySelector('[data-find-anchor="m-5"]')).not.toBeNull()
    );
  });

  it("registers with exactly one find engine: the coordinator for a host with a scope, the legacy counter otherwise", async () => {
    expect(await mount()).toEqual({ rows: 2, anchors: 0, engines: "none/1" });
    expect(await mount(noMatches)).toEqual({
      rows: 2,
      anchors: 2,
      engines: "messages/0",
    });
  });
});

describe("ChatViewVirtualList live-follow ownership", () => {
  it("stands down on a ?message= landing into a live sample", () => {
    // The landing owns the scroll position, so `live` must not arm the tail.
    expect(mountFollow({ running: true, initialMessageId: "m-1" })).toBe(false);
  });

  it("an explicit follow=1 still arms on a ?message= landing", () => {
    expect(
      mountFollow({
        running: true,
        initialMessageId: "m-1",
        followRequested: true,
      })
    ).toBe(true);
  });
});
