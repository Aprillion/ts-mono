import type { ChatMessage, ModelEvent } from "@tsmono/inspect-common/types";

/**
 * The input messages a model event's Summary tab renders by default — the user
 * messages (and the immediately-preceding assistant compaction message, system,
 * and optionally tool messages) that lead up to this model call, with the
 * echoed history before them hidden.
 *
 * Pure (no React): lifted out of `ModelEventView` so it is the single source of
 * truth for which input messages are shown-by-default AND counted. The matcher's
 * field enumerator (`eventSearchFields`) iterates this exact set so the manifest
 * counts only the messages the default render annotates — never the hidden-by-
 * default history, which has no selectable element (fail-closed).
 *
 * `hasToolEvents` mirrors the rendering context: when it is `false`, tool
 * messages are shown inline here (no tool events render them elsewhere) and are
 * therefore included. The manifest builder has no context and uses the default
 * (tool events present), matching the transcript's normal render.
 */
export function summaryInputMessages(
  event: ModelEvent,
  hasToolEvents: boolean | undefined = undefined
): ChatMessage[] {
  const result: ChatMessage[] = [];

  // When agent tool results have been filtered from input (shown on AgentCard
  // instead), the trailing assistant message is the previous model call's output
  // — just show it without crawling backward through system/user messages.
  const agentResultsFiltered = !!(event as Record<string, unknown>)
    .agentResultsFiltered;

  if (!agentResultsFiltered) {
    // if there is an assistant message immediately before then include this
    // (as it could be an assistant compaction message)
    let offset: number | undefined = undefined;
    const lastMessage = event.input.at(-1);
    if (lastMessage?.role === "assistant") {
      result.push(lastMessage);
      offset = -1;
    }

    for (const msg of event.input.slice(offset).reverse()) {
      if (
        (msg.role === "user" && !msg.tool_call_id) ||
        msg.role === "system" ||
        // If the client doesn't support tool events, then tools messages are allowed to be displayed
        // in this view, since no tool events will be shown.
        (hasToolEvents === false && msg.role === "tool")
      ) {
        result.unshift(msg);
      } else {
        break;
      }
    }
  }

  return result;
}
