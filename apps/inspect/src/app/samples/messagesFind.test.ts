import { describe, expect, it, vi } from "vitest";

import type { FindMessagesResponse } from "@tsmono/inspect-common/types";

import { FindPageCache } from "./findPageCache";
import { messagesFindSource } from "./messagesFind";

const sample = { logFile: "dir/log.eval", id: "s1", epoch: 2 };
const projection = {
  unlabeledRoles: ["user"],
  toolCallStyle: "compact" as const,
  displayMode: "raw" as const,
};
const query = { text: "istanbul", projection };
const opts = {
  direction: "backward" as const,
  cursor: { anchor: { id: "m1" } },
  limit: 200,
};

const sealed: FindMessagesResponse = {
  rows: [
    { anchor: "m1#3", index: 3, count: 2, texts: ["İstanbul", "istanbul"] },
  ],
  total: { rows: 5, occurrences: 9, relation: "gte" },
  complete: true,
};

const mappedSealed = {
  rows: [
    {
      anchor: { id: "m1#3" },
      index: 3,
      count: 2,
      texts: ["İstanbul", "istanbul"],
    },
  ],
  total: { rows: 5, occurrences: 9, relation: "gte" },
  complete: true,
};

function sourceWith(
  response: FindMessagesResponse,
  cache = new FindPageCache()
) {
  const find_messages = vi.fn(() => Promise.resolve(response));
  const source = messagesFindSource({ find_messages }, sample, cache)!;
  return { source, find_messages, cache };
}

describe("messagesFindSource", () => {
  it("is undefined when the backend has no find_messages", () => {
    expect(messagesFindSource({}, sample)).toBeUndefined();
  });

  it("maps a cursor page to the wire request and the response to rows", async () => {
    const live: FindMessagesResponse = { ...sealed, complete: false };
    const { source, find_messages } = sourceWith(live);
    const signal = new AbortController().signal;

    const page = await source(query, opts, signal);

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
    expect(page).toEqual({ ...mappedSealed, complete: false });
  });

  it("reuses a sealed page for the same POST body (backspace to a paused term)", async () => {
    const { source, find_messages } = sourceWith(sealed);
    const signal = new AbortController().signal;
    const first = await source(query, opts, signal);
    const second = await source(query, opts, signal);
    expect(find_messages).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    first.rows[0]!.texts.push("mutated");
    expect(second.rows[0]!.texts).toEqual(["İstanbul", "istanbul"]);
  });

  it("does not cache a live sample page", async () => {
    const { source, find_messages } = sourceWith({
      ...sealed,
      complete: false,
    });
    const signal = new AbortController().signal;
    await source(query, opts, signal);
    await source(query, opts, signal);
    expect(find_messages).toHaveBeenCalledTimes(2);
  });

  it("misses when the term differs (does not derive a prefix from a longer query)", async () => {
    const { source, find_messages } = sourceWith(sealed);
    const signal = new AbortController().signal;
    await source(query, opts, signal);
    await source({ ...query, text: "istanbu" }, opts, signal);
    expect(find_messages).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest sealed page when over capacity", async () => {
    const cache = new FindPageCache(1);
    const { source, find_messages } = sourceWith(sealed, cache);
    const signal = new AbortController().signal;
    await source(query, opts, signal);
    await source({ ...query, text: "other" }, opts, signal);
    expect(cache.size).toBe(1);
    await source(query, opts, signal);
    expect(find_messages).toHaveBeenCalledTimes(3);
  });

  it("does not cache a response that arrived after abort", async () => {
    const cache = new FindPageCache();
    const ac = new AbortController();
    const find_messages = vi.fn(() => {
      ac.abort();
      return Promise.resolve(sealed);
    });
    const source = messagesFindSource({ find_messages }, sample, cache)!;
    await expect(source(query, opts, ac.signal)).rejects.toThrow();
    expect(cache.size).toBe(0);
    await source(query, opts, new AbortController().signal);
    expect(find_messages).toHaveBeenCalledTimes(2);
  });

  it("drops sealed pages for a sample once a live page arrives", async () => {
    const cache = new FindPageCache();
    const { source, find_messages } = sourceWith(sealed, cache);
    const signal = new AbortController().signal;
    await source(query, opts, signal);
    expect(cache.size).toBe(1);
    find_messages.mockResolvedValueOnce({ ...sealed, complete: false });
    await source({ ...query, text: "other" }, opts, signal);
    expect(cache.size).toBe(0);
    await source(query, opts, signal);
    expect(find_messages).toHaveBeenCalledTimes(3);
  });
});
