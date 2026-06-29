import { describe, expect, it } from "vitest";

import type { ModelEvent } from "@tsmono/inspect-common/types";

import { eventSearchFields } from "./eventSearchFields";

// The shared field enumerator (design/transcript-find-spec.md "Shared field
// enumerator"). It is the ONE source of truth for an event's searchable fields,
// in render order, that BOTH the renderer (to annotate) and the matcher (to
// count) consume. It emits descriptors only for in-scope kinds (fail-closed):
// plain-text fields and plain markdown body (non-JSON `text` content); it omits
// JSON-rendered content, images, reasoning, etc. `rawText` is the pre-render
// source; the matcher canonicalizes markdown kinds, the renderer annotates.

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

describe("eventSearchFields", () => {
  it("enumerates a model event in render order: model name, then inputs, then outputs", () => {
    const fields = eventSearchFields(
      model("e1", { model: "gpt-4", inputs: ["the prompt"], outputs: ["**bold** answer"] })
    );
    expect(fields).toEqual([
      { fieldKey: "model", fieldIndex: 0, kind: "plain", rawText: "gpt-4" },
      { fieldKey: "user", fieldIndex: 0, kind: "markdown", rawText: "the prompt" },
      { fieldKey: "output", fieldIndex: 0, kind: "markdown", rawText: "**bold** answer" },
    ]);
  });

  it("gives repeated roles distinct per-key fieldIndex", () => {
    const fields = eventSearchFields(model("e1", { inputs: ["first", "second"] }));
    const users = fields.filter((f) => f.fieldKey === "user");
    expect(users).toEqual([
      { fieldKey: "user", fieldIndex: 0, kind: "markdown", rawText: "first" },
      { fieldKey: "user", fieldIndex: 1, kind: "markdown", rawText: "second" },
    ]);
  });

  it("omits JSON-rendered text content (out of scope, rendered as a JSON panel not markdown)", () => {
    const fields = eventSearchFields(model("e1", { outputs: ['{"a": 1, "b": 2}'] }));
    expect(fields.some((f) => f.fieldKey === "output")).toBe(false);
  });

  it("emits plain kind for model name and verbatim rawText (no markdown canonicalization)", () => {
    const fields = eventSearchFields(model("e1", { model: "anthropic/claude" }));
    expect(fields).toContainEqual({
      fieldKey: "model",
      fieldIndex: 0,
      kind: "plain",
      rawText: "anthropic/claude",
    });
  });
});
