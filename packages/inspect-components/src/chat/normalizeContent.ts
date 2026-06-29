import type {
  Citation,
  ContentAudio,
  ContentData,
  ContentDocument,
  ContentImage,
  ContentReasoning,
  ContentText,
  ContentToolUse,
  ContentVideo,
} from "@tsmono/inspect-common/types";
import { isJson } from "@tsmono/util";

import { type DisplayMode } from "../content/DisplayModeContext";

import { ContentTool } from "./types";

export type ContentObject =
  | ContentText
  | ContentReasoning
  | ContentImage
  | ContentAudio
  | ContentVideo
  | ContentDocument
  | ContentTool
  | ContentData
  | ContentToolUse;

export type ContentType = string | string[] | ContentObject;

export type Contents = string | string[] | ContentObject[];

/**
 * Collapse sequential runs of text content into a single text content, adding
 * citations as superscript counters at the end of each block that has them. The
 * flattened citations are attached to the merged content so they can be rendered
 * separately (with coordinating numbers).
 *
 * Shared between `MessageContent` (the renderer) and the search manifest
 * (`eventSearchFields`) so the set of rendered markdown bodies — and thus the
 * counted/annotated search fields — cannot drift from what is displayed.
 */
export const normalizeContent = (
  contents: Contents,
  displayMode: DisplayMode
): Contents => {
  // Raw mode presents the logged content blocks without citation injection or
  // other rendered-mode normalization.
  if (displayMode === "raw") {
    return contents;
  }

  // its a string
  if (typeof contents === "string") {
    return contents;
  }

  // its an array of strings
  if (contents.length > 0 && typeof contents[0] === "string") {
    return contents;
  }

  const result: ContentObject[] = [];
  const collection: ContentText[] = [];

  const collect = () => {
    if (collection.length > 0) {
      // Flatten the citations from the collection
      const filteredCitations = collection.flatMap((c) => c.citations || []);
      // Render citations as superscript counters
      let citeCount = 0;
      const textWithCites = collection
        .map((c) => {
          // separate the cites into those with a position and those without
          // sort by end_index (to allow for numbering to not affect indexes)
          // Type guard function to check if cited_text is a range
          const positionalCites = (c.citations ?? [])
            .filter(isCitationWithRange)
            .sort((a, b) => b.cited_text[1] - a.cited_text[1]);

          const endCites = c.citations?.filter(
            (citation) => !isCitationWithRange(citation)
          );

          // Process cites with positions
          let textWithCites = c.text;
          for (let i = 0; i < positionalCites.length; i++) {
            const end_index = positionalCites[i]?.cited_text[1];

            textWithCites =
              textWithCites.slice(0, end_index) +
              `<sup>${positionalCites.length - i}</sup>` +
              textWithCites.slice(end_index);
          }
          citeCount = citeCount + positionalCites.length;

          // Process cites without positions (they just attach to the end of the content)
          const citeText = endCites?.map(() => `${++citeCount}`);
          let inlineCites = "";
          if (citeText && citeText.length > 0) {
            inlineCites = `<sup>${citeText.join(",")}</sup>`;
          }
          return (textWithCites || "") + inlineCites;
        })
        .join("");

      // Flatten the text from the collection into a single text content
      result.push({
        type: "text",
        text: textWithCites,
        refusal: null,
        internal: null,
        citations: filteredCitations,
      });
      collection.length = 0;
    }
  };

  for (const content of contents) {
    if (typeof content === "string") {
      // this shouldn't happen, but if it does
      // just convert it to a text content
      result.push({
        type: "text",
        text: content,
        refusal: null,
        internal: null,
        citations: null,
      });
      continue;
    }

    if (content.type === "text") {
      // Collect text until we hit a  non-text content
      collection.push(content);
      continue;
    } else {
      // collect any text content before this non-text content
      collect();
      result.push(content);
    }
  }

  // collect any remaining text content
  collect();

  return result;
};

// This is a helper that makes Omit<> work with a union type by distributing
// the omit over the union members.
export type DistributiveOmit<
  TObj,
  TKey extends PropertyKey,
> = TObj extends unknown ? Omit<TObj, TKey> : never;

/** Type guard that allows narrowing down to Citations whose `cited_text` is a range */
export const isCitationWithRange = (
  citation: Citation
): citation is DistributiveOmit<Citation, "cited_text"> & {
  cited_text: [number, number];
} => Array.isArray(citation.cited_text);

/**
 * The in-scope searchable markdown body texts of a message's content, in render
 * order — one per `text` body `MessageContent` renders through markdown, AFTER
 * `normalizeContent` has merged adjacent text items (so a `[text, text]` run is
 * ONE body with citation `<sup>`s injected, exactly the single `RenderedText`
 * element the renderer emits). JSON-detected text (rendered as a JSON panel) and
 * non-text content are excluded.
 *
 * The single source of truth for "which bodies are searchable", consumed by both
 * the search manifest (`eventSearchFields`) and the renderer's per-message
 * identity allocation (`ChatMessage`), so the counted, annotated, and rendered
 * body sets cannot drift. Rendered mode is assumed (the searchable transcript
 * renders content rendered).
 */
export const inScopeMarkdownBodies = (content: Contents): string[] => {
  const normalized = normalizeContent(content, "rendered");
  const items = typeof normalized === "string" ? [normalized] : normalized;
  const bodies: string[] = [];
  for (const item of items) {
    const text =
      typeof item === "string"
        ? item
        : item.type === "text"
          ? item.text
          : undefined;
    if (text !== undefined && !isJson(text)) bodies.push(text);
  }
  return bodies;
};
