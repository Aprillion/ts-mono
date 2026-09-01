import type { FindMessages } from "@tsmono/inspect-components/chat";

import type { ClientAPI } from "../../client/api/types";
import type { SampleHandle } from "../types";

import {
  defaultFindPageCache,
  findPageCacheKey,
  type FindPageCache,
} from "./findPageCache";

/** The Messages tab's find source over `api.find_messages`, or undefined when
 *  the backend has none (the tab then registers no find surface). Sealed
 *  pages are LRU-cached so a backspace to a term already paged does not
 *  POST again; live samples are not stored. */
export const messagesFindSource = (
  api: Pick<ClientAPI, "find_messages">,
  sample: SampleHandle,
  cache: FindPageCache = defaultFindPageCache
): FindMessages | undefined => {
  const find = api.find_messages;
  if (!find) return undefined;
  return async (query, page, signal) => {
    const key = findPageCacheKey(sample, query, page);
    throwIfAborted(signal);
    const hit = cache.get(key);
    if (hit) return hit;
    const response = await find(
      sample.logFile,
      {
        sample_id: sample.id,
        epoch: sample.epoch,
        text: query.text,
        direction: page.direction,
        cursor: page.cursor ? { anchor: page.cursor.anchor.id } : undefined,
        limit: page.limit,
        projection: {
          unlabeled_roles: query.projection.unlabeledRoles,
          tool_call_style: query.projection.toolCallStyle,
          display_mode: query.projection.displayMode,
        },
      },
      signal
    );
    throwIfAborted(signal);
    const mapped = {
      rows: response.rows.map((row) => ({
        anchor: { id: row.anchor },
        index: row.index,
        count: row.count,
        texts: row.texts,
      })),
      total: response.total,
      complete: response.complete,
    };
    if (!mapped.complete) cache.dropSample(sample);
    else cache.set(key, mapped);
    return mapped;
  };
};

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}
