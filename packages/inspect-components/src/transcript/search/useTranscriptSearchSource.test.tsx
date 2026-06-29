// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelEvent } from "@tsmono/inspect-common/types";
import {
  ExtendedFindProvider,
  FindTargetProvider,
  useExtendedFind,
  type FindDirection,
} from "@tsmono/react/components";

import { TimelineEvent, TimelineSpan } from "../timeline/core";
import type { SwimlaneRow } from "../timeline/swimlaneRows";
import type { TranscriptViewNodesHandle } from "../TranscriptViewNodes";
import type { EventNode } from "../types";

import { useTranscriptSearchSource } from "./useTranscriptSearchSource";

// The transcript is a *selecting* source (design/transcript-find-spec.md): it
// counts from the shared field manifest (async, via canonicalMarkdownText),
// selects the exact occurrence on the annotated `data-search-*` element, and
// reports a *validated* ordinal. So these tests must (a) await the manifest
// before reading the count and (b) render annotated panels whose textContent
// equals the field's canonical text so selection/validation can succeed. The
// pure matching/manifest/adapter logic is unit-tested in its own truth modules;
// here we exercise the wiring (count, reveal/skip, ordinal reporting).

// =============================================================================
// Fixtures
// =============================================================================

const ev = (uuid: string, output: string): ModelEvent =>
  ({
    event: "model",
    uuid,
    span_id: null,
    timestamp: "2026-04-29T00:00:00Z",
    working_start: 0,
    pending: false,
    model: "test/model",
    role: null,
    input: [],
    tools: [],
    tool_choice: "auto",
    config: {},
    output: {
      model: "test/model",
      completion: "",
      choices: [
        {
          message: { role: "assistant", content: output, source: "generate" },
          stop_reason: "stop",
        },
      ],
      usage: null,
    },
    error: null,
    cache: null,
    call: null,
    completed: null,
    working_time: null,
    style: null,
    metadata: null,
  }) as unknown as ModelEvent;

function makeRow(key: string, agent: TimelineSpan, depth = 0): SwimlaneRow {
  return {
    key,
    name: agent.name,
    depth,
    spans: [{ agent }],
    totalTokens: 0,
    startTime: new Date(0),
    endTime: new Date(0),
  };
}

function singleRowFixture(events: ModelEvent[]) {
  const main = new TimelineSpan({
    id: "main",
    name: "main",
    spanType: "agent",
    content: events.map((e) => new TimelineEvent(e)),
  });
  return { events, rows: [makeRow("main", main, 0)] as SwimlaneRow[] };
}

function twoRowFixture() {
  // main row contains e1 ("hello"); main/sub row contains e2 ("wondering")
  const e1 = ev("e1", "hello");
  const e2 = ev("e2", "wondering");
  const sub = new TimelineSpan({
    id: "sub",
    name: "sub",
    spanType: "agent",
    content: [new TimelineEvent(e2)],
  });
  const main = new TimelineSpan({
    id: "main",
    name: "main",
    spanType: "agent",
    content: [new TimelineEvent(e1), sub],
  });
  return {
    events: [e1, e2] as ModelEvent[],
    rows: [
      makeRow("main", main, 0),
      makeRow("main/sub", sub, 1),
    ] as SwimlaneRow[],
  };
}

// =============================================================================
// Test harness — mounts the hook and exposes the registered functions.
// =============================================================================

/** An annotated output-body panel for `eventId`, simulating what the renderer
 *  stamps on the canonical `output` field element (fieldIndex 0). Its
 *  textContent equals the field's canonical text (plain prose === canonical
 *  markdown text for these fixtures) so selection + validation can succeed. */
interface Panel {
  id: string;
  text: string;
}

interface HarnessOptions {
  events: ModelEvent[];
  rows: SwimlaneRow[];
  selected: string;
  flattenedNodeIds?: string[];
  panels?: Panel[];
  onSelect?: (key: string | null) => void;
  scrollToEvent?: (id: string) => void;
}

interface Harness {
  countAll(term: string): number;
  search(term: string, direction: FindDirection): Promise<boolean>;
}

/**
 * Render placeholder panels for the given event ids so `waitForEventInDOM`
 * (which polls `document.getElementById`) can complete AND so the selecting
 * source can locate the annotated field element. The panel root carries
 * `id={eventId}` (the scroll/reveal target) and the `data-search-*` annotations
 * for the event's `output` field. Events whose id is omitted simulate the
 * filtered-out-of-the-rendered-tree case (e.g. nested under a collapsed subtask
 * span) — the hook's skip-the-whole-event logic depends on this distinction.
 */
