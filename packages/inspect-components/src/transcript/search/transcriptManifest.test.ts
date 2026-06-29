import { describe, expect, it } from "vitest";

import type { Event, ModelEvent } from "@tsmono/inspect-common/types";

import { buildManifest } from "./transcriptMatches";

// Pure manifest-builder tests (see design/transcript-find-spec.md). The manifest
// is the ordered list of searchable fields: document order across events,
// rendered display order within an event, identity + canonical text only (no
// reveal modelling). It is the single source the matcher counts from.

const modelEvent = (
  uuid: string,
  opts: { model?: string; inputs?: string[]; output?: string }
): ModelEvent =>
  ({
    event: "model",
    uuid,
    model: opts.model ?? "m",
    input: (opts.inputs ?? []).map((content) => ({ role: "user", content, id: null })),
    output: opts.output
      ? { choices: [{ message: { content: opts.output, role: "assistant" } }] }
      : { choices: [] },
    timestamp: "2026-01-01T00:00:00Z",
    working_start: 0,
  }) as unknown as ModelEvent;

describe("buildManifest", () => {
  it("orders fields document-order across events, display-order within (model name, input, output)", () => {
    const events: Event[] = [
      modelEvent("e1", { model: "gpt-4", inputs: ["the prompt"], output: "the answer" }),
      modelEvent("e2", { model: "gpt-4", inputs: [], output: "second" }),
    ];
    const eventToRow = new Map([
      ["e1", "main"],
      ["e2", "main"],
    ]);
    const manifest = buildManifest(events, eventToRow);
    expect(manifest.map((f) => [f.eventId, f.fieldKey, f.fieldIndex, f.text])).toEqual([
      ["e1", "model", 0, "gpt-4"],
      ["e1", "user", 0, "the prompt"],
      ["e1", "output", 0, "the answer"],
      ["e2", "model", 0, "gpt-4"],
      ["e2", "output", 0, "second"],
    ]);
  });

  it("gives repeated field keys distinct fieldIndex in order", () => {
    const events: Event[] = [modelEvent("e1", { inputs: ["first", "second"] })];
    const manifest = buildManifest(events, new Map([["e1", "main"]]));
    const users = manifest.filter((f) => f.fieldKey === "user");
    expect(users.map((f) => [f.fieldIndex, f.text])).toEqual([
      [0, "first"],
      [1, "second"],
    ]);
  });

  it("tags each field with its row, and excludes events not in the row map", () => {
    const events: Event[] = [
      modelEvent("e1", { output: "in researcher" }),
      modelEvent("e2", { output: "orphan" }),
    ];
    const manifest = buildManifest(events, new Map([["e1", "researcher"]]));
    expect(manifest.every((f) => f.rowKey === "researcher")).toBe(true);
    expect(manifest.some((f) => f.eventId === "e2")).toBe(false);
  });

  it("excludes events without a uuid (not addressable / not revealable)", () => {
    const noId = modelEvent("e1", { output: "x" });
    (noId as { uuid: string | null }).uuid = null;
    expect(buildManifest([noId], new Map())).toEqual([]);
  });
});
