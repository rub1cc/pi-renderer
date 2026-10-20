import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth,
} from "@earendil-works/pi-tui";
import { createCodemodeRenderers } from "../codemode.ts";
import { toolArgumentSummary, toolLabel } from "../labels.ts";

beforeAll(async () => { await initTheme("light", false); });
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const script = "const secret = await tools.bash({command: 'npm test'});\ntext(secret);";

function call(id: string, name = "bash", status = "ok", args: unknown = { command: "npm test" }, extra = {}) {
  return { id, name, status, args: JSON.stringify(args), durationMs: 1500, ...extra };
}
function result(calls: any[] = [], output = "raw output", failed = false, extra = {}) {
  return {
    content: [
      { type: "text", text: `Script ${failed ? "failed" : "completed"}\nWall time 2.1 seconds\nOutput:\n` },
      { type: "text", text: output },
    ],
    details: { calls, ...extra },
  } as any;
}
function setup(overrides = {}) {
  const renderers = createCodemodeRenderers();
  const context: any = {
    args: { code: script }, state: {}, toolCallId: "codemode-1", cwd: "/repo",
    invalidate() {}, lastComponent: undefined, executionStarted: true, argsComplete: true,
    isPartial: true, expanded: false, showImages: false, isError: false, ...overrides,
  };
  const header = renderers.renderCall(context.args, theme, context);
  let body: ReturnType<typeof renderers.renderResult>;
  return {
    renderers, context, header,
    update(value: any, partial = false, expanded = false) {
      context.isPartial = partial;
      context.expanded = expanded;
      renderers.renderCall(context.args, theme, { ...context, lastComponent: header });
      body = renderers.renderResult(value, { expanded, isPartial: partial }, theme,
        { ...context, lastComponent: body });
      return body;
    },
    rows(width = 120) {
      return [...header.render(width), ...(body?.render(width) ?? [])].map(stripTerminalSequences);
    },
  };
}

