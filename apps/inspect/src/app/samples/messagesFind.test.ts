import { describe, expect, it, vi } from "vitest";

import type { FindMessagesResponse } from "@tsmono/inspect-common/types";

import type { ClientAPI } from "../../client/api/types";

import { messagesFindSource } from "./messagesFind";

const sample = { logFile: "dir/log.eval", id: "s1", epoch: 2 };
const projection = {
  unlabeledRoles: ["user"],
  toolCallStyle: "compact" as const,
  displayMode: "raw" as const,
};

describe("messagesFindSource", () => {
  it("is undefined when the backend has no find_messages", () => {
    expect(messagesFindSource({} as ClientAPI, sample)).toBeUndefined();
  });

  it("maps a cursor page to the wire request and the response to rows", async () => {
    const response: FindMessagesResponse = {
      rows: [
        { anchor: "m1#3", index: 3, count: 2, texts: ["İstanbul", "istanbul"] },
      ],
      total: { rows: 5, occurrences: 9, relation: "gte" },
      complete: false,
    };
    const find_messages = vi.fn(() => Promise.resolve(response));
    // The adapter reads only find_messages; the rest of the api is unused.
    const source = messagesFindSource(
      { find_messages } as Pick<ClientAPI, "find_messages"> as ClientAPI,
      sample
    )!;
    const signal = new AbortController().signal;

    const page = await source(
      { text: "istanbul", projection },
      {
        direction: "backward",
        cursor: { anchor: { id: "m1" } },
        limit: 200,
      },
      signal
    );

    expect(find_messages).toHaveBeenCalledWith(
      "dir/log.eval",
      {
        sample_id: "s1",
        epoch: 2,
        text: "istanbul",
        direction: "backward",
        cursor: { anchor: "m1" },
        limit: 200,
        projection: {
          unlabeled_roles: ["user"],
          tool_call_style: "compact",
          display_mode: "raw",
        },
      },
      signal
    );
    expect(page).toEqual({
      rows: [
        {
          anchor: { id: "m1#3" },
          index: 3,
          count: 2,
          texts: ["İstanbul", "istanbul"],
        },
      ],
      total: { rows: 5, occurrences: 9, relation: "gte" },
      complete: false,
    });
  });
});
