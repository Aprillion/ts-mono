import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { NetworkFixture } from "@msw/playwright";
import { http, HttpResponse } from "msw";

import type {
  ChatMessage,
  EvalLog,
  FindMessagesRequest,
  FindMessagesResponse,
} from "@tsmono/inspect-common/types";

import { createLogDetails } from "./test-data";

/**
 * Route the log-listing and log-content API at a single in-memory eval log,
 * so a spec can deep-link straight into it. With E2E_LOG_DIR set the log is
 * written there instead, for a real `inspect view --log-dir` behind vite's
 * proxy (VIEW_SERVER_URL) — the server then answers everything, find
 * included.
 */
export function serveEvalLog(
  network: NetworkFixture,
  evalLog: EvalLog,
  logFile: string,
  task = "test-task"
) {
  if (process.env.E2E_LOG_DIR) {
    writeFileSync(
      join(process.env.E2E_LOG_DIR, logFile),
      JSON.stringify(evalLog)
    );
    return;
  }
  const logDetails = createLogDetails(evalLog);
  network.use(
    // get_log_root — the dir-mode gate blocks on this.
    http.get("*/api/logs", () => HttpResponse.json({ log_dir: "/logs" })),
    http.get("*/api/log-files*", () =>
      HttpResponse.json({
        files: [{ name: logFile, task, task_id: task }],
        response_type: "full",
      })
    ),
    http.get("*/api/logs/:file", () => HttpResponse.json(evalLog)),
    http.post("*/api/find-messages/*", async ({ request }) => {
      const body = (await request.json()) as FindMessagesRequest;
      const sample = evalLog.samples?.find(
        (s) => String(s.id) === String(body.sample_id) && s.epoch === body.epoch
      );
      return HttpResponse.json(findMessages(sample?.messages ?? [], body));
    }),
    http.get("*/api/log-headers*", () =>
      HttpResponse.json([
        {
          eval_id: logDetails.eval.eval_id,
          run_id: logDetails.eval.run_id,
          task: logDetails.eval.task,
          task_id: logDetails.eval.task_id,
          task_version: logDetails.eval.task_version,
          model: logDetails.eval.model,
          status: logDetails.status,
          started_at: logDetails.stats?.started_at,
          completed_at: logDetails.stats?.completed_at,
        },
      ])
    )
  );
}

/**
 * Stand-in for the view server's find over a conversation's source text:
 * case-insensitive substring per row (role header, then content; one row per
 * message — these fixtures have no tool calls to fold), anchors as the fold and
 * `messageRowAnchorIds` derive them, cursor paging in either direction with
 * pages ordered in the direction of travel.
 */
function findMessages(
  messages: ChatMessage[],
  body: FindMessagesRequest
): FindMessagesResponse {
  const assigned = new Set<string>();
  const all: FindMessagesResponse["rows"] = [];
  let occurrences = 0;
  const needle = body.text.toLowerCase();
  messages.forEach((message, index) => {
    let anchor = message.id ?? `msg-${index}`;
    while (assigned.has(anchor)) anchor += `#${index}`;
    assigned.add(anchor);
    const role = body.projection.unlabeled_roles.includes(message.role)
      ? ""
      : message.role;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
    const source = role + content;
    const lower = source.toLowerCase();
    const texts = new Set<string>();
    let count = 0;
    for (
      let at = lower.indexOf(needle);
      needle && at !== -1;
      at = lower.indexOf(needle, at + needle.length)
    ) {
      texts.add(source.slice(at, at + needle.length));
      count++;
    }
    if (count > 0) {
      all.push({ anchor, index, count, texts: [...texts] });
      occurrences += count;
    }
  });
  const backward = body.direction === "backward";
  let start = backward ? all.length - 1 : 0;
  if (body.cursor) {
    const { anchor } = body.cursor;
    const at = all.findIndex((row) => row.anchor === anchor);
    start = backward ? at - 1 : at + 1;
  }
  const rows: FindMessagesResponse["rows"] = [];
  for (
    let i = start;
    i >= 0 && i < all.length && rows.length < body.limit;
    i += backward ? -1 : 1
  ) {
    rows.push(all[i]!);
  }
  return {
    rows,
    total: { rows: all.length, occurrences, relation: "eq" },
    complete: true,
  };
}
