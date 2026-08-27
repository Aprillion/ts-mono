import type { FindMessages } from "@tsmono/inspect-components/chat";

import type { ClientAPI } from "../../client/api/types";
import type { SampleHandle } from "../types";

/** The Messages tab's find source over `api.find_messages`, or undefined when
 *  the backend has none (the tab then registers no find surface). */
export const messagesFindSource = (
  api: ClientAPI,
  sample: SampleHandle
): FindMessages | undefined => {
  const find = api.find_messages;
  if (!find) return undefined;
  return async (query, page, signal) => {
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
    return {
      rows: response.rows.map((row) => ({
        anchor: { id: row.anchor },
        index: row.index,
        count: row.count,
        texts: row.texts,
      })),
      total: response.total,
      complete: response.complete,
    };
  };
};
