import type { Content } from "@tsmono/inspect-common/types";

import type { DisplayMode } from "../content/DisplayModeContext";

import type { ResolvedMessage } from "./messages";
import { hasVisibleContent } from "./rowsModel";
import { resolveToolInput, toolCallSearchText } from "./tools/tool";
import type { ChatViewToolOptions } from "./types";

/**
 * The text one Messages row renders, in document order (design/find.md K1):
 * the role heading, the message content, then each tool-call block with its
 * output. `ChatMessageRow` is the mirror; `messageCorpus.test.tsx` renders a
 * row and asserts the two agree.
 */
export const messageSearchText = (
  resolved: ResolvedMessage,
  options: {
    toolCallStyle?: ChatViewToolOptions["callStyle"];
    displayMode?: DisplayMode;
  } = {}
): string[] => {
  const toolCallStyle = options.toolCallStyle ?? "complete";
  const displayMode = options.displayMode ?? "rendered";
  const message = resolved.message;
  const toolCalls =
    toolCallStyle !== "omit" &&
    message.role === "assistant" &&
    "tool_calls" in message
      ? (message.tool_calls ?? [])
      : [];
  const texts: string[] = [];

  // ChatMessageRow drops the message block when tool calls carry the whole
  // row, and ChatMessage heads every other one with its role.
  if (toolCalls.length === 0 || hasVisibleContent(message)) {
    texts.push(
      message.role === "tool" && message.function
        ? `${message.role}: ${message.function}`
        : message.role
    );
    texts.push(...extractContentText(message.content));
  }

  toolCalls.forEach((toolCall, index) => {
    // The same pairing ChatMessageRow uses to give a call its output.
    const toolMessage = toolCall.id
      ? resolved.toolMessages.find((msg) => msg.tool_call_id === toolCall.id)
      : resolved.toolMessages[index];
    if (toolCallStyle === "compact") {
      texts.push(
        `tool: ${resolveToolInput(toolCall.function, toolCall.arguments).functionCall}`
      );
      return;
    }
    texts.push(
      ...toolCallSearchText({
        fn: toolCall.function,
        args: toolCall.arguments,
        view: toolCall.view,
        toolMessage,
        displayMode,
      })
    );
  });

  return texts;
};

/**
 * Extracts text strings from message content.
 */
const extractContentText = (content: string | Array<Content>): string[] => {
  if (typeof content === "string") {
    return [content];
  }

  const texts: string[] = [];
  for (const item of content) {
    switch (item.type) {
      case "text":
        texts.push(item.text);
        break;
      case "reasoning": {
        // Mirror MessageContent.tsx's render logic for reasoning so the
        // search matches what the user actually sees: redacted reasoning
        // shows the summary (the raw reasoning is encrypted), unredacted
        // shows reasoning when present and falls back to summary.
        const reasoning = item;
        if (reasoning.redacted) {
          if (reasoning.summary) texts.push(reasoning.summary);
        } else if (reasoning.reasoning) {
          texts.push(reasoning.reasoning);
        } else if (reasoning.summary) {
          texts.push(reasoning.summary);
        }
        break;
      }
      case "tool_use": {
        const toolUse = item;
        if (toolUse.name) {
          texts.push(toolUse.name);
        }
        if (toolUse.arguments) {
          texts.push(JSON.stringify(toolUse.arguments));
        }
        break;
      }
    }
  }
  return texts;
};
