// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  testAssistantMessage,
  testToolCall,
  testToolMessage,
} from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";
import {
  ComponentIconProvider,
  ComponentNavigationProvider,
  foldText,
  matchRanges,
} from "@tsmono/react/components";
import { ComponentStateProvider } from "@tsmono/react/state";
import {
  makeStateHooks,
  ResizeObserverStub,
  testIcons,
} from "@tsmono/react/testing";

import { DisplayModeContext } from "../content/DisplayModeContext";
import type { DisplayMode } from "../content/DisplayModeContext";

import { ChatMessageRow } from "./ChatMessageRow";
import { messageSearchText } from "./messageSearchText";
import { buildMessageRows, messageRowOptions } from "./rowsModel";
import type { ChatViewToolOptions } from "./types";

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

/** Where one occurrence sits: the text it falls in, and its offset in it.
 *  The counted side's unit is a corpus entry, the painted side's is a DOM text
 *  node, so an agreement is also evidence that the two are cut the same way.
 *  Offsets are folded on one side and raw on the other, which only coincide
 *  while the fixtures stay ASCII. */
interface Occurrence {
  unit: string;
  at: number;
}

const countedOccurrences = (texts: string[], folded: string): Occurrence[] => {
  const out: Occurrence[] = [];
  for (const text of texts) {
    const unit = foldText(text);
    for (
      let at = unit.indexOf(folded);
      at !== -1;
      at = unit.indexOf(folded, at + folded.length)
    ) {
      out.push({ unit, at });
    }
  }
  return out;
};

interface CorpusOptions {
  toolCallStyle?: ChatViewToolOptions["callStyle"];
  displayMode?: DisplayMode;
}

/** The painted ranges and the counted occurrences for one row and one term. */
const corpora = (
  messages: ChatMessage[],
  term: string,
  options: CorpusOptions = {}
) => {
  const rows = buildMessageRows(
    messages,
    messageRowOptions({ callStyle: options.toolCallStyle })
  );
  const row = rows[0];
  if (!row) throw new Error("no row built");
  const { container } = render(
    <ComponentStateProvider hooks={makeStateHooks()}>
      <ComponentIconProvider icons={testIcons}>
        <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
          <DisplayModeContext.Provider
            value={{ displayMode: options.displayMode ?? "rendered" }}
          >
            <ChatMessageRow
              index={0}
              parentName="corpus"
              resolvedMessage={row.resolved}
              tools={{ callStyle: options.toolCallStyle }}
            />
          </DisplayModeContext.Provider>
        </ComponentNavigationProvider>
      </ComponentIconProvider>
    </ComponentStateProvider>
  );
  const folded = foldText(term);
  return {
    painted: matchRanges(container, folded).map((range): Occurrence => ({
      unit: foldText(range.startContainer.textContent ?? ""),
      at: range.startOffset,
    })),
    counted: countedOccurrences(
      messageSearchText(row.resolved, {
        toolCallStyle: options.toolCallStyle,
        displayMode: options.displayMode,
      }),
      folded
    ),
  };
};

/** The same occurrences in the same order and the same places (K1). */
const expectAgreement = (
  messages: ChatMessage[],
  terms: string[],
  options: CorpusOptions = {}
) => {
  for (const term of terms) {
    const { painted, counted } = corpora(messages, term, options);
    expect({ term, counted }).toEqual({ term, counted: painted });
  }
};

