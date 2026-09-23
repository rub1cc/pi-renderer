import { beforeAll, describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type CodexRenderState,
  TreeOutputComponent,
  formatDuration,
} from "../components.ts";
import {
  type BashCodexRenderState,
  type RendererClock,
  createCodexBashRenderers,
  editRenderers,
  findRenderers,
  grepRenderers,
  lsRenderers,
  readRenderers,
  writeRenderers,
} from "../renderers.ts";
import { createGenericToolRenderers } from "../generic.ts";

beforeAll(async () => {
  await initTheme("light", false);
});

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;

function render(component: { render(width: number): string[] }, width = 80): string[] {
  return component.render(width).map(stripTerminalSequences);
}

function context<TArgs, TState extends CodexRenderState>(
  args: TArgs,
  state: TState,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    args,
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state,
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  } as any;
}

function textResult(text: string, details?: unknown): AgentToolResult<any> {
  return { content: [{ type: "text", text }], details };
}

describe("shared components", () => {
  test("formats durations across units", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1_400)).toBe("1.4s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_665_000)).toBe("1h 01m 05s");
  });

  test("bounds head and tail previews by visual rows", () => {
    const head = new TreeOutputComponent({
      text: "one\ntwo\nthree\nfour\nfive",
      expanded: false,
      previewRows: 3,
      direction: "head",
      theme,
    });
    const headLines = render(head);
    expect(headLines.join("\n")).toContain("one");
    expect(headLines.join("\n")).not.toContain("five");
    expect(headLines.at(-1)).toContain("+2 lines");

    const tail = new TreeOutputComponent({
      text: "one\ntwo\nthree\nfour\nfive",
      expanded: false,
      previewRows: 3,
      direction: "tail",
      theme,
    });
    const tailLines = render(tail);
    expect(tailLines[0]).toContain("+2 earlier lines");
    expect(tailLines.join("\n")).not.toContain("one");
    expect(tailLines.join("\n")).toContain("five");
  });

  test("sanitizes control sequences and respects narrow widths", () => {
    const component = new TreeOutputComponent({
      text: "\u001b[31mred\u001b[0m and a very long output line",
      expanded: true,
      theme,
    });
    const lines = component.render(12);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(render(component, 12).join(" ")).toContain("red");
  });
});

describe("bash renderer", () => {
  test("transitions Running to Ran, keeps tail output, and freezes duration", () => {
    let now = 1_000;
    let cleared = false;
    const timer = { unref() {} } as ReturnType<typeof setInterval>;
    const clock: RendererClock = {
      now: () => now,
      setInterval: () => timer,
      clearInterval: (handle) => {
        expect(handle).toBe(timer);
        cleared = true;
      },
    };
    const renderers = createCodexBashRenderers(clock);
    const state: BashCodexRenderState = {};
    const ctx = context(
      { command: "npm test", timeout: 120 },
      state,
      { isPartial: true },
    );

    const call = renderers.renderCall(ctx.args, theme, ctx);
    expect(render(call).join("\n")).toContain("Running npm test");

    now = 2_400;
    ctx.isPartial = false;
    ctx.lastComponent = call;
    expect(renderers.renderCall(ctx.args, theme, ctx)).toBe(call);
    expect(render(call).join("\n")).toContain("Ran npm test");
    expect(render(call).join("\n")).toContain("1.4s");
    expect(cleared).toBe(true);

    const result = renderers.renderResult(
      textResult("one\ntwo\nthree\nfour\nfive"),
      { expanded: false, isPartial: false },
      theme,
      { ...ctx, lastComponent: undefined },
    );
    const resultLines = render(result);
    expect(resultLines[0]).toContain("+2 earlier lines");
    expect(resultLines.join("\n")).toContain("five");
  });

  test("renders exit failures semantically", () => {
    const clock: RendererClock = {
      now: () => 2_000,
      setInterval: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    };
    const renderers = createCodexBashRenderers(clock);
    const state: BashCodexRenderState = { startedAt: 1_000 };
    const ctx = context(
      { command: "false" },
      state,
      { isError: true, isPartial: false },
    );
    const call = renderers.renderCall(ctx.args, theme, ctx);
    renderers.renderResult(
      textResult("Command exited with code 2"),
      { expanded: false, isPartial: false },
      theme,
      { ...ctx, lastComponent: undefined },
    );
    expect(render(call).join("\n")).toContain("Failed (exit 2) false");
  });
});