function renderHarness(opts: HarnessOptions): Harness {
  const flattened: EventNode[] = (opts.flattenedNodeIds ?? []).map(
    (id) => ({ id }) as EventNode
  );
  const harness: Partial<Harness> = {};
  const Probe = () => {
    const { extendedFindTerm, countAllMatches } = useExtendedFind();
    harness.countAll = countAllMatches;
    harness.search = extendedFindTerm;
    const viewNodesRef = useRef<TranscriptViewNodesHandle | null>({
      scrollToEvent: opts.scrollToEvent ?? vi.fn(),
      getFlattenedNodes: () => flattened,
      getVisibleRange: () => ({ startIndex: 0, endIndex: 0 }),
    });
    useTranscriptSearchSource({
      events: opts.events,
      rows: opts.rows,
      selected: opts.selected,
      onSelect: opts.onSelect ?? vi.fn(),
      viewNodesRef,
    });
    return null;
  };
  render(
    <ExtendedFindProvider>
      <FindTargetProvider>
        <Probe />
        {opts.panels?.map((p) => (
          <div
            key={p.id}
            id={p.id}
            data-search-event-id={p.id}
            data-search-field-key="output"
            data-search-field-index="0"
          >
            {p.text}
          </div>
        ))}
      </FindTargetProvider>
    </ExtendedFindProvider>
  );
  if (!harness.countAll || !harness.search)
    throw new Error("harness not ready");
  return harness as Harness;
}

/** Poll the (async-manifest-backed) counter until it reaches `expected`. */
async function waitForCount(
  h: Harness,
  term: string,
  expected: number
): Promise<void> {
  await waitFor(() => expect(h.countAll(term)).toBe(expected));
}

// =============================================================================
// Tests
// =============================================================================

describe("useTranscriptSearchSource", () => {
  it("counts matches across all rows (async manifest)", async () => {
    const { events, rows } = twoRowFixture();
    const h = renderHarness({ events, rows, selected: "main" });
    await waitForCount(h, "wondering", 1);
    await waitForCount(h, "hello", 1);
    expect(h.countAll("absent")).toBe(0);
  });

  it("returns false from search when the term has no matches", async () => {
    const { events, rows } = twoRowFixture();
    const onSelect = vi.fn();
    const h = renderHarness({ events, rows, selected: "main", onSelect });
    await waitForCount(h, "wondering", 1);
    let result: boolean | null = null;
    await act(async () => {
      result = await h.search("absent", "forward");
    });
    expect(result).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("invalidates the cached count when events change", async () => {
    let currentEvents: ModelEvent[] = [ev("e1", "wondering")];
    const harness: Partial<Harness> = {};
    const Probe = () => {
      const { countAllMatches } = useExtendedFind();
      harness.countAll = countAllMatches;
      const viewNodesRef = useRef<TranscriptViewNodesHandle | null>(null);
      const { rows } = singleRowFixture(currentEvents);
      useTranscriptSearchSource({
        events: currentEvents,
        rows,
        selected: "main",
        onSelect: vi.fn(),
        viewNodesRef,
      });
      return null;
    };
    const tree = () => (
      <ExtendedFindProvider>
        <FindTargetProvider>
          <Probe />
        </FindTargetProvider>
      </ExtendedFindProvider>
    );
    const { rerender } = render(tree());
    await waitFor(() => expect(harness.countAll!("wondering")).toBe(1));
    expect(harness.countAll!("wondering")).toBe(1); // hits the cache

    currentEvents = [ev("e1", "wondering"), ev("e2", "wondering more")];
    rerender(tree());
    await waitFor(() => expect(harness.countAll!("wondering")).toBe(2)); // generation bumped
  });

  it("selects an annotated match and reports its validated ordinal", async () => {
    const { events, rows } = singleRowFixture([ev("e1", "wondering")]);
    const h = renderHarness({
      events,
      rows,
      selected: "main",
      flattenedNodeIds: ["e1"],
      panels: [{ id: "e1", text: "wondering" }],
    });
    await waitForCount(h, "wondering", 1);
    let result: boolean | null = null;
    await act(async () => {
      result = await h.search("wondering", "forward");
    });
    expect(result).toBe(true);
    // The source set the window selection to the exact occurrence.
    const sel = window.getSelection();
    expect(sel?.toString().toLowerCase()).toBe("wondering");
  });

  // The headline integration test. The skip-the-whole-event branch of searchFn
  // (matches sharing an unreachable eventId are advanced past in one shot) is
  // the most fragile invariant: a regression makes find silently get stuck at
  // the boundary between reachable and unreachable matches. By omitting `e2`'s
  // panel from the rendered DOM, we simulate the deeply-nested-under-collapsed-
  // subtask case, and assert that one Next press lands on `e3`.
  it("skips a reachable-but-unmounted event in a single press", async () => {
    const e1 = ev("e1", "wondering one");
    const e2 = ev("e2", "wondering two");
    const e3 = ev("e3", "wondering three");
    const { events, rows } = singleRowFixture([e1, e2, e3]);
    const scrollToEvent = vi.fn();
    const h = renderHarness({
      events,
      rows,
      selected: "main",
      flattenedNodeIds: ["e1", "e2", "e3"],
      panels: [
        { id: "e1", text: "wondering one" },
        // e2 intentionally omitted — its panel never mounts
        { id: "e3", text: "wondering three" },
      ],
      scrollToEvent,
    });
    await waitForCount(h, "wondering", 3);

    // Start from e1's match, then Next twice: e1 -> (skip e2) -> e3.
    await act(async () => {
      await h.search("wondering", "forward"); // e1
    });
    await act(async () => {
      await h.search("wondering", "forward"); // e2 unmounted -> skip -> e3
    });
    const lastScroll = scrollToEvent.mock.calls.at(-1) as [string] | undefined;
    expect(lastScroll?.[0]).toBe("e3");
  });
});