describe("the counted corpus and the painted corpus", () => {
  it("agree on the role heading and the position chip", () => {
    expectAgreement(
      [
        {
          id: "m-1",
          role: "user",
          source: "input",
          content: "ask the user 1 twice",
        },
      ],
      ["user", "1", "twice"]
    );
  });

  it("agree on a tool call's rendered signature and input", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "running it",
          tool_calls: [
            {
              id: "call-1",
              function: "bash",
              arguments: { cmd: "ls needle" },
              type: "function",
              parse_error: null,
              view: null,
            },
          ],
        }),
      ],
      // "cmd" and the JSON quoting around it are counted-only when the data
      // side stringifies the arguments instead of mirroring the input zone.
      ["assistant", "needle", "cmd", "bash", "ls"]
    );
  });

  it("agree on a tool response rendered in the output well", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "marker asking",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "bash",
              arguments: { cmd: "marker running" },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "bash",
          content: "marker answered",
        }),
      ],
      ["marker", "bash"]
    );
  });

  it("agree across two tool calls in one row", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "bash",
              arguments: { cmd: "marker alpha" },
            }),
            testToolCall({
              id: "c2",
              function: "bash",
              arguments: { cmd: "marker beta" },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "bash",
          content: "marker gamma",
        }),
        testToolMessage({
          id: "m-3",
          tool_call_id: "c2",
          function: "bash",
          content: "marker delta",
        }),
      ],
      ["marker"]
    );
  });

  it("agree on a submit call, which renders as a custom view", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "submit",
              arguments: { answer: "marker final" },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "submit",
          content: "marker final",
        }),
      ],
      ["marker", "submit"]
    );
  });

  it("agree on a call whose input zone comes from its view", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "marker asking",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "web_browser",
              arguments: { url: "marker-url" },
              view: {
                title: "marker browser",
                format: "markdown",
                content: "marker viewed",
              },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "web_browser",
          content: "marker fetched",
        }),
      ],
      ["marker"]
    );
  });

  it("agree on an answer call, which renders as source code", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "answer",
              arguments: { answer: "marker chosen" },
            }),
          ],
        }),
      ],
      ["marker", "answer"]
    );
  });

  it("leaves a custom view it does not mirror out of both corpora", () => {
    const messages = [
      testAssistantMessage({
        id: "m-1",
        content: "marker asking",
        tool_calls: [
          testToolCall({ id: "c1", function: "tool_search", arguments: {} }),
        ],
      }),
      testToolMessage({
        id: "m-2",
        tool_call_id: "c1",
        function: "tool_search",
        content: JSON.stringify([
          { name: "marker ns", description: "marker desc", tools: [] },
        ]),
      }),
    ];
    expectAgreement(messages, ["marker"]);
    // Only the message content matches: the view's own markup is unsearchable.
    expect(corpora(messages, "marker").painted).toEqual([
      { unit: "marker asking", at: 0 },
    ]);
  });

  it("agree when a tool call fails", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "marker asking",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "bash",
              arguments: { cmd: "marker running" },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "bash",
          content: "",
          error: { type: "unknown", message: "marker exploded" },
        }),
      ],
      ["marker"]
    );
  });

  it("agree on a Codex result the view reshapes before rendering", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "marker asking",
          tool_calls: [
            testToolCall({
              id: "c1",
              function: "spawn_agent",
              arguments: { agent_type: "marker agent" },
            }),
          ],
        }),
        testToolMessage({
          id: "m-2",
          tool_call_id: "c1",
          function: "spawn_agent",
          content: JSON.stringify({
            agent_id: "marker-id",
            nickname: "marker nickname",
          }),
        }),
      ],
      ["marker"]
    );
  });

  it("agree in raw mode, where no custom view renders", () => {
    const messages = [
      testAssistantMessage({
        id: "m-1",
        content: "marker asking",
        tool_calls: [
          testToolCall({
            id: "c1",
            function: "submit",
            arguments: { answer: "marker final" },
          }),
          testToolCall({ id: "c2", function: "tool_search", arguments: {} }),
        ],
      }),
      testToolMessage({
        id: "m-2",
        tool_call_id: "c1",
        function: "submit",
        content: "marker final",
      }),
      testToolMessage({
        id: "m-3",
        tool_call_id: "c2",
        function: "tool_search",
        content: JSON.stringify([
          { name: "marker ns", description: "marker desc", tools: [] },
        ]),
      }),
    ];
    expectAgreement(messages, ["marker", "submit"], { displayMode: "raw" });
    // Raw mode renders both as plain tool blocks, so the catalog is searchable.
    expect(
      corpora(messages, "marker ns", { displayMode: "raw" }).painted
    ).toHaveLength(1);
  });

  it("agree when the row renders its tool calls compactly, or not at all", () => {
    const messages = [
      testAssistantMessage({
        id: "m-1",
        content: "marker asking",
        tool_calls: [
          testToolCall({
            id: "c1",
            function: "bash",
            arguments: { cmd: "marker running" },
          }),
        ],
      }),
      testToolMessage({
        id: "m-2",
        tool_call_id: "c1",
        function: "bash",
        content: "marker answered",
      }),
    ];
    expectAgreement(messages, ["marker", "tool"], {
      toolCallStyle: "compact",
    });
    expectAgreement(messages, ["marker"], { toolCallStyle: "omit" });
  });

  it("agree on a call whose args stay in the header summary", () => {
    expectAgreement(
      [
        testAssistantMessage({
          id: "m-1",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              function: "lookup",
              arguments: { needle: "haystack" },
              type: "function",
              parse_error: null,
              view: null,
            },
          ],
        }),
      ],
      ["assistant", "needle", "haystack", "lookup"]
    );
  });
});
