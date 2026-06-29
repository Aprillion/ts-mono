import { CSSProperties, ForwardedRef, forwardRef } from "react";

import {
  MarkdownDivWithReferences,
  MarkdownReference,
  Preformatted,
  type MarkdownRenderer,
} from "@tsmono/react/components";

import { cappedText } from "./cappedText";
import { useDisplayMode } from "./DisplayModeContext";

interface RenderedTextProps {
  markdown: string;
  references?: MarkdownReference[];
  style?: CSSProperties;
  className?: string | string[];
  forceRender?: boolean;
  renderer?: MarkdownRenderer;
  options?: {
    previewRefsOnHover?: boolean;
  };
  /**
   * Search-identity data attributes (`data-search-*`) for the find feature,
   * stamped onto this body's single canonical element — the one whose
   * `textContent` equals the manifest field's canonical text. See
   * design/transcript-find-spec.md "Renderer annotation".
   */
  searchAttributes?: Record<string, string | number>;
}

export const RenderedText = forwardRef<
  HTMLDivElement | HTMLPreElement,
  RenderedTextProps
>(
  (
    {
      markdown,
      references,
      style,
      className,
      forceRender,
      renderer,
      options,
      searchAttributes,
    },
    ref
  ) => {
    const displayMode = useDisplayMode();
    const { text, notice } = cappedText(markdown);

    const body =
      forceRender || displayMode === "rendered" ? (
        <MarkdownDivWithReferences
          ref={ref as ForwardedRef<HTMLDivElement>}
          markdown={text}
          references={references}
          options={options}
          style={style}
          className={className}
          renderer={renderer}
          dataAttributes={searchAttributes}
        />
      ) : (
        <Preformatted
          ref={ref as ForwardedRef<HTMLPreElement>}
          text={text}
          style={style}
          className={className}
          dataAttributes={searchAttributes}
        />
      );

    if (notice === null) {
      return body;
    }

    return (
      <>
        {body}
        {notice}
      </>
    );
  }
);

RenderedText.displayName = "RenderedText";
