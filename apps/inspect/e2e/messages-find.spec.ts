/**
 * E2E tests for cmd+f on the Messages tab, which searches the message rows
 * through the find coordinator (not the DOM): role headers count, matches
 * far outside the rendered window are stepped to, and the Transcript tab
 * keeps its window.find path.
 */
import type { Page } from "@playwright/test";

import type { ChatMessage } from "@tsmono/inspect-common/types";

import { expect, test } from "./fixtures/app";
import { serveEvalLog } from "./fixtures/serve-log";
import { createEvalLog, createEvalSample } from "./fixtures/test-data";

const MESSAGE_COUNT = 250;
const NEEDLE_ROWS = [5, 120, 240];

function generateMessages(options: { duplicateAssistantIds: boolean }) {
  return Array.from({ length: MESSAGE_COUNT }, (_, i): ChatMessage => {
    const assistant = i % 2 === 1;
    const needle = NEEDLE_ROWS.includes(i) ? " needle" : "";
    return {
      id: assistant && options.duplicateAssistantIds ? "shared-id" : `m${i}`,
      role: assistant ? "assistant" : "user",
      content: `message-${i}${needle}`,
      source: assistant ? "generate" : "input",
    };
  });
}

const ASSISTANT_COUNT = MESSAGE_COUNT / 2;

async function openMessages(
  page: Page,
  network: Parameters<typeof serveEvalLog>[0],
  messages: ChatMessage[],
  tab: "messages" | "transcript" = "messages"
) {
  const sample = createEvalSample({ id: 1, epoch: 1, messages });
  // Per test: against a real server the specs share one log dir.
  const logFile = `test-find-${test.info().testId}.json`;
  serveEvalLog(network, createEvalLog({ samples: [sample] }), logFile);
  await page.goto(
    `/#/logs/${encodeURIComponent(logFile)}/samples/sample/1/1/${tab}`
  );
  // The messages tab renders rows; the transcript tab of this events-less
  // sample renders the joined input paragraph (still containing "needle").
  await expect(
    page.getByText("message-0", { exact: tab === "messages" }).first()
  ).toBeVisible();
}

async function openFind(page: Page, term: string) {
  await page.keyboard.press("Control+f");
  const input = page.getByPlaceholder("Find");
  await input.fill(term);
  return input;
}

const count = (page: Page) => page.getByTestId("find-band-match-count");

/** The active highlight: its text and the row (data-find-anchor) it sits in. */
const activeHighlight = (page: Page) =>
  page.evaluate(() => {
    const active = CSS.highlights.get("find-active");
    const ranges = active ? [...active] : [];
    const first = ranges[0] as Range | undefined;
    const row =
      first?.startContainer.parentElement?.closest("[data-find-anchor]");
    // The visible box is the nearest scrolling ancestor's, not the window's.
    let scroller = row?.parentElement ?? null;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
      scroller = scroller.parentElement;
    }
    const view = scroller
      ? scroller.getBoundingClientRect()
      : new DOMRect(0, 0, innerWidth, innerHeight);
    const within = (r: DOMRect | undefined) =>
      r !== undefined && r.top >= view.top && r.bottom <= view.bottom;
    return {
      count: ranges.length,
      text: first?.cloneContents().textContent ?? null,
      rowText: row?.textContent ?? null,
      inViewport: within(row?.getBoundingClientRect()),
      rangeInViewport: within(first?.getBoundingClientRect()),
    };
  });

test.describe("messages find", () => {
  test("counts every assistant role header", async ({ page, network }) => {
    await openMessages(
      page,
      network,
      generateMessages({ duplicateAssistantIds: false })
    );

    await openFind(page, "assistant");

    await expect(count(page)).toHaveText(`1 of ${ASSISTANT_COUNT}`);
    await expect
      .poll(async () => (await activeHighlight(page)).text)
      .toBe("assistant");
  });

  test("steps to matches far outside the rendered window and wraps", async ({
    page,
    network,
  }) => {
    await openMessages(
      page,
      network,
      generateMessages({ duplicateAssistantIds: false })
    );

    const input = await openFind(page, "needle");
    await expect(count(page)).toHaveText("1 of 3");

    await input.press("Enter");
    await expect(count(page)).toHaveText("2 of 3");
    await expect
      .poll(() => activeHighlight(page))
      .toMatchObject({ count: 1, text: "needle", inViewport: true });
    expect((await activeHighlight(page)).rowText).toContain("message-120");

    await input.press("Shift+Enter");
    await input.press("Shift+Enter");
    await expect(count(page)).toHaveText("3 of 3");
    await expect
      .poll(() => activeHighlight(page))
      .toMatchObject({ count: 1, text: "needle", rangeInViewport: true });
    expect((await activeHighlight(page)).rowText).toContain("message-240");

    await input.press("Enter");
    await expect(count(page)).toHaveText("1 of 3");
    await expect
      .poll(() => activeHighlight(page))
      .toMatchObject({ count: 1, text: "needle", rangeInViewport: true });
    expect((await activeHighlight(page)).rowText).toContain("message-5");
  });

  test("brings the active occurrence of a row taller than the viewport into view", async ({
    page,
    network,
  }) => {
    const messages = generateMessages({ duplicateAssistantIds: false });
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    messages[60]!.content = [...lines, "tallneedle"].join("\n\n");
    await openMessages(page, network, messages);

    await openFind(page, "tallneedle");
    await expect(count(page)).toHaveText("1 of 1");
    await expect
      .poll(() => activeHighlight(page))
      .toMatchObject({ count: 1, text: "tallneedle", rangeInViewport: true });
  });

  test("keeps one active highlight when messages share an id", async ({
    page,
    network,
  }) => {
    await openMessages(
      page,
      network,
      generateMessages({ duplicateAssistantIds: true })
    );

    const input = await openFind(page, "assistant");
    await expect(count(page)).toHaveText(`1 of ${ASSISTANT_COUNT}`);

    for (const expected of ["2", "3", "4"]) {
      await input.press("Enter");
      await expect(count(page)).toHaveText(`${expected} of ${ASSISTANT_COUNT}`);
      await expect
        .poll(() => activeHighlight(page))
        .toMatchObject({ count: 1, text: "assistant" });
    }
  });

  test("shows No results and clears highlights on Escape", async ({
    page,
    network,
  }) => {
    await openMessages(
      page,
      network,
      generateMessages({ duplicateAssistantIds: false })
    );

    const input = await openFind(page, "absent-term");
    await expect(count(page)).toHaveText("No results");

    await input.fill("needle");
    await expect(count(page)).toHaveText("1 of 3");
    await expect
      .poll(() =>
        page.evaluate(() => CSS.highlights.get("find-match")?.size ?? 0)
      )
      .toBeGreaterThan(0);
    await input.press("Escape");
    await expect(input).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => CSS.highlights.get("find-match")?.size ?? 0)
      )
      .toBe(0);
  });

  test("the transcript tab still uses the window.find path", async ({
    page,
    network,
  }) => {
    await openMessages(
      page,
      network,
      generateMessages({ duplicateAssistantIds: false }),
      "transcript"
    );

    // A term inside the visible (uncollapsed) part of the input paragraph.
    const input = await openFind(page, "message-4");
    await input.press("Enter");

    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toMatch(/message-4/i);
    expect(await page.evaluate(() => CSS.highlights.has("find-active"))).toBe(
      false
    );
  });
});
