import { beforeAll, describe, expect, test } from "bun:test";
import {
  getMarkdownTheme,
  initTheme,
  InteractiveMode,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  MouseRegion,
  Text,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { readRenderers } from "../renderers.ts";

beforeAll(async () => { await initTheme("light", false); });

function call(id: string, file = `${id}.txt`, extra = {}) {
  return { type: "toolCall", id, name: "read", arguments: { path: file, ...extra } };
}

function assistant(content: any[]) {
  return { role: "assistant", content, stopReason: "toolUse", timestamp: 1 };
}

function mode() {
  const value: any = {
    isInitialized: true,
    chatContainer: new Container(),
    loadedResourcesContainer: new Container(),
    toolOutputExpanded: false,
    pendingTools: new Map(),
    sessionManager: { getCwd: () => "/repo", getEntries: () => [] },
    session: { retryAttempt: 0 },
    footer: { invalidate() {} },
    programStatus: { handleEvent() {} },
    settingsManager: {
      getShowCacheMissNotices: () => false,
      getShowImages: () => false,
      getImageWidthCells: () => 60,
    },
    ui: { requestRender() {} },
    showStatus() {},
    getMarkdownThemeWithSettings: () => getMarkdownTheme(),
    getMarkdownTransformers: () => [],
    maybeShowThinkingDropNotice() {},
    maybeShowCacheMissNotice() {},
    maybeSuggestBugReport() {},
    hideThinkingBlock: false,
    outputPad: 1,
    getRegisteredToolDefinition: (name: string) => name === "read" ? readRenderers : undefined,
    addMessageToChat(message: any) {
      this.chatContainer.addChild(new Text(message.role, 0, 0));
    },
  };
  return value;
}

function setup() {
  const host = mode();
  const controller = new ReadGroupingController(host);
  expect(controller.attach()).toBe(true);
  return { host, controller };
}

function tool(host: any, input: ReturnType<typeof call>, completed = true) {
  const component = new ToolExecutionComponent(
    input.name, input.id, input.arguments, { showImages: false },
    input.name === "read" ? readRenderers as any : undefined,
    host.ui, "/repo",
  );
  component.setExpanded(host.toolOutputExpanded);
  if (completed) component.updateResult({
    content: [{ type: "text", text: `contents of ${input.id}` }],
    details: undefined,
  });
  host.chatContainer.addChild(component);
  return component;
}

function rows(host: any, width = 80): string[] {
  return host.chatContainer.render(width).map(stripTerminalSequences);
}

function headers(host: any): any[] {
  return host.chatContainer.children.filter((child: any) =>
    !(child instanceof ToolExecutionComponent) && typeof child.setExpanded === "function",
  );
}

function clickRow(host: any, match: string, width = 80) {
  const rendered = rows(host, width);
  const y = rendered.findIndex((row) => row.includes(match));
  expect(y).toBeGreaterThanOrEqual(0);
  return host.chatContainer.handleMouse({
    type: "click", button: "left", x: 1, y,
    screenX: 1, screenY: y, width, height: rendered.length,
    shift: false, alt: false, ctrl: false,
  });
}

describe("read transcript grouping", () => {
  test("groups without replacing, nesting, or mutating original calls", () => {
    const { host, controller } = setup();
    const calls = [call("a"), call("b")];
    const message = assistant(calls);
    const before = JSON.stringify(message);
    controller.recordMessage(message);
    const originals = calls.map((input) => tool(host, input));
    expect(headers(host)).toHaveLength(1); // Available before the first render.
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent))
      .toEqual(originals);
    expect(rows(host).join("\n")).toContain("Read 2 files");
    expect(rows(host).join("\n")).not.toContain("contents of");
    expect(JSON.stringify(message)).toBe(before);
    for (const original of originals) original.setShowImages(true);
  });

  test("group click opens rows; individual clicks reveal contents", () => {
    const { host, controller } = setup();
    const calls = [call("a"), call("b")];
    controller.recordMessage(assistant(calls));
    calls.forEach((input) => tool(host, input));
    expect(clickRow(host, "Read 2 files")?.handled).toBe(true);
    expect(rows(host).join("\n")).toContain("a.txt");
    expect(rows(host).join("\n")).not.toContain("contents of a");
    expect(clickRow(host, "a.txt")?.handled).toBe(true);
    expect(rows(host).join("\n")).toContain("contents of a");
    clickRow(host, "Read 2 files");
    expect(rows(host).join("\n")).not.toContain("contents of a");
    clickRow(host, "Read 2 files");
    expect(rows(host).join("\n")).toContain("contents of a");
  });

  test("native global expansion reaches groups and original calls", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    tool(host, call("a"));
    tool(host, call("b"));
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host).join("\n")).toContain("contents of a");
    expect(rows(host).join("\n")).toContain("contents of b");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, false);
    expect(rows(host).join("\n")).not.toContain("contents of");
  });

  test("does not group across messages, thinking, text, or other tools", () => {
    for (const boundary of [
      { type: "text", text: "Preparing mapping agent" },
      { type: "thinking", thinking: "Considering next file" },
      { type: "unknown" },
      { type: "toolCall", name: "bash", id: "bash", arguments: { command: "pwd" } },
    ]) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([call("a"), boundary, call("b")]));
      tool(host, call("a"));
      tool(host, call("b"));
      expect(headers(host)).toHaveLength(0);
    }
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a")]));
    tool(host, call("a"));
    controller.recordMessage(assistant([call("b")]));
    tool(host, call("b"));
    expect(headers(host)).toHaveLength(0);
  });

  test("unknown calls and visible transcript boundaries remain ungrouped", () => {
    const { host, controller } = setup();
    tool(host, call("unknown-a"));
    tool(host, call("unknown-b"));
    expect(headers(host)).toHaveLength(0);
    controller.recordMessage(assistant([call("a"), call("b")]));
    tool(host, call("a"));
    host.chatContainer.addChild(new Text("Compacted context", 0, 0));
    tool(host, call("b"));
    expect(headers(host)).toHaveLength(0);
  });

  test("deduplicates normalized paths and preserves separate read ranges", () => {
    const { host, controller } = setup();
    const calls = [call("a", "src/a.ts", { offset: 1, limit: 10 }),
      call("b", "/repo/src/a.ts", { offset: 20, limit: 10 })];
    controller.recordMessage(assistant(calls));
    calls.forEach((input) => tool(host, input));
    expect(rows(host).join("\n")).toContain("Read 1 file");
    expect(rows(host).join("\n")).toContain("2 calls");
    clickRow(host, "Read 1 file");
    expect(rows(host).join("\n")).toContain(":1-10");
    expect(rows(host).join("\n")).toContain(":20-29");
  });

  test("late arguments/results keep the header current and failures visible", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"), false);
    const b = tool(host, call("b"), false);
    const pending = rows(host).join("\n");
    expect(pending).toContain("Reading");
    b.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
    a.updateResult({ content: [{ type: "text", text: "OK" }] });
    const failed = rows(host).join("\n");
    expect(failed).toContain("failed");
    expect(failed).toContain("b.txt");
    expect(failed).toContain("Permission denied");
    b.updateArgs({ path: "/repo/a.txt" });
    expect(rows(host).join("\n")).toContain("1 file");
  });

  test("preserves expansion when a streaming message grows", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    tool(host, call("a"));
    tool(host, call("b"));
    const header = headers(host)[0];
    clickRow(host, "Read 2 files");
    controller.recordMessage(assistant([call("a"), call("b"), call("c")]));
    tool(host, call("c"));
    expect(headers(host)[0]).toBe(header);
    expect(rows(host).join("\n")).toContain("Read 3 files");
    expect(rows(host).join("\n")).toContain("c.txt");
  });

  test("removal and clear unwrap survivors and discard orphan headers", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"));
    const b = tool(host, call("b"));
    host.chatContainer.removeChild(a);
    expect(rows(host).join("\n")).toContain("b.txt");
    expect(headers(host)).toHaveLength(0);
    host.chatContainer.removeChild(b);
    expect(rows(host)).toEqual([]);
    controller.recordMessage(assistant([call("c"), call("d")]));
    tool(host, call("c"));
    tool(host, call("d"));
    host.chatContainer.clear();
    expect(rows(host)).toEqual([]);
    expect(headers(host)).toHaveLength(0);
  });

  test("mouse targets below a group survive expansion, collapse, and resize", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a", "文件.ts"), call("b")]));
    tool(host, call("a", "文件.ts"));
    tool(host, call("b"));
    let clicked = 0;
    host.chatContainer.addChild(new MouseRegion(new Text("NEXT", 0, 0), (event) => {
      if (event.type === "click") { clicked++; return { handled: true }; }
    }));
    for (const width of [80, 24, 80]) {
      expect(rows(host, width).every((line) => visibleWidth(line) <= width)).toBe(true);
      clickRow(host, "NEXT", width);
      headers(host)[0].setExpanded(true);
      clickRow(host, "NEXT", width);
      headers(host)[0].setExpanded(false);
    }
    expect(clicked).toBe(6);
  });

  test("attachment is idempotent and unsupported shapes are untouched", () => {
    const { host, controller } = setup();
    const render = host.chatContainer.render;
    expect(controller.attach()).toBe(true);
    expect(host.chatContainer.render).toBe(render);
    const incompatible = { chatContainer: { children: [] } };
    expect(new ReadGroupingController(incompatible as any).attach()).toBe(false);
  });

  test("late metadata boundaries split an already displayed group", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    tool(host, call("a"));
    tool(host, call("b"));
    expect(headers(host)).toHaveLength(1);
    controller.recordMessage(assistant([
      call("a"), { type: "thinking", thinking: "New plan" }, call("b"),
    ]));
    expect(rows(host).join("\n")).toContain("a.txt");
    expect(rows(host).join("\n")).toContain("b.txt");
    expect(headers(host)).toHaveLength(0);
  });

  test("unknown partial paths do not invent file counts", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b", "")]));
    tool(host, call("a"));
    const b = tool(host, call("b", ""), false);
    expect(headers(host)).toHaveLength(0);
    controller.recordMessage(assistant([call("a"), call("b", "a.txt")]));
    b.updateArgs({ path: "a.txt" });
    expect(rows(host).join("\n")).toContain("1 file");
    expect(rows(host).join("\n")).toContain("2 calls");
  });

  test("initial global expansion and equal basenames preserve identities", () => {
    const { host, controller } = setup();
    host.toolOutputExpanded = true;
    const calls = [call("a", "one/file.txt"), call("b", "two/file.txt")];
    controller.recordMessage(assistant(calls));
    calls.forEach((input) => tool(host, input));
    expect(rows(host).join("\n")).toContain("Read 2 files");
    expect(rows(host).join("\n")).toContain("contents of a");
    expect(rows(host).join("\n")).toContain("contents of b");
  });

  test("detach restores original renders and host renderer exceptions escape", () => {
    const host = mode();
    const a = tool(host, call("a"));
    const b = tool(host, call("b"));
    const original = a.render;
    const controller = new ReadGroupingController(host);
    controller.recordMessage(assistant([call("a"), call("b")]));
    controller.attach();
    expect(a.render).not.toBe(original);
    controller.detach();
    expect(a.render).toBe(original);
    expect(host.chatContainer.children).toEqual([a, b]);
    expect(rows(host).join("\n")).toContain("a.txt");

    const other = setup();
    other.host.chatContainer.addChild({
      render() { throw new Error("Host render failed"); }, invalidate() {},
    });
    expect(() => rows(other.host)).toThrow("Host render failed");
  });
});

