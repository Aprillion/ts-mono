import { useCallback, useLayoutEffect, useRef } from "react";

import { useStore } from "./store";

export const useUnloadLog = () => {
  const clearSelectedLogDetails = useStore(
    (state) => state.logActions.clearSelectedLogDetails
  );
  const clearSelectedLogFile = useStore(
    (state) => state.logsActions.clearSelectedLogFile
  );
  const clearLog = useStore((state) => state.logActions.clearLog);
  const clearPendingSampleSummaries = useStore(
    (state) => state.logActions.clearPendingSampleSummaries
  );

  const unloadLog = useCallback(() => {
    clearSelectedLogDetails();
    clearSelectedLogFile();
    clearLog();
    // Pending (streaming) sample summaries are merged into the sample list by
    // useSampleSummaries; without clearing them here a previously-running log's
    // samples leak into the next log until its details finish loading.
    clearPendingSampleSummaries();
  }, [
    clearLog,
    clearSelectedLogDetails,
    clearSelectedLogFile,
    clearPendingSampleSummaries,
  ]);
  return { unloadLog };
};

/**
 * Clear the previous log's selected sample, details, and pending samples before
 * paint when the route's log changes, so a stale transcript / sample list from
 * the prior log never renders under the new log's header while the new one
 * loads. Used by both the log-view container (sample list) and the single-
 * sample detail route (transcript) so they can't drift.
 */
export const useClearStaleLogStateOnNav = (logPath: string | undefined) => {
  const clearSelectedSample = useStore(
    (state) => state.sampleActions.clearSelectedSample
  );
  const clearSelectedLogDetails = useStore(
    (state) => state.logActions.clearSelectedLogDetails
  );
  const clearPendingSampleSummaries = useStore(
    (state) => state.logActions.clearPendingSampleSummaries
  );
  const prevLogPathRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const prevLogPath = prevLogPathRef.current;
    prevLogPathRef.current = logPath;
    if (prevLogPath && logPath && logPath !== prevLogPath) {
      clearSelectedSample();
      clearSelectedLogDetails();
      clearPendingSampleSummaries();
    }
  }, [
    logPath,
    clearSelectedSample,
    clearSelectedLogDetails,
    clearPendingSampleSummaries,
  ]);
};
