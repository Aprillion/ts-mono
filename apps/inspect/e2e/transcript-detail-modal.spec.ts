/**
 * E2E coverage for the "open message details in a modal" transcript option.
 *
 * With the option on, a model call's detail tabs (Info / Messages / API) open
 * in a modal overlay with their own scroll context instead of expanding inline,
 * while the inline card keeps showing the Summary tab.
 */
import { http, HttpResponse } from "msw";

import type {
  ChatMessage,
  EvalSample,
  ModelEvent,
  ModelOutput,
} from "@tsmono/inspect-common/types";

import { expect, test } from "./fixtures/app";
import {
  createEvalLog,
  createEvalSample,
  createLogDetails,
  createModelOutput,
} from "./fixtures/test-data";

const LOG_FILE = "test-detail-modal.json";

type Events = EvalSample["events"];

const REQUEST_MARKER = "ANALYZE_THIS_REQUEST_PAYLOAD";
const RESPONSE_MARKER = "MODEL_RESPONSE_PAYLOAD";
const INPUT_MARKER = "Full input message for the Messages tab";

function createModelEventWithCall(): ModelEvent {
  const output: ModelOutput = createModelOutput("Inline summary answer.");
  return {
    event: "model",
    uuid: "model-evt-modal",
    model: "claude-sonnet-4-5-20250929",
    input: [{ role: "user", content: INPUT_MARKER, id: null }],
    output,
    config: {},
    tools: [],
    tool_choice: "auto",
    timestamp: "2025-01-15T10:00:00Z",
    working_start: 0,
    working_time: 3,
    error: null,
    traceback_ansi: null,
    // `call` drives the API tab — give it enough content that the size
    // indicator and scroll containment are meaningful.
    call: {
      request: {
        model: "claude-sonnet-4-5",
        marker: REQUEST_MARKER,
        messages: Array.from({ length: 40 }, (_, i) => ({
          role: "user",
          content: `line ${i}`,
        })),
      },
      response: { id: "resp_1", marker: RESPONSE_MARKER, output: "ok" },
      time: 1.5,
    },
  } as ModelEvent;
}

async function openTranscript(
  page: Parameters<Parameters<typeof test>[2]>[0]["page"],
  network: Parameters<Parameters<typeof test>[2]>[0]["network"],
  events: Events
) {
  const sampleId = 1;
  const messages: ChatMessage[] = [
    { role: "user", content: "Hello", source: "input" },
    { role: "assistant", content: "Hi there", source: "generate" },
  ];
  const sample = createEvalSample({ id: sampleId, epoch: 1, messages });
  (sample as { events: Events }).events = events;
  const evalLog = createEvalLog({ samples: [sample] });
  const logDetails = createLogDetails(evalLog);

  network.use(
    http.get("*/api/log-files*", () =>
      HttpResponse.json({
        files: [{ name: LOG_FILE, task: "chat-test", task_id: "chat-test" }],
        response_type: "full",
      })
    ),
    http.get("*/api/logs/:file", () => HttpResponse.json(evalLog)),
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

  const encodedFile = encodeURIComponent(LOG_FILE);
  await page.goto(
    `/#/logs/${encodedFile}/samples/sample/${sampleId}/1/transcript`
  );
}

test.describe("transcript detail modal option", () => {
  test.beforeEach(async ({ page }) => {
    // Turn the option on before the app boots (default is off in standalone
    // Inspect). zustand-persist merges this partial state over the defaults.
    await page.addInitScript(() => {
      localStorage.setItem(
        "inspect-view-user-settings",
        JSON.stringify({ state: { detailsInModal: true }, version: 0 })
      );
    });
  });

  test("detail tab opens in a modal, inline keeps the summary", async ({
    page,
    network,
  }) => {
    await openTranscript(page, network, [createModelEventWithCall()]);

    await expect(page.getByText("Model Call:")).toBeVisible();
    // Inline summary is shown; the API payload is NOT inline.
    await expect(
      page.getByText("Inline summary answer.").first()
    ).toBeVisible();
    await expect(page.getByText(REQUEST_MARKER)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Clicking the API pill opens the modal with the request payload + size cue.
    await page.getByRole("tab", { name: "API" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(REQUEST_MARKER)).toBeVisible();
    await expect(dialog.getByText(/Request ·.*lines/)).toBeVisible();
    // Inline summary still present underneath.
    await expect(
      page.getByText("Inline summary answer.").first()
    ).toBeVisible();

    await page.screenshot({
      path: "/tmp/transcript-modal-api.png",
      fullPage: false,
    });

    // The modal carries its own tab nav: switch to Messages within it.
    await dialog.getByRole("tab", { name: "Messages" }).click();
    await expect(dialog.getByText(INPUT_MARKER).first()).toBeVisible();

    // Escape closes it.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
