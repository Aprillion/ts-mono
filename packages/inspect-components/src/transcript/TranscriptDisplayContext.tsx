import { createContext, useContext } from "react";

/**
 * App-level display preferences for the transcript event panels. Provided once
 * near the transcript root by each host app (sourced from its user settings)
 * and read by deep components like `EventPanel` that would otherwise need the
 * flag threaded through every event-view's props.
 */
export interface TranscriptDisplayOptions {
  /**
   * When true, an event panel's detail tabs (everything past the default
   * Summary tab) open in a modal overlay with their own scroll container
   * instead of expanding inline. This keeps a long model call (megabytes of
   * API JSON, a full message list, long reasoning) from reflowing the
   * transcript under the reader or hijacking keyboard scrolling to the bottom
   * of the *whole* transcript — the navigation pain reported for long calls.
   *
   * Defaults to false (inline tabs, the historical behavior). Hosts that lean
   * on very long transcripts (e.g. hawk) can default it on via their App prop.
   */
  detailsInModal: boolean;
}

const defaultOptions: TranscriptDisplayOptions = { detailsInModal: false };

export const TranscriptDisplayContext =
  createContext<TranscriptDisplayOptions>(defaultOptions);

export const useTranscriptDisplayOptions = (): TranscriptDisplayOptions =>
  useContext(TranscriptDisplayContext);
