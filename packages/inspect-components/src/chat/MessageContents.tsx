import { FC } from "react";

import type {
  ChatMessageAssistant,
  ChatMessageSystem,
  ChatMessageTool,
  ChatMessageUser,
  Citation,
} from "@tsmono/inspect-common/types";
import type { MarkdownReference } from "@tsmono/react/components";

import { useMessageSearchIdentities } from "../transcript/search/SearchFieldContext";

import { MessageContent } from "./MessageContent";

interface MessageContentsProps {
  message:
    | ChatMessageAssistant
    | ChatMessageSystem
    | ChatMessageUser
    | ChatMessageTool;
  references?: MarkdownReference[];
}

export interface MessagesContext {
  citations: Citation[];
}

export const defaultContext = (): MessagesContext => {
  return {
    citations: [],
  };
};

export const MessageContents: FC<MessageContentsProps> = ({
  message,
  references,
}) => {
  const context: MessagesContext = defaultContext();
  const searchIdentities = useMessageSearchIdentities(message);
  return (
    <>
      {message.content && (
        <MessageContent
          contents={message.content}
          context={context}
          references={references}
          searchIdentities={searchIdentities}
        />
      )}
    </>
  );
};
