import { TimelineSpan } from "../timeline/core";
import type { SwimlaneRow } from "../timeline/swimlaneRows";
import { getAgents } from "../timeline/swimlaneRows";

/**
 * Build a map from event ID to the swimlane row key that contains it.
 *
 * Walks each row's agents. Within each agent, iterates through its `content`
 * but stops descending into nested agent spans — those events belong to
 * their own row (a separate entry in `state.rows`).
 *
 * If `state.rows` is sorted with deeper rows after their parents (the convention
 * established by `useTimeline`), processing them in order means the deepest row
 * wins when the same event would otherwise be reachable via multiple rows
 * (defensive — normally each event has exactly one containing row).
 */
export function buildEventToRowMap(rows: SwimlaneRow[]): Map<string, string> {
  const map = new Map<string, string>();
  // Sort by depth ascending so deeper rows overwrite shallower ones.
  const ordered = [...rows].sort((a, b) => a.depth - b.depth);

  for (const row of ordered) {
    for (const rowSpan of row.spans) {
      for (const agent of getAgents(rowSpan)) {
        recordRowEvents(agent, row.key, map);
      }
    }
  }
  return map;
}

function recordRowEvents(
  agent: TimelineSpan,
  rowKey: string,
  out: Map<string, string>
): void {
  const stack: TimelineSpan[] = [agent];
  while (stack.length > 0) {
    const span = stack.pop()!;
    for (const item of span.content) {
      if (item.type === "event") {
        // Use uuid (matching EventNode.id derivation in treeify.ts). Events without uuid get
        // synthetic node IDs that aren't on the raw event — those can't be reached via
        // sample-wide search and are skipped.
        const uuid = item.event.uuid;
        if (uuid) out.set(uuid, rowKey);
      } else {
        // Stop at nested agent spans — those events belong to their own row.
        if (item.spanType === "agent") continue;
        stack.push(item);
      }
    }
  }
}
