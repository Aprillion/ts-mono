import clsx from "clsx";
import JSON5 from "json5";
import { FC, Fragment, ReactNode, useRef } from "react";

import type {
  ContentAudio,
  ContentData,
  ContentDocument,
  ContentImage,
  ContentReasoning,
  ContentText,
  ContentToolUse,
  ContentVideo,
} from "@tsmono/inspect-common/types";
import { ExpandablePanel } from "@tsmono/react/components";
import type { MarkdownReference } from "@tsmono/react/components";
import { usePrismHighlight } from "@tsmono/react/hooks";
import { isJson } from "@tsmono/util";

import {
  useDisplayMode,
  type DisplayMode,
} from "../content/DisplayModeContext";
import { RenderedText } from "../content/RenderedText";
import { MediaReference } from "../media/MediaReference";
import {
  audioMimeTypeForFormat,
  isRenderableAudioSource,
  isRenderableImageSource,
  isRenderableVideoSource,
  videoMimeTypeForFormat,
} from "../media/mediaSource";
import {
  searchIdentityAttributes,
  type FieldIdentity,
} from "../transcript/search/searchFieldIdentity";

import { ContentDataView } from "./content-data/ContentDataView";
import { ContentDocumentView } from "./documents/ContentDocumentView";
import { JsonMessageContent } from "./JsonMessageContent";
import { MessageCitations } from "./MessageCitations";
import styles from "./MessageContent.module.css";
import { MessagesContext } from "./MessageContents";
import {
  normalizeContent,
  type Contents,
  type ContentObject,
  type ContentType,
} from "./normalizeContent";
import { ServerToolCall } from "./server-tools/ServerToolCall";
import { ToolOutput } from "./tools/ToolOutput";
import { ContentTool } from "./types";

interface MessageContentProps {
  contents: Contents;
  context: MessagesContext;
  references?: MarkdownReference[];
  /**
   * Search-field identities for this message's in-scope markdown bodies, in
   * render order (one per body that renders through markdown). Each is stamped
   * as `data-search-*` on that body's canonical element so the live DOM matches
   * the manifest. Omitted outside the searchable transcript.
   */
  searchIdentities?: FieldIdentity[];
}

export const isMessageContent = (
  content: unknown
): content is ContentObject => {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    typeof content.type === "string"
  );
};

/**
 * Renders message content based on its type.
 * Supports rendering strings, images, and tools using specific renderers.
 */
export const MessageContent: FC<MessageContentProps> = ({
  contents,
  context,
  references,
  searchIdentities,
}) => {
  const displayMode = useDisplayMode();
  const normalized = normalizeContent(contents, displayMode);

  // Dispense identities to in-scope markdown bodies in render order — exactly
  // the bodies `eventSearchFields` (via `markdownBodies`) enumerates: a string,
  // or a `text` item whose text is not JSON. The k-th such body gets the k-th
  // identity, so the DOM annotation matches `buildSearchManifest`.
  let bodyCursor = 0;
  const nextSearchAttributes = (
    text: string
  ): Record<string, string | number> | undefined => {
    if (isJson(text)) return undefined;
    const identity = searchIdentities?.[bodyCursor];
    bodyCursor++;
    return identity ? searchIdentityAttributes(identity) : undefined;
  };

  if (Array.isArray(normalized)) {
    return normalized.map((content, index) => {
      if (typeof content === "string") {
        return messageRenderers["text"]?.render(
          `text-content-${index}`,
          {
            type: "text",
            text: content,
            refusal: null,
            internal: null,
            citations: null,
          },
          index === contents.length - 1,
          context,
          displayMode,
          references,
          nextSearchAttributes(content)
        );
      } else {
        if (content) {
          const renderer = messageRenderers[content.type];
          if (renderer) {
            return renderer.render(
              `text-${content.type}-${index}`,
              content,
              index === contents.length - 1,
              context,
              displayMode,
              references,
              content.type === "text"
                ? nextSearchAttributes(content.text)
                : undefined
            );
          } else {
            console.error(`Unknown message content type '${content.type}'`);
          }
        }
      }
    });
  } else {
    // This is a simple string
    const contentText: ContentText = {
      type: "text",
      text: normalized,
      refusal: null,
      internal: null,
      citations: null,
    };
    return messageRenderers["text"]?.render(
      "text-message-content",
      contentText,
      true,
      context,
      displayMode,
      references,
      nextSearchAttributes(normalized)
    );
  }
};

interface MessageRenderer {
  render: (
    key: string,
    content: ContentType,
    isLast: boolean,
    context: MessagesContext,
    displayMode: DisplayMode,
    references?: MarkdownReference[],
    searchAttributes?: Record<string, string | number>
  ) => ReactNode;
}

