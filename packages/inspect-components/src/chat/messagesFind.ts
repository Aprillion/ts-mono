import type { FindOptions, FindPage } from "@tsmono/react/find";

import type { DisplayMode } from "../content/DisplayModeContext";

import type { ChatViewToolCallStyle } from "./types";

export const MESSAGES_FIND_SCOPE = "messages";

/** The view configuration the Messages rows render with; a source searches
 *  the text of the same rows under it. */
export interface MessagesFindProjection {
  unlabeledRoles: string[];
  toolCallStyle: ChatViewToolCallStyle;
  /** Raw mode shows markdown source (link URLs and all), so the source must
   *  search it unstripped. */
  displayMode: DisplayMode;
}

export interface MessagesFindQuery {
  text: string;
  projection: MessagesFindProjection;
}

/** One page of matches over the whole conversation the list shows, anchored
 *  by `messageRowAnchorIds`. Hosts without a backend leave it undefined and
 *  the list registers no find surface. */
export type FindMessages = (
  query: MessagesFindQuery,
  page: FindOptions,
  signal: AbortSignal
) => Promise<FindPage>;
