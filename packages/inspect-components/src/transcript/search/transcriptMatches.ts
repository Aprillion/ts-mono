import type { Event } from "@tsmono/inspect-common/types";
import { prepareSearchTerm } from "@tsmono/util";

import { extractEventFields } from "../eventText";

/**
 * One searchable field of the shared transcript manifest. The matcher builds
 * its match list ONLY from these (never from a separate extractor that could
 * disagree with what's rendered). Identity + text only — reveal mechanics live
 * with the DOM adapter, not here. `text` is the field's canonical searchable
 * text; match offsets are UTF-16 code-unit indices into it.
 */
export interface SearchField {
  eventId: string;
  rowKey: string;
  fieldKey: string;
  /** 0-based index distinguishing repeated `fieldKey`s within one event. */
  fieldIndex: number;
  text: string;
}

/**
 * Build the shared field manifest: the ordered list of searchable `SearchField`s
 * the matcher counts from. Document order across `events`, rendered display order
 * within an event (via `extractEventFields`). An event contributes nothing unless
 * it has a uuid present in `eventToRow` (only revealable/addressable events are
 * counted). `fieldIndex` is the 0-based occurrence of each `fieldKey` within its
 * event, distinguishing repeated keys (e.g. multiple `user` inputs).
 */
export function buildManifest(
  events: Event[],
  eventToRow: Map<string, string>
): SearchField[] {
  const manifest: SearchField[] = [];
  for (const event of events) {
    const eventId = event.uuid;
    if (!eventId) continue;
    const rowKey = eventToRow.get(eventId);
    if (rowKey === undefined) continue;
    const fieldIndexByKey = new Map<string, number>();
    for (const [fieldKey, text] of extractEventFields(event)) {
      const fieldIndex = fieldIndexByKey.get(fieldKey) ?? 0;
      fieldIndexByKey.set(fieldKey, fieldIndex + 1);
      manifest.push({ eventId, rowKey, fieldKey, fieldIndex, text });
    }
  }
  return manifest;
}

/** Which prepared-term variant produced an occurrence. */
export type MatchVariant = "simple" | "unquoted" | "jsonEscaped";

/**
 * A single counted occurrence. `start`/`end` are UTF-16 code-unit offsets into
 * the originating field's canonical `text`.
 */
export interface Match {
  rowKey: string;
  eventId: string;
  fieldKey: string;
  fieldIndex: number;
  variant: MatchVariant;
  start: number;
  end: number;
}

/** A selection to validate back to an ordinal. */
export interface MatchSelection {
  eventId: string;
  fieldKey: string;
  fieldIndex: number;
  start: number;
  end: number;
}

interface Variant {
  key: MatchVariant;
  value: string;
}

/**
 * Variant strings paired with their key, in spec order (simple, unquoted,
 * jsonEscaped), de-duped keeping the first (so an equal-length tie resolves to
 * the earliest variant) and with empty strings dropped.
 */
function buildVariants(term: string): Variant[] {
  const prepared = prepareSearchTerm(term);
  const ordered: Variant[] = [
    { key: "simple", value: prepared.simple },
    ...(prepared.unquoted !== undefined
      ? [{ key: "unquoted" as const, value: prepared.unquoted }]
      : []),
    ...(prepared.jsonEscaped !== undefined
      ? [{ key: "jsonEscaped" as const, value: prepared.jsonEscaped }]
      : []),
  ];
  const seen = new Set<string>();
  const out: Variant[] = [];
  for (const v of ordered) {
    if (!v.value || seen.has(v.value)) continue;
    seen.add(v.value);
    out.push(v);
  }
  return out;
}

interface FieldOccurrence {
  variant: MatchVariant;
  start: number;
  end: number;
}

/**
 * Enumerate non-overlapping occurrences of any variant within one field's
 * lowercased `text`, left-to-right. At each position the longest matching
 * variant wins; on an equal-length tie the earliest variant (by `variants`
 * order) wins. Offsets index into the original text (length-preserving lowering).
 */
function findFieldOccurrences(
  lowered: string,
  variants: Variant[]
): FieldOccurrence[] {
  const hits: {
    pos: number;
    len: number;
    rank: number;
    variant: MatchVariant;
  }[] = [];
  variants.forEach((v, rank) => {
    let from = 0;
    let p = 0;
    while ((p = lowered.indexOf(v.value, from)) !== -1) {
      hits.push({ pos: p, len: v.value.length, rank, variant: v.key });
      from = p + v.value.length;
    }
  });
  hits.sort((a, b) => a.pos - b.pos || b.len - a.len || a.rank - b.rank);
  const out: FieldOccurrence[] = [];
  let endOfLast = 0;
  for (const h of hits) {
    if (h.pos >= endOfLast) {
      out.push({ variant: h.variant, start: h.pos, end: h.pos + h.len });
      endOfLast = h.pos + h.len;
    }
  }
  return out;
}

/**
 * Build the canonical, ordered match list for `term` over the manifest.
 *
 * Order: manifest order across fields, occurrences left-to-right within a
 * field. Empty/absent terms yield no matches. Variant matching mirrors the
 * chat counter via `prepareSearchTerm`.
 */
export function buildMatchList(manifest: SearchField[], term: string): Match[] {
  if (!term) return [];
  const variants = buildVariants(term);
  if (variants.length === 0) return [];

  const out: Match[] = [];
  for (const field of manifest) {
    const lowered = field.text.toLowerCase();
    for (const occ of findFieldOccurrences(lowered, variants)) {
      out.push({
        rowKey: field.rowKey,
        eventId: field.eventId,
        fieldKey: field.fieldKey,
        fieldIndex: field.fieldIndex,
        variant: occ.variant,
        start: occ.start,
        end: occ.end,
      });
    }
  }
  return out;
}

/**
 * Validate a DOM selection back to its 0-based ordinal in `matches`, or `null`
 * if no counted match has exactly that identity (eventId/fieldKey/fieldIndex)
 * and range (start/end).
 */
export function matchIndexFromField(
  matches: Match[],
  sel: MatchSelection
): number | null {
  const i = matches.findIndex(
    (m) =>
      m.eventId === sel.eventId &&
      m.fieldKey === sel.fieldKey &&
      m.fieldIndex === sel.fieldIndex &&
      m.start === sel.start &&
      m.end === sel.end
  );
  return i === -1 ? null : i;
}