describe("host read grouping integration", () => {
  function install() {
    installReadGrouping({ on() { return () => {}; } } as any);
  }

  test("reload replaces controllers and restores old member render wrappers", () => {
    install();
    const host = mode();
    const items = [assistant([call("a"), call("b")])];
    const renderItems = (InteractiveMode.prototype as any).renderSessionItems;
    renderItems.call(host, items);
    const oldHeader = headers(host)[0];
    const originalMember = host.chatContainer.children.find(
      (child: any) => child instanceof ToolExecutionComponent,
    );
    const wrappedRender = originalMember.render;
    install();
    expect((InteractiveMode.prototype as any).renderSessionItems).toBe(renderItems);
    host.chatContainer.clear();
    renderItems.call(host, items);
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].controller).not.toBe(oldHeader.controller);
    expect(originalMember.render).not.toBe(wrappedRender);

    // A fail-open controller can also recover through a subsequent reload.
    headers(host)[0].controller.detach();
    install();
    host.chatContainer.clear();
    renderItems.call(host, items);
    expect(headers(host)).toHaveLength(1);
  });

  test("reconstruction and live events group equivalently across reload installation", async () => {
    install();
    const before = (InteractiveMode.prototype as any).handleEvent;
    install();
    expect((InteractiveMode.prototype as any).handleEvent).toBe(before);
    const calls = [call("a"), call("b")];
    const message = assistant(calls);
    const items = [message, ...calls.map((input) => ({
      role: "toolResult", toolCallId: input.id, toolName: "read",
      content: [{ type: "text", text: `contents of ${input.id}` }],
      isError: false, timestamp: 2,
    }))];
    const savedItems = JSON.stringify(items);
    const restored = mode();
    (InteractiveMode.prototype as any).renderSessionItems.call(restored, items);
    expect(rows(restored).join("\n")).toContain("Read 2 files");
    expect(JSON.stringify(items)).toBe(savedItems);

    const live = mode();
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(live, event);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message });
    await emit({ type: "message_end", message });
    for (const input of calls) {
      await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: "read", args: input.arguments });
      await emit({ type: "tool_execution_end", toolCallId: input.id, isError: false,
        result: { content: [{ type: "text", text: `contents of ${input.id}` }] } });
    }
    expect(rows(live).join("\n")).toContain("Read 2 files");
    expect(headers(live)).toHaveLength(1);
    expect(headers(restored)).toHaveLength(1);
    expect(live.pendingTools.size).toBe(0);
    (InteractiveMode.prototype as any).setToolsExpanded.call(live, true);
    expect(rows(live).join("\n")).toContain("contents of b");
  });
});
