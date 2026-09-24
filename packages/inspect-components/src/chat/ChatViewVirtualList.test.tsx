// @vitest-environment jsdom
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";
import {
  ExtendedFindProvider,
  useExtendedFind,
} from "@tsmono/react/components";
import { ComponentStateProvider } from "@tsmono/react/state";
import { makeReactiveStateStore } from "@tsmono/react/testing";

import {
  ChatViewRowsVirtualList,
  ChatViewVirtualList,
} from "./ChatViewVirtualList";
import { buildMessageRows, messageRowOptions } from "./rowsModel";

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

describe("ChatViewVirtualList find registration", () => {
  it("leaves the legacy counter alone, because it registers a FindSource", () => {
    const { result } = renderHook(() => useExtendedFind(), {
      wrapper: ({ children }) => (
        <ComponentStateProvider hooks={makeReactiveStateStore().hooks}>
          <ExtendedFindProvider>
            {children}
            <ChatViewVirtualList id="chat" messages={messages} />
          </ExtendedFindProvider>
        </ComponentStateProvider>
      ),
    });
    // "role" is a key of the default JSON.stringify accessor and appears in no
    // rendered text: a non-zero count means the list opted into the legacy path.
    expect(result.current.countAllMatches("role")).toBe(0);
  });
});