describe("compact Codemode presentation", () => {
  test("uses the agreed label without exposing code in a collapsed header", () => {
    expect(toolLabel("codemode")).toBe("Codemode");
    expect(toolArgumentSummary("codemode", { code: script })).toBe("script");
    for (const [overrides, status] of [
      [{ executionStarted: false, argsComplete: false }, "preparing"],
      [{ executionStarted: false }, "waiting"],
      [{}, "running"],
    ] as const) {
      const view = setup(overrides);
      expect(view.rows()).toHaveLength(1);
      expect(view.rows()[0]).toContain(`Codemode · ${status}`);
      expect(view.rows().join("\n")).not.toContain("secret");
      expect(view.rows().join("\n")).not.toContain("npm test");
    }
  });

  test("live progress uses actual calls and the most recently started still-running target", () => {
    const view = setup();
    const calls = [call("a", "bash", "running", { command: "first command" }),
      call("b", "bash", "running", { command: "second command" }),
      call("c", "read", "ok", { path: "finished.txt" })];
    view.update({ content: [], details: { calls } }, true);
    expect(view.rows()[0]).toContain("2 Bash calls, 1 Read call · 2 running");
    expect(view.rows()[1]).toContain("Bash: second command");
    expect(view.rows().join("\n")).not.toContain("finished.txt");
    view.update({ content: [], details: { calls: [calls[0], { ...calls[1], status: "ok" }, calls[2]] } }, true);
    expect(view.rows()[1]).toContain("Bash: first command");
  });

  test("successful scripts become a single row using wall time, not summed child durations", () => {
    const view = setup();
    view.update(result([call("a"), call("b")], "{\"large\":\"JSON output\"}"));
    expect(view.rows()).toEqual(["• Codemode · 2 Bash calls · 2.1s"]);
    expect(view.rows()[0]).not.toContain("3.0s");
    expect(view.rows()[0]).not.toContain("passed");
    view.context.durationMs = 2500;
    view.update(result([call("a")]));
    expect(view.rows()).toEqual(["• Codemode · 1 Bash call · 2.5s"]);
  });

  test("script-only and missing-metadata results do not invent child calls or parse the source", () => {
    const view = setup();
    view.context.args.code = "for (let i = 0; i < 500; i++) await tools.read({path: String(i)});";
    view.update({ content: [{ type: "text", text: "done" }], details: undefined });
    expect(view.rows()).toEqual(["• Codemode · script completed"]);
    view.update(result([]));
    expect(view.rows()).toEqual(["• Codemode · 2.1s"]);
  });

  test("expansion reveals the full highlighted script, call metadata, costs and output", () => {
    const view = setup();
    const value = result([call("a", "bash", "ok", { command: "npm test" }, { cost: 0.001 })],
      "first line\n" + "middle line\n".repeat(30) + "last line");
    const before = JSON.stringify(value);
    const originalBody = view.update(value);
    expect(view.update(value, false, true)).toBe(originalBody);
    const output = view.rows().join("\n");
    for (const text of ["const secret", "tools.bash", "Nested calls", "Bash (ok)", "npm test", "$0.0010", "first line", "last line"]) {
      expect(output).toContain(text);
    }
    expect(output).not.toContain("Script completed\nWall time");
    view.update(value, false, false);
    expect(view.rows()).toEqual(["• Codemode · 1 Bash call · 2.1s"]);
    expect(JSON.stringify(value)).toBe(before);
  });

  test("caught nested failures stay visible without falsely reporting that the script failed", () => {
    const view = setup();
    view.update(result([call("a", "bash", "error", {}, { error: "Permission denied" }), call("b")], "Handled error"));
    expect(view.rows()[0]).toContain("1 nested call failed");
    expect(view.rows()[0]).not.toContain("script failed");
    expect(view.rows().join("\n")).toContain("Bash: Permission denied");
    expect(view.rows().join("\n")).not.toContain("Handled error");
  });

  test("failures stay at the front of a clipped mixed-tool summary", () => {
    const view = setup();
    view.update(result([
      call("a", "a_very_long_custom_tool_name", "ok"),
      call("b", "another_very_long_tool_name", "error", {}, { error: "Denied" }),
    ]));
    expect(view.rows(48)[0]).toStartWith("• Codemode · 1 nested call failed");
    expect(view.rows(48).some(line => line.includes("Denied"))).toBe(true);
  });

  test("live nested failure metadata does not leak into the final script-only snapshot", () => {
    const view = setup();
    view.update({ content: [], details: { calls: [call("a", "bash", "error", {}, { error: "Denied" })] } }, true);
    expect(view.rows().join("\n")).toContain("Denied");
    view.update(result([]));
    expect(view.rows()).toEqual(["• Codemode · 2.1s"]);
  });

  test("caught errors remain visible while subsequent nested calls continue running", () => {
    const view = setup();
    view.update({ content: [], details: { calls: [
      call("a", "bash", "error", {}, { error: "Denied" }),
      call("b", "read", "running", { path: "/repo/next.txt" }),
    ] } }, true);
    expect(view.rows().join("\n")).toContain("Bash: Denied");
    expect(view.rows().join("\n")).toContain("Read: next.txt");
    expect(view.rows()[0]).toContain("1 running");
  });

  test("script errors show their diagnostic instead of burying it behind partial output", () => {
    const view = setup();
    view.update(result([], "prior output\n".repeat(100) + "Script error:\nReferenceError: missingName is not defined", true));
    expect(view.rows()[0]).toContain("script failed");
    expect(view.rows().join("\n")).toContain("ReferenceError: missingName");
    expect(view.rows().join("\n")).not.toContain("prior output");
    view.context.isError = true;
    view.update({ content: [{ type: "text", text: "Invalid options line" }], details: undefined });
    expect(view.rows().join("\n")).toContain("Invalid options line");
  });

  test("script-emitted error markers cannot bury the final runtime diagnostic", () => {
    const view = setup();
    view.update(result([], "Script error:\nNot the exception\n" + "ordinary output\n".repeat(100) +
      "Script error:\nReferenceError: actualException", true));
    expect(view.rows().join("\n")).toContain("ReferenceError: actualException");
    expect(view.rows().join("\n")).not.toContain("Not the exception");
  });

  test("cancelled children are distinct from completed scripts and successful child calls", () => {
    const view = setup();
    view.update(result([call("a", "bash", "cancelled")]));
    expect(view.rows()[0]).toContain("1 nested call cancelled");
    expect(view.rows()[1]).toContain("Nested call cancelled");
    expect(view.rows()[0]).not.toContain("script failed");
  });

  test("an earlier cancellation cannot hide a later child error diagnostic", () => {
    const view = setup();
    view.update(result([call("a", "read", "cancelled"),
      call("b", "bash", "error", {}, { error: "Critical diagnostic" })]));
    expect(view.rows()[0]).toContain("1 nested call failed");
    expect(view.rows()[0]).toContain("1 nested call cancelled");
    expect(view.rows().join("\n")).toContain("Bash: Critical diagnostic");
  });

  test("Bash exit-code output is not interpreted as an execution success or a thrown failure", () => {
    const view = setup();
    view.update(result([call("a")], JSON.stringify({ exit_code: 1, output: "Tests failed" })));
    expect(view.rows()).toEqual(["• Codemode · 1 Bash call · 2.1s"]);
    expect(view.rows()[0]).not.toContain("passed");
    view.update(result([call("a")], "Tests failed", true));
    expect(view.rows().join("\n")).toContain("script failed");
    expect(view.rows().join("\n")).toContain("Tests failed");
  });

  test("unknown tools and truncated metadata never leak raw payloads into the live preview", () => {
    const view = setup();
    for (const child of [
      call("a", "custom_tool", "running", { token: "private token" }),
      call("a", "bash", "running", {}, { args: "{\"command\":\"truncated secret" }),
      call("a", "agent_browser_code", "running", { code: "private browser source" }),
    ]) {
      view.update({ content: [], details: { calls: [child] } }, true);
      expect(view.rows().join("\n")).not.toContain("private");
      expect(view.rows().join("\n")).not.toContain("truncated secret");
    }
  });

  test("full-output references stay visible on success, failure and expansion", () => {
    const view = setup();
    for (const failed of [false, true]) {
      for (const expanded of [false, true]) {
        view.update(result([], "output", failed, { fullOutputPath: "/tmp/codemode-output.txt" }), false, expanded);
        expect(view.rows().join("\n")).toContain("Full output: /tmp/codemode-output.txt");
      }
    }
  });

  test("images and their saved-file captions remain visible when successful output is collapsed", () => {
    const view = setup();
    const value = result();
    value.content.push({ type: "text", text: "[Image saved to /tmp/result.png (image/png, 10KB)]" },
      { type: "image", data: "unchanged", mimeType: "image/png" });
    const before = JSON.stringify(value);
    view.update(value);
    expect(view.rows()[0]).toContain("1 image");
    expect(view.rows().join("\n")).toContain("/tmp/result.png");
    expect(view.rows().join("\n")).not.toContain("unchanged");
    expect(JSON.stringify(value)).toBe(before);
  });

  test("untrusted data and mixed summaries stay width-safe at narrow widths", () => {
    const view = setup();
    view.context.args.code = "// script \u001b[2J\ntext(\"\u001b]52;c;payload\u0007\");";
    const value = result([call("a", "unknown\u001b[2J", "error", {}, { error: "bad\u001b[2J\u001b]52;c;payload\u0007 文件👋" })],
      "output\u001b[2J", true, { fullOutputPath: "/tmp/\u001b[2Joutput.txt" });
    for (const expanded of [false, true]) {
      view.update(value, false, expanded);
      for (const width of [1, 2, 3, 6, 16, 80]) {
        const rows = view.rows(width);
        expect(rows.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(rows.join("\n")).not.toContain("\u001b");
      }
    }
  });

  test("malformed older details fail open without throwing during rendering", () => {
    const view = setup();
    for (const details of [undefined, null, {}, { calls: {} }, { calls: [null, {}, { name: 3 }, call("a")] },
      { calls: [call("a", "bash", "error", {}, { error: { toString: null }, args: { toString: null } })] }]) {
      for (const expanded of [false, true]) {
        expect(() => view.update({ content: [{ type: "text", text: "output" }], details }, false, expanded)).not.toThrow();
        expect(view.rows()[0]).toContain("Codemode");
      }
    }
  });
});

describe("Codemode native host integration", () => {
  test("native clicks and global expansion reveal details without the colored card", () => {
    const tool = new ToolExecutionComponent("codemode", "cm-1", { code: script }, { showImages: false },
      createCodemodeRenderers(), { requestRender() {} } as any, "/repo");
    tool.updateResult({ ...result([call("a"), call("b")]), durationMs: 2100 });
    const rows = () => tool.render(120).map(stripTerminalSequences);
    expect(rows()).toEqual(["", "• Codemode · 2 Bash calls · 2.1s"]);
    expect(tool.render(120).join("\n")).not.toMatch(/\u001b\[48/);
    const event = { type: "click", button: "left", x: 3, y: 1, screenX: 3, screenY: 1,
      width: 120, height: 2, shift: false, alt: false, ctrl: false } as any;
    expect(tool.handleMouse(event)?.handled).toBe(true);
    expect(rows().join("\n")).toContain("const secret");
    expect(rows().join("\n")).toContain("raw output");
    tool.setExpanded(false);
    expect(rows()).toHaveLength(2);
    tool.setExpanded(true);
    expect(rows().join("\n")).toContain("Nested calls");
  });

  test("replayed results reproduce the same summary and do not depend on live timers", () => {
    const make = () => new ToolExecutionComponent("codemode", "cm-1", { code: script }, { showImages: false },
      createCodemodeRenderers(), { requestRender() {} } as any, "/repo");
    const live = make();
    live.markExecutionStarted();
    live.updateResult({ content: [], details: { calls: [call("a", "bash", "running")] } }, true);
    live.updateResult(result([call("a")]));
    const replay = make();
    replay.updateResult(result([call("a")]));
    expect(live.render(80)).toEqual(replay.render(80));
    for (const component of [live, replay]) component.invalidate();
    expect(live.render(80)).toEqual(replay.render(80));
  });

  test("Pi still owns image payloads and renders them without expansion", () => {
    const previous = getCapabilities();
    setCapabilities({ ...previous, images: "kitty" });
    try {
      const image = { type: "image", mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" };
      const value = result();
      value.content.push(image);
      const before = JSON.stringify(value);
      const tool = new ToolExecutionComponent("codemode", "cm-image", { code: "image(result)" }, { showImages: true },
        createCodemodeRenderers(), { requestRender() {} } as any, "/repo");
      tool.updateResult(value);
      expect(tool.render(80).join("\n")).toContain("\u001b_G");
      expect(JSON.stringify(value)).toBe(before);
    } finally { setCapabilities(previous); }
  });
});
