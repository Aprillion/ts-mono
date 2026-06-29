import type { Event } from "@tsmono/inspect-common/types";
import { canonicalMarkdownText } from "@tsmono/react/components";

import { eventSearchFields } from "./eventSearchFields";
import type { SearchField } from "./transcriptMatches";

/**
 * Build the shared field manifest asynchronously: the ordered list of searchable
 * `SearchField`s the matcher counts from. Document order across `events`,
 * enumerator order (rendered display order) within an event (via
 * `eventSearchFields`). An event contributes nothing unless it has a uuid present
 * in `eventToRow` (only revealable/addressable events are counted).
 *
 * Each descriptor's canonical `text` is derived by kind: a `markdown` body is run
 * through `canonicalMarkdownText` so it equals what the renderer settles into the
 * DOM (match offsets map into the DOM); a `plain` field stays verbatim. See
 * design/transcript-find-spec.md "Shared field enumerator" / "The field manifest".
 */
export async function buildSearchManifest(
  events: Event[],
  eventToRow: Map<string, string>
): Promise<SearchField[]> {
  const manifest: SearchField[] = [];
  for (const event of events) {
    const eventId = event.uuid;
    if (!eventId) continue;
    const rowKey = eventToRow.get(eventId);
    if (rowKey === undefined) continue;
    for (const descriptor of eventSearchFields(event)) {
      const text =
        descriptor.kind === "markdown"
          ? await canonicalMarkdownText(descriptor.rawText)
          : descriptor.rawText;
      manifest.push({
        eventId,
        rowKey,
        fieldKey: descriptor.fieldKey,
        fieldIndex: descriptor.fieldIndex,
        text,
      });
    }
  }
  return manifest;
}
