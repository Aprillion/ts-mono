// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { Event, ModelEvent } from "@tsmono/inspect-common/types";
import { canonicalMarkdownText } from "@tsmono/react/components";

import { buildSearchManifest } from "./transcriptManifestBuilder";

// The DOM/async manifest builder: combines the shared field enumerator
// (eventSearchFields) with canonicalMarkdownText so each markdown field's
// `text` equals what the renderer will render (offsets map into the DOM), while
// plain fields stay verbatim. Document order across events, enumerator order
// within. Excludes events without a uuid / not in the row map. The pure
// buildMatchList then runs on this manifest. (See design/transcript-find-spec.md.)

const model = (
  uuid: string,
  opts: { model?: string; inputs?: string[]; outputs?: string[] }
): ModelEvent =>
  ({
    event: "model",
    uuid,
    model: opts.model ?? "m",
    input: (opts.inputs ?? []).map((content) => ({ role: "user", content, id: null })),
    output: {
      choices: (opts.outputs ?? []).map((content) => ({
        message: { content, role: "assistant" },
      })),
    },
    timestamp: "2026-01-01T00:00:00Z",
    working_start: 0,
  }) as unknown as ModelEvent;

describe("buildSearchManifest", () => {
  it("canonicalizes markdown fields and keeps plain fields verbatim, in order", async () => {
    const events: Event[] = [
      model("e1", { model: "gpt-4", inputs: ["**hi** there"], outputs: ["the answer"] }),
    ];
    const manifest = await buildSearchManifest(events, new Map([["e1", "main"]]));
    expect(manifest).toEqual([
      { eventId: "e1", rowKey: "main", fieldKey: "model", fieldIndex: 0, text: "gpt-4" },
      {
        eventId: "e1",
        rowKey: "main",
        fieldKey: "user",
        fieldIndex: 0,
        text: await canonicalMarkdownText("**hi** there"),
      },
      {
        eventId: "e1",
        rowKey: "main",
        fieldKey: "output",
        fieldIndex: 0,
        text: await canonicalMarkdownText("the answer"),
      },
    ]);
    // markdown syntax is gone in the canonical text (so offsets map to the DOM)
    expect(manifest[1]!.text).not.toContain("**");
  });

  it("preserves document order across events and excludes events not in the row map", async () => {
    const events: Event[] = [
      model("e1", { outputs: ["first"] }),
      model("e2", { outputs: ["second"] }),
    ];
    const manifest = await buildSearchManifest(events, new Map([["e2", "main"]]));
    expect(manifest.map((f) => f.eventId)).toEqual(["e2"]);
  });
});
