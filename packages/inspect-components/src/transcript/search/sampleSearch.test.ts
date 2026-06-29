// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { InfoEvent } from "@tsmono/inspect-common/types";

import { TimelineEvent, TimelineSpan } from "../timeline/core";
import type { SwimlaneRow } from "../timeline/swimlaneRows";

import { buildEventToRowMap } from "./sampleSearch";

const ev = (uuid: string): TimelineEvent =>
  new TimelineEvent({
    event: "info",
    uuid,
    timestamp: "2026-04-29T00:00:00Z",
    pending: false,
    span_id: null,
    working_start: 0,
    source: null,
    data: null,
    metadata: null,
  } as unknown as InfoEvent);

const span = (
  id: string,
  content: (TimelineEvent | TimelineSpan)[],
  spanType: string | null = "agent"
): TimelineSpan => new TimelineSpan({ id, name: id, spanType, content });

const row = (key: string, agent: TimelineSpan, depth = 0): SwimlaneRow => ({
  key,
  name: agent.name,
  depth,
  spans: [{ agent }],
  totalTokens: 0,
  startTime: new Date(0),
  endTime: new Date(0),
});

describe("buildEventToRowMap", () => {
  it("maps events directly under a row's agent to that row", () => {
    const e1 = ev("e1");
    const e2 = ev("e2");
    const main = span("main", [e1, e2]);
    const map = buildEventToRowMap([row("main", main)]);
    expect(map.get("e1")).toBe("main");
    expect(map.get("e2")).toBe("main");
  });

  it("maps events under a non-agent child span to the parent agent's row", () => {
    const e1 = ev("e1");
    const inner = span("step1", [e1], "step");
    const main = span("main", [inner]);
    const map = buildEventToRowMap([row("main", main)]);
    expect(map.get("e1")).toBe("main");
  });

  it("does not map events under a nested agent span to the outer row", () => {
    const eOuter = ev("eOuter");
    const eInner = ev("eInner");
    const subAgent = span("sub", [eInner], "agent");
    const main = span("main", [eOuter, subAgent]);
    // Both rows present in state.rows
    const rows: SwimlaneRow[] = [
      row("main", main, 0),
      row("main/sub", subAgent, 1),
    ];
    const map = buildEventToRowMap(rows);
    expect(map.get("eOuter")).toBe("main");
    expect(map.get("eInner")).toBe("main/sub");
  });

  it("uses the deepest matching row when an event appears reachable via multiple", () => {
    // Defensive: shouldn't happen in practice, but the rule is "deepest wins".
    const e1 = ev("e1");
    const sub = span("sub", [e1], "agent");
    const main = span("main", [sub]);
    const rows: SwimlaneRow[] = [row("main", main, 0), row("main/sub", sub, 1)];
    const map = buildEventToRowMap(rows);
    expect(map.get("e1")).toBe("main/sub");
  });

  it("handles parallel-span rows (multiple agents in one row)", () => {
    const e1 = ev("e1");
    const e2 = ev("e2");
    const a1 = span("a1", [e1]);
    const a2 = span("a2", [e2]);
    const parallelRow: SwimlaneRow = {
      key: "parallel",
      name: "parallel",
      depth: 0,
      spans: [{ agents: [a1, a2] }],
      totalTokens: 0,
      startTime: new Date(0),
      endTime: new Date(0),
    };
    const map = buildEventToRowMap([parallelRow]);
    expect(map.get("e1")).toBe("parallel");
    expect(map.get("e2")).toBe("parallel");
  });

  it("returns an empty map for empty rows", () => {
    expect(buildEventToRowMap([]).size).toBe(0);
  });
});