const messageRenderers: Record<string, MessageRenderer> = {
  text: {
    render: (
      key,
      content,
      isLast,
      _context,
      displayMode,
      references,
      searchAttributes
    ) => {
      // The context provides a way to share context between different
      // rendering. In this case, we'll use it to keep track of citations
      const c = content as ContentText;
      const cites = c.citations ?? [];

      if (!c.text && !cites.length) {
        return undefined;
      }

      if (displayMode === "rendered" && isJson(c.text)) {
        const obj = JSON.parse(c.text) as Record<string, unknown>;
        return <JsonMessageContent id={`${key}-json`} json={obj} />;
      } else {
        return (
          <Fragment key={key}>
            <RenderedText
              markdown={c.text}
              className={clsx(
                isLast ? "no-last-para-padding" : "",
                styles.breakable
              )}
              references={references}
              searchAttributes={searchAttributes}
            />
            {c.citations && c.citations.length > 0 ? (
              <MessageCitations citations={c.citations} />
            ) : undefined}
          </Fragment>
        );
      }
    },
  },
  reasoning: {
    render: (key, content, isLast) => {
      const r = content as ContentReasoning;

      // Possible titles
      let title = "Reasoning";
      let text = r.reasoning;
      if (r.redacted) {
        text = r.summary || "Reasoning encrypted by model provider.";
        if (r.summary) {
          title = "Reasoning (Summary)";
        }
      } else if (!text) {
        text = r.summary || "Reasoning text not provided.";
        if (r.summary) {
          title = "Reasoning (Summary)";
        }
      }

      // Detect OpenRouter-style reasoning (JSON array format)
      const renderReasoningCode = isOpenRouterReasoning(text);

      const codeFormatted = renderReasoningCode
        ? JSON.stringify(jsonParse(text), null, 2)
        : text;

      return (
        <div
          key={key}
          data-content-kind="reasoning"
          className={clsx(styles.reasoning, "text-size-small")}
        >
          <div
            className={clsx(
              "text-style-label",
              "text-style-secondary",
              isLast ? "no-last-para-padding" : ""
            )}
          >
            {title}
          </div>
          <ExpandablePanel id={`${key}-reasoning`} collapse={true}>
            {!renderReasoningCode && <RenderedText markdown={codeFormatted} />}
            {renderReasoningCode && (
              <CodePanel language="json" code={codeFormatted} />
            )}
          </ExpandablePanel>
        </div>
      );
    },
  },
  image: {
    render: (key, content) => {
      const c = content as ContentImage;
      if (isRenderableImageSource(c.image)) {
        return <img src={c.image} className={styles.contentImage} key={key} />;
      } else {
        return <MediaReference source={c.image} key={key} />;
      }
    },
  },
  audio: {
    render: (key, content) => {
      const c = content as ContentAudio;
      if (!isRenderableAudioSource(c.audio, c.format)) {
        return <MediaReference source={c.audio} key={key} />;
      }
      return (
        <audio controls key={key}>
          <source src={c.audio} type={audioMimeTypeForFormat(c.format)} />
        </audio>
      );
    },
  },
  video: {
    render: (key, content) => {
      const c = content as ContentVideo;
      if (!isRenderableVideoSource(c.video, c.format)) {
        return <MediaReference source={c.video} key={key} />;
      }
      return (
        <video width="500" height="375" controls key={key}>
          <source src={c.video} type={videoMimeTypeForFormat(c.format)} />
        </video>
      );
    },
  },
  tool: {
    render: (key, content) => {
      const c = content as ContentTool;
      return <ToolOutput output={c.content} key={key} />;
    },
  },
  // server-side tool use. Assistant turns render these as flush rows of the
  // turn container (see ChatMessage); this fallback covers any other context,
  // so the block carries its own frame.
  tool_use: {
    render: (key, content) => {
      const c = content as ContentToolUse;
      return <ServerToolCall id={key} content={c} flush={false} />;
    },
  },
  data: {
    render: (key, content) => {
      const c = content as ContentData;
      return <ContentDataView id={key} contentData={c} />;
    },
  },
  document: {
    render: (key, content) => {
      const c = content as ContentDocument;
      return <ContentDocumentView id={key} document={c} />;
    },
  },
};

const isOpenRouterReasoning = (text: string): boolean => {
  return text.startsWith("[{'format'");
};

const jsonParse = (text: string): unknown => {
  try {
    const result: unknown = JSON.parse(text);
    return result;
  } catch {
    const result: unknown = JSON5.parse(text);
    return result;
  }
};

/**
 * Inline code panel for formatted code display (e.g. OpenRouter reasoning).
 */
const CodePanel: FC<{ code: string; language?: string }> = ({
  code,
  language = "json",
}) => {
  const codeContainerRef = useRef<HTMLDivElement>(null);
  usePrismHighlight(codeContainerRef, code.length);
  return (
    <div ref={codeContainerRef} className={clsx(styles.codePanel)}>
      <pre className={clsx(styles.codePanelPre)}>
        <code className={clsx(`language-${language}`)}>{code}</code>
      </pre>
    </div>
  );
};
