import {
  defaultMarkdownRenderer,
  renderMarkdown,
  type MarkdownRenderer,
} from "./markdownRendering";
import { sanitizeRenderedHtml } from "./renderedHtmlSanitizer";

export type { MarkdownRenderer } from "./markdownRendering";

/**
 * The canonical searchable text of a markdown field: exactly the `textContent`
 * that {@link MarkdownDiv} renders for the same markdown.
 *
 * Runs the SAME pipeline `MarkdownDiv` uses to compute its final HTML
 * (`renderMarkdown` -> `sanitizeRenderedHtml`, no post-processing) and reads the
 * `textContent` off-DOM, so the find feature can count searchable text without
 * mounting the field and have offsets map into the rendered DOM. See the
 * "field manifest" render contract in design/transcript-find-spec.md.
 */
export async function canonicalMarkdownText(
  markdown: string,
  renderer: MarkdownRenderer = defaultMarkdownRenderer
): Promise<string> {
  const html = sanitizeRenderedHtml(renderMarkdown(markdown, renderer));

  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}
