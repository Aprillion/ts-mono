import type { NetworkFixture } from "@msw/playwright";
import type { Page } from "@playwright/test";

import type { ChatMessage } from "@tsmono/inspect-common/types";

import { expect, test } from "./fixtures/app";
import { serveEvalLog } from "./fixtures/serve-log";
import { createEvalLog, createEvalSample } from "./fixtures/test-data";

const LOG_FILE = "test-messages-find.json";

// 300 rows; two hits in row 10, the third near the end of a 3000-line row
// 250 that the list has never rendered when the band opens.
const messages = (): ChatMessage[] =>
  Array.from({ length: 300 }, (_, index): ChatMessage => {
    let content = `message ${index}`;
    if (index === 10) content = "needle appears here and needle appears again";
    if (index === 250) {
      content = Array.from({ length: 3000 }, (_, line) =>
        line === 2950 ? "the final needle" : `tall row line ${line}`
      ).join("\n\n");
    }
    return {
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      source: index % 2 === 0 ? "input" : "generate",
      content,
    };
  });

const openMessages = async (page: Page, network: NetworkFixture) => {
  const sample = createEvalSample({
    id: 1,
    epoch: 1,
    messages: messages(),
  });
  serveEvalLog(
    network,
    createEvalLog({ samples: [sample] }),
    LOG_FILE,
    "messages-find"
  );
  await page.goto(
    `/#/logs/${encodeURIComponent(LOG_FILE)}/samples/sample/1/1/messages?message=message-10`
  );
  await expect(page.locator("[data-message-id='message-10']")).toBeVisible();
  // Tag the scroller while a known row is rendered; later reads happen with
  // other rows on screen.
  await page.locator("[data-message-id='message-10']").evaluate((node) => {
    let scroller: Element | null = node;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    if (!scroller) throw new Error("messages scroller not found");
    scroller.setAttribute("data-test-scroller", "");
  });
};

/** scrollTop of the container that scrolls the messages list, tagged by
 *  openMessages. */
const scrollerTop = (page: Page): Promise<number> =>
  page
    .locator("[data-test-scroller]")
    .evaluate((scroller) => Math.round(scroller.scrollTop));

/** scrollTop once two consecutive reads agree. */
const settledScrollerTop = async (page: Page): Promise<number> => {
  let last = await scrollerTop(page);
  await expect
    .poll(async () => {
      const next = await scrollerTop(page);
      const settled = next === last;
      last = next;
      return settled;
    })
    .toBe(true);
  return last;
};

/** The active highlight's row index and whether its rect sits inside the scroller. */
const activeMatch = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("find-active");
    const range = highlight ? [...highlight][0] : undefined;
    if (!(range instanceof Range)) return null;
    const row =
      range.startContainer.parentElement?.closest<HTMLElement>("[data-index]");
    const scroller = document.querySelector<HTMLElement>(
      "[data-test-scroller]"
    );
    if (!row || !scroller) return null;
    const matchRect = range.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      row: Number(row.dataset.index),
      text: range.toString(),
      inside:
        matchRect.top >= scrollerRect.top &&
        matchRect.bottom <= scrollerRect.bottom,
    };
  });

/** Mounted rows holding `find-match` ranges: data-index → range count. */
const matchedRows = (page: Page) =>
  page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const range of CSS.highlights.get("find-match") ?? []) {
      if (!(range instanceof Range)) continue;
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const index =
        element?.closest<HTMLElement>("[data-index]")?.dataset.index;
      if (index !== undefined) counts[index] = (counts[index] ?? 0) + 1;
    }
    return counts;
  });

