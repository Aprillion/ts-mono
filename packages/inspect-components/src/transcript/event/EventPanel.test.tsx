// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useCallback, useState, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ComponentIconProvider,
  ComponentIcons,
} from "@tsmono/react/components";
import {
  ComponentStateProvider,
  type ComponentStateHooks,
} from "@tsmono/react/state";

import { TranscriptDisplayContext } from "../TranscriptDisplayContext";

import { EventPanel } from "./EventPanel";

const icons: ComponentIcons = {
  chevronDown: "icon-chevron-down",
  chevronUp: "icon-chevron-up",
  clearText: "icon-clear-text",
  close: "icon-close",
  code: "icon-code",
  confirm: "icon-confirm",
  copy: "icon-copy",
  error: "icon-error",
  menu: "icon-menu",
  next: "icon-next",
  noSamples: "icon-no-samples",
  play: "icon-play",
  previous: "icon-previous",
  toggleRight: "icon-toggle-right",
};

// Reactive in-memory ComponentStateProvider so `useProperty` round-trips the
// selected-nav state (mirrors the real Zustand-backed store).
function InMemoryStateWrapper({ children }: PropsWithChildren) {
  const [store, setStore] = useState(
    () => new Map<string, Map<string, unknown>>()
  );
  const getBag = useCallback(
    (id: string) => {
      let bag = store.get(id);
      if (!bag) {
        bag = new Map();
        store.set(id, bag);
      }
      return bag;
    },
    [store]
  );
  const hooks: ComponentStateHooks = {
    useValue: (id, prop, defaultValue) => {
      const bag = getBag(id);
      return bag.has(prop) ? bag.get(prop) : defaultValue;
    },
    useSetValue: () => (id, prop, value) => {
      getBag(id).set(prop, value);
      setStore((prev) => new Map(prev));
    },
    useRemoveValue: () => (id, prop) => {
      getBag(id).delete(prop);
      setStore((prev) => new Map(prev));
    },
    useEntries: (id) => {
      const bag = store.get(id);
      return bag ? Object.fromEntries(bag) : undefined;
    },
    useRemoveAll: () => (id) => {
      store.delete(id);
      setStore((prev) => new Map(prev));
    },
    useRemoveByPrefix: () => (id, prefix) => {
      const bag = store.get(id);
      if (!bag) return;
      for (const key of [...bag.keys()]) {
        if (key.startsWith(prefix)) bag.delete(key);
      }
      setStore((prev) => new Map(prev));
    },
  };
  return (
    <ComponentStateProvider hooks={hooks}>{children}</ComponentStateProvider>
  );
}

const renderPanel = (detailsInModal: boolean) =>
  render(
    <InMemoryStateWrapper>
      <ComponentIconProvider icons={icons}>
        <TranscriptDisplayContext.Provider value={{ detailsInModal }}>
          <EventPanel eventNodeId="evt-1" title="Model Call">
            <div data-name="Summary" data-default>
              SUMMARY_BODY
            </div>
            <div data-name="API">API_BODY</div>
          </EventPanel>
        </TranscriptDisplayContext.Provider>
      </ComponentIconProvider>
    </InMemoryStateWrapper>
  );

describe("EventPanel detail tabs", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("inline mode: selecting a tab swaps content inline, no modal", () => {
    renderPanel(false);

    // Default (Summary) shows; API is not rendered until selected.
    expect(screen.getByText("SUMMARY_BODY")).toBeTruthy();
    expect(screen.queryByText("API_BODY")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "API" }));

    expect(screen.getByText("API_BODY")).toBeTruthy();
    expect(screen.queryByText("SUMMARY_BODY")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("modal mode: inline stays on the default tab and detail tabs open a modal", () => {
    renderPanel(true);

    // Inline body is pinned to the default (Summary) tab; no modal yet.
    expect(screen.getByText("SUMMARY_BODY")).toBeTruthy();
    expect(screen.queryByText("API_BODY")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Clicking the API pill opens the modal showing the API tab, while the
    // inline Summary stays put underneath.
    fireEvent.click(screen.getByRole("tab", { name: "API" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("API_BODY")).toBeTruthy();
    expect(screen.getByText("SUMMARY_BODY")).toBeTruthy();

    // The modal carries its own tab nav so you can switch within it.
    fireEvent.click(within(dialog).getByRole("tab", { name: "Summary" }));
    expect(within(dialog).getByText("SUMMARY_BODY")).toBeTruthy();
  });
});