describe("built-in renderers", () => {
  test("uses semantic completed labels", () => {
    const cases = [
      [readRenderers, { path: "src/a.ts" }, "Read src/a.ts"],
      [grepRenderers, { pattern: "foo", path: "src" }, "Searched /foo/ in src"],
      [findRenderers, { pattern: "*.ts", path: "src" }, "Searched *.ts in src"],
      [lsRenderers, { path: "src" }, "Listed src"],
      [writeRenderers, { path: "src/a.ts", content: "one\ntwo\n" }, "Wrote src/a.ts (2 lines)"],
    ] as const;

    for (const [tool, args, expected] of cases) {
      const ctx = context(args, {});
      const call = tool.renderCall(args as any, theme, ctx);
      expect(render(call).join("\n")).toContain(expected);
      expect(tool.renderShell).toBe("self");
    }
  });

  test("keeps read output collapsed and reveals it when expanded", () => {
    const ctx = context({ path: "src/a.ts" }, {});
    const collapsed = readRenderers.renderResult(
      textResult("const value = 1;"),
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    expect(render(collapsed)).toEqual([]);

    const expanded = readRenderers.renderResult(
      textResult("const value = 1;"),
      { expanded: true, isPartial: false },
      theme,
      ctx,
    );
    expect(render(expanded).join("\n")).toContain("const value = 1;");
  });

  test("leaves image payload rendering to Pi", () => {
    const ctx = context({ path: "image.png" }, {});
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: undefined,
    } as AgentToolResult<any>;
    const component = readRenderers.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      ctx,
    );
    expect(render(component)).toEqual([]);
  });

  test("renders write content as a bounded expandable preview", () => {
    const args = { path: "notes.txt", content: "one\ntwo\nthree\nfour" };
    const ctx = context(args, {});
    const collapsed = writeRenderers.renderResult(
      textResult("Successfully wrote to notes.txt"),
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    expect(render(collapsed).join("\n")).toContain("+1 line");

    const expanded = writeRenderers.renderResult(
      textResult("Successfully wrote to notes.txt"),
      { expanded: true, isPartial: false },
      theme,
      ctx,
    );
    expect(render(expanded).join("\n")).toContain("four");
  });

  test("adds edit statistics and a collapsed diff", () => {
    const args = {
      path: "src/a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    };
    const state = {};
    const ctx = context(args, state);
    const call = editRenderers.renderCall(args, theme, ctx);
    editRenderers.renderResult(
      textResult("Successfully replaced 1 block(s) in src/a.ts.", {
        diff: " 1 before\n-2 old\n+2 new\n 3 after",
        patch: "",
      }),
      { expanded: false, isPartial: false },
      theme,
      { ...ctx, lastComponent: undefined },
    );
    expect(render(call).join("\n")).toContain("Edited src/a.ts (+1 -1)");
  });
});

describe("generic extension-tool renderer", () => {
  test("renders compact Calling and Called states", () => {
    const renderers = createGenericToolRenderers("TaskUpdate");
    const args = { taskId: "6", status: "completed" };
    const state = {};
    const active = context(args, state, { isPartial: true });
    const call = renderers.renderCall(args, theme, active);
    expect(render(call).join("\n")).toContain(
      'Calling TaskUpdate({"taskId":"6","status":"completed"})',
    );

    const completed = { ...active, isPartial: false, lastComponent: call };
    expect(renderers.renderCall(args, theme, completed)).toBe(call);
    expect(render(call).join("\n")).toContain("Called TaskUpdate");

    const output = renderers.renderResult(
      textResult("one\ntwo\nthree\nfour"),
      { expanded: false, isPartial: false },
      theme,
      { ...completed, lastComponent: undefined },
    );
    expect(render(output).join("\n")).toContain("+1 line");
  });

  test("renders failed extension calls without unsafe control sequences", () => {
    const renderers = createGenericToolRenderers("unsafe\u001b[31m-tool");
    const ctx = context({}, {}, { isPartial: false, isError: true });
    const call = renderers.renderCall({}, theme, ctx);
    expect(render(call).join("\n")).toContain("Failed unsafe-tool");

    const output = renderers.renderResult(
      textResult("\u001b[31mboom\u001b[0m"),
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    expect(render(output).join("\n")).toContain("boom");
  });
});

