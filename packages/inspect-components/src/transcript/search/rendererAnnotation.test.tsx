// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Event, ModelEvent } from "@tsmono/inspect-common/types";
import {
  ComponentIconProvider,
  ComponentNavigationProvider,
  type ComponentIcons,
} from "@tsmono/react/components";
import {
  ComponentStateProvider,
  type ComponentStateHooks,
} from "@tsmono/react/state";

import { ChatView } from "../../chat/ChatView";
import { DisplayModeContext } from "../../content/DisplayModeContext";

import { SearchFieldProvider } from "./SearchFieldContext";
import {
  assignEventFieldIdentities,
  searchIdentityAttributes,
} from "./searchFieldIdentity";
import { buildSearchManifest } from "./transcriptManifestBuilder";

// Renderer-annotation integration contract (design/transcript-find-spec.md
// "Renderer annotation"): rendering a model event's content must produce
// exactly the set of `data-search-*`-annotated elements that
// `buildSearchManifest` yields — same (eventId, fieldKey, fieldIndex)
// identities AND each element's textContent equal to that field's canonical
// `text`. The manifest is independent truth, so this is a real cross-check.
//
// We render at the lightest level that still exercises the real annotation
// path for ALL input + output bodies (ChatView -> ChatMessage -> MessageContent
// -> RenderedText -> MarkdownDiv) plus the plain `model` field — the same
// `SearchFieldProvider` + identity assignment ModelEventView uses. (The full
// ModelEventView Summary tab filters input messages, so it cannot show every
// field at once; the Messages tab — all input + output — is what we model.)

const stateHooks: ComponentStateHooks = {
  useValue: (_id, _prop, defaultValue) => defaultValue,
  useSetValue: () => () => {},
  useRemoveValue: () => () => {},
  useEntries: () => undefined,
  useRemoveAll: () => () => {},
  useRemoveByPrefix: () => () => {},
};

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

const modelEvent = (
  uuid: string,
  opts: {
    model?: string;
    inputs?: { role: "user" | "system"; content: string }[];
    outputs?: string[];
  }
): ModelEvent =>
  ({
    event: "model",
    uuid,
    model: opts.model ?? "m",
    input: (opts.inputs ?? []).map(({ role, content }) => ({
      role,
      content,
      id: null,
    })),
    output: {
      choices: (opts.outputs ?? []).map((content) => ({
        message: { content, role: "assistant" },
      })),
    },
    tools: [],
    timestamp: "2026-01-01T00:00:00Z",
    working_start: 0,
  }) as unknown as ModelEvent;

/**
 * Render the model-name field plus every input + output message body through
 * the real annotation path, under the same provider ModelEventView uses.
 */
const renderEventContent = (event: ModelEvent) => {
  const identities = assignEventFieldIdentities(event);
  const allMessages = [
    ...event.input,
    ...(event.output?.choices ?? []).map((c) => c.message),
  ];
  return render(
    <ComponentStateProvider hooks={stateHooks}>
      <ComponentIconProvider icons={icons}>
        <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
          <DisplayModeContext.Provider value={{ displayMode: "rendered" }}>
            <SearchFieldProvider
              value={{
                identitiesForMessage: (m) => identities.byMessage.get(m),
              }}
            >
              {identities.model ? (
                <span {...searchIdentityAttributes(identities.model)}>
                  {event.model}
                </span>
              ) : null}
              <ChatView
                id="contract"
                messages={allMessages}
                tools={{ collapseToolMessages: false }}
                labels={{ show: false }}
              />
            </SearchFieldProvider>
          </DisplayModeContext.Provider>
        </ComponentNavigationProvider>
      </ComponentIconProvider>
    </ComponentStateProvider>
  );
};

interface AnnotatedField {
  eventId: string;
  fieldKey: string;
  fieldIndex: number;
  text: string;
}

const annotatedFields = (container: HTMLElement): AnnotatedField[] =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-search-event-id]"))
    .map((el) => ({
      eventId: el.getAttribute("data-search-event-id")!,
      fieldKey: el.getAttribute("data-search-field-key")!,
      fieldIndex: Number(el.getAttribute("data-search-field-index")!),
      text: el.textContent ?? "",
    }))
    .sort(byIdentity);

const byIdentity = (a: AnnotatedField, b: AnnotatedField): number =>
  a.eventId.localeCompare(b.eventId) ||
  a.fieldKey.localeCompare(b.fieldKey) ||
  a.fieldIndex - b.fieldIndex;

beforeAll(() => {
  // jsdom lacks ResizeObserver, which ExpandablePanel observes.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
});

describe("renderer annotation contract", () => {
  it("annotates exactly the manifest's fields, with matching identity and text", async () => {
    const event = modelEvent("e1", {
      model: "anthropic/claude",
      inputs: [
        { role: "system", content: "You are **helpful**." },
        { role: "user", content: "first question" },
        { role: "user", content: "second `question`" },
      ],
      outputs: ["the **answer** is 42", "an alternate reply"],
    });

    const events: Event[] = [event];
    const manifest = await buildSearchManifest(
      events,
      new Map([["e1", "main"]])
    );
    const expected: AnnotatedField[] = manifest
      .map((f) => ({
        eventId: f.eventId,
        fieldKey: f.fieldKey,
        fieldIndex: f.fieldIndex,
        text: f.text,
      }))
      .sort(byIdentity);

    const { container } = renderEventContent(event);

    // Markdown bodies settle asynchronously; wait until the annotated set
    // matches the manifest in identity AND canonical text.
    await waitFor(() => {
      expect(annotatedFields(container)).toEqual(expected);
    });

    // The manifest is non-trivial (model + 3 inputs + 2 outputs).
    expect(expected).toHaveLength(6);
  });

  it("does not annotate JSON-rendered text (out of scope, no descriptor)", async () => {
    const event = modelEvent("e2", {
      model: "m",
      inputs: [{ role: "user", content: "real prose" }],
      outputs: ['{"k": "v", "n": 1}'],
    });

    const manifest = await buildSearchManifest(
      [event],
      new Map([["e2", "main"]])
    );
    // model + the one prose input; the JSON output yields no field.
    expect(manifest.map((f) => f.fieldKey)).toEqual(["model", "user"]);

    const { container } = renderEventContent(event);
    await waitFor(() => {
      expect(annotatedFields(container).map((f) => f.fieldKey)).toEqual([
        "model",
        "user",
      ]);
    });
  });
});
