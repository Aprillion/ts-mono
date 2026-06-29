import type {
  ChatMessage,
  Event,
  ModelEvent,
} from "@tsmono/inspect-common/types";

import { inScopeMarkdownBodies } from "../../chat/normalizeContent";
import { summaryInputMessages } from "../summaryMessages";

/**
 * The kind of a searchable field, which determines how the matcher derives the
 * field's canonical `text` from `rawText`:
 * - `plain`: `text === rawText` verbatim (e.g. a model name).
 * - `markdown`: `text === canonicalMarkdownText(rawText)` (a markdown body that
 *   the renderer pipes through `MarkdownDiv`).
 */
export type FieldKind = "plain" | "markdown";

/**
 * One searchable field of an event, in render order. `fieldIndex` is the
 * 0-based occurrence of this `fieldKey` within the event. See
 * design/transcript-find-spec.md "Shared field enumerator".
 */
export interface FieldDescriptor {
  fieldKey: string;
  fieldIndex: number;
  kind: FieldKind;
  rawText: string;
}

/**
 * The single source of truth for an event's in-scope searchable fields, in the
 * order the views render them. BOTH the renderer (to annotate the canonical
 * element with `data-search-*`) and the matcher (to build the match list)
 * consume this so they cannot drift.
 *
 * Fail-closed: a descriptor is emitted only for field kinds whose canonical text
 * can be reproduced off-DOM today — plain-text fields (verbatim) and plain
 * markdown body (a non-JSON `text` content item). Everything else (JSON-rendered
 * text, images, reasoning, tool-result structured views, citations) is omitted.
 *
 * Currently enumerates the `model` event kind; other kinds return [] until their
 * fields are brought in scope.
 */
export function eventSearchFields(event: Event): FieldDescriptor[] {
  if (event.event === "model") {
    return modelEventFields(event);
  }
  return [];
}

function modelEventFields(event: ModelEvent): FieldDescriptor[] {
  const fields: FieldDescriptor[] = [];
  const counts = new Map<string, number>();

  const push = (fieldKey: string, kind: FieldKind, rawText: string) => {
    const fieldIndex = counts.get(fieldKey) ?? 0;
    counts.set(fieldKey, fieldIndex + 1);
    fields.push({ fieldKey, fieldIndex, kind, rawText });
  };

  // Chrome prefix "Model Call:" is a label; the model name itself is a field.
  if (event.model) {
    push("model", "plain", event.model);
  }

  // Render order mirrors ModelEventView's default Summary tab: the shown input
  // messages (the filtered user/system subset, NOT the echoed history) first,
  // then the assistant output choices. Iterating `summaryInputMessages` (the
  // same helper the view uses) keeps the manifest == the annotated/selectable
  // set — never count hidden-by-default history we can't select (fail-closed).
  for (const message of summaryInputMessages(event)) {
    pushMessageBodies(message, message.role, push);
  }
  for (const choice of event.output?.choices ?? []) {
    pushMessageBodies(choice.message, "output", push);
  }

  return fields;
}

function pushMessageBodies(
  message: ChatMessage,
  fieldKey: string,
  push: (fieldKey: string, kind: FieldKind, rawText: string) => void
): void {
  for (const text of inScopeMarkdownBodies(message.content)) {
    push(fieldKey, "markdown", text);
  }
}