test("find highlights every mounted row, not only the landed one", async ({
  page,
  network,
}) => {
  await openMessages(page, network);
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByPlaceholder("Find").fill("message");
  await expect(page.getByTestId("find-band-match-count")).toHaveText(
    "1 of 298"
  );
  await expect.poll(() => activeMatch(page)).toMatchObject({ row: 0 });
  const rows = await matchedRows(page);
  expect(Object.keys(rows).filter((index) => index !== "0")).not.toEqual([]);

  // Rows mounted by a later scroll are painted too.
  await page
    .locator("[data-test-scroller]")
    .evaluate((scroller) => scroller.scrollTo({ top: scroller.scrollHeight }));
  await expect
    .poll(async () =>
      Object.entries(await matchedRows(page)).filter(
        ([index, count]) => Number(index) >= 290 && count > 0
      )
    )
    .not.toEqual([]);
});

test("find navigates and highlights every Messages match", async ({
  page,
  network,
}) => {
  await openMessages(page, network);
  const initialTop = await settledScrollerTop(page);

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByPlaceholder("Find").fill("needle");
  const status = page.getByTestId("find-band-match-count");
  await expect(status).toHaveText("1 of 3");
  // The first hit is already on screen: the view must not move.
  expect(await scrollerTop(page)).toBe(initialTop);
  await expect
    .poll(() => activeMatch(page))
    .toEqual({ row: 10, text: "needle", inside: true });

  await page.getByPlaceholder("Find").press("Enter");
  await expect(status).toHaveText("2 of 3");
  await page.getByPlaceholder("Find").press("Enter");
  await expect(status).toHaveText("3 of 3");
  await expect
    .poll(() => activeMatch(page))
    .toEqual({ row: 250, text: "needle", inside: true });

  // No drift after the landing (markdown swap, TanStack reconcile).
  const settledTop = await settledScrollerTop(page);
  await expect.poll(() => scrollerTop(page)).toBe(settledTop);

  // Scrolled out of the render window and back, the highlight is still there.
  await page
    .locator("[data-test-scroller]")
    .evaluate((scroller) => scroller.scrollTo({ top: 0 }));
  await expect.poll(() => activeMatch(page)).toBeNull();
  await page
    .locator("[data-test-scroller]")
    .evaluate((scroller, top) => scroller.scrollTo({ top }), settledTop);
  await expect
    .poll(() => activeMatch(page))
    .toEqual({ row: 250, text: "needle", inside: true });

  // Wrap and step back.
  await page.getByPlaceholder("Find").press("Enter");
  await expect(status).toHaveText("1 of 3");
  await page.getByPlaceholder("Find").press("Shift+Enter");
  await expect(status).toHaveText("3 of 3");

  // Leaving the tab closes the band; reopened, it starts empty.
  await page.getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByPlaceholder("Find")).toHaveCount(0);
  await page.getByRole("tab", { name: "Messages" }).click();
  await expect(page.getByPlaceholder("Find")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByPlaceholder("Find")).toHaveValue("");
  await page.getByPlaceholder("Find").fill("needle");
  await expect(status).toHaveText("1 of 3");
});

test("the inline sample display closes the band when its tab changes", async ({
  page,
  network,
}) => {
  const sample = createEvalSample({ id: 1, epoch: 1, messages: messages() });
  serveEvalLog(
    network,
    createEvalLog({ samples: [sample] }),
    LOG_FILE,
    "messages-find"
  );
  // The log view with a single sample renders InlineSampleDisplay under its
  // own FindBand, a different mount from the sample-detail route above.
  await page.goto(`/#/logs/${encodeURIComponent(LOG_FILE)}`);
  await page.getByRole("tab", { name: "Messages" }).click();
  await expect(page.locator("[data-message-id='message-0']")).toBeVisible();

  // Pin the route: the sample-detail view (/samples/sample/<id>/<epoch>) is
  // the other mount, and it is covered above.
  expect(page.url()).toContain("/samples/messages");
  expect(page.url()).not.toContain("/samples/sample/");

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByPlaceholder("Find").fill("needle");
  await expect(page.getByTestId("find-band-match-count")).toHaveText("1 of 3");

  await page.getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByPlaceholder("Find")).toHaveCount(0);
});
