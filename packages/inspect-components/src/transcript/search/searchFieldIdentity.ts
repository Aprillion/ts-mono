import type { ChatMessage, ModelEvent } from "@tsmono/inspect-common/types";

import { summaryInputMessages } from "../summaryMessages";

import { eventSearchFields, type FieldDescriptor } from "./eventSearchFields";

/**
 * The renderer-side identity of a searchable field: the triple the matcher's
 * manifest keys on (`eventId`, `fieldKey`, `fieldIndex`). The renderer stamps
 * these as `data-search-event-id` / `data-search-field-key` /
 * `data-search-field-index` on the field's single canonical element. See
 * design/transcript-find-spec.md "Renderer annotation".
 */
export interface FieldIdentity {
  eventId: string;
  fieldKey: string;
  fieldIndex: number;
}

/**
 * The `data-search-*` attributes a renderer spreads onto a field's canonical
 * element. The single place the identity triple becomes DOM attributes, so the
 * model-name span and the markdown bodies stamp them identically and the find
 * adapter reads one attribute scheme.
 */
export const searchIdentityAttributes = (
  identity: FieldIdentity
): Record<string, string | number> => ({
  "data-search-event-id": identity.eventId,
  "data-search-field-key": identity.fieldKey,
  "data-search-field-index": identity.fieldIndex,
});

/**
 * The field identities of one model event, grouped so the views can stamp the
 * canonical element of each searchable body without re-deriving identities.
 *
 * Identities are taken VERBATIM from `eventSearchFields(event)` (the single
 * source of truth) — this helper only attaches each descriptor to the message
 * the renderer will render it under, so the k-th descriptor of the enumerator
 * lands on the k-th rendered body. `byMessage` keys on the message object
 * reference (input messages and output-choice messages alike), in render order.
 */
export interface EventFieldIdentities {
  /** Identity of the plain `model`-name field, if the event has one. */
  model?: FieldIdentity;
  /** Per-message identities of that message's in-scope markdown bodies, in order. */
  byMessage: Map<ChatMessage, FieldIdentity[]>;
}

/**
 * How many in-scope markdown bodies a single message contributes, computed by
 * running the shared enumerator over a synthetic one-message event so the count
 * is derived by the SAME logic `eventSearchFields` uses (never a parallel
 * re-implementation that could drift).
 */
function messageBodyCount(message: ChatMessage, asOutput: boolean): number {
  const synthetic = {
    event: "model",
    model: "",
    input: asOutput ? [] : [message],
    output: { choices: asOutput ? [{ message }] : [] },
  } as unknown as ModelEvent;
  return eventSearchFields(synthetic).length;
}

/**
 * Assign each of a model event's descriptors (from `eventSearchFields`) to the
 * message it renders under, preserving the enumerator's order so the manifest
 * and the DOM annotations cannot drift.
 *
 * The descriptor stream is, by `eventSearchFields`' construction: the optional
 * `model` field, then for each shown input message (`summaryInputMessages`, the
 * default Summary subset — NOT the full `event.input`) its in-scope markdown
 * bodies, then for each output-choice message its in-scope markdown bodies. We
 * walk the same messages in the same order and consume the exact number of
 * descriptors each message contributes (its in-scope body count) so position i
 * in this walk is descriptor i.
 */
export function assignEventFieldIdentities(
  event: ModelEvent
): EventFieldIdentities {
  const eventId = event.uuid ?? "";
  const descriptors = eventSearchFields(event);
  let cursor = 0;

  const result: EventFieldIdentities = { byMessage: new Map() };

  const toIdentity = (descriptor: FieldDescriptor): FieldIdentity => ({
    eventId,
    fieldKey: descriptor.fieldKey,
    fieldIndex: descriptor.fieldIndex,
  });

  if (descriptors[cursor]?.fieldKey === "model") {
    result.model = toIdentity(descriptors[cursor]!);
    cursor++;
  }

  const assignMessage = (message: ChatMessage, asOutput: boolean): void => {
    const count = messageBodyCount(message, asOutput);
    if (count === 0) return;
    const identities = descriptors
      .slice(cursor, cursor + count)
      .map(toIdentity);
    cursor += count;
    result.byMessage.set(message, identities);
  };

  for (const message of summaryInputMessages(event)) {
    assignMessage(message, false);
  }
  for (const choice of event.output?.choices ?? []) {
    assignMessage(choice.message, true);
  }

  return result;
}
