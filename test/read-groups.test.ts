import { beforeAll, describe, expect, test } from "bun:test";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  InteractiveMode,
  ToolExecutionComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  KeybindingsManager,
  MouseRegion,
  setKeybindings,
  Text,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { findRenderers, grepRenderers, lsRenderers, readRenderers } from "../renderers.ts";

beforeAll(async () => { await initTheme("light", false); });

function call(id: string, file = `${id}.txt`, extra = {}) {
  return { type: "toolCall", id, name: "read", arguments: { path: file, ...extra } };
}

function explore(id: string, name: "grep" | "find" | "ls", args: Record<string, unknown> = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

const explorationRenderers: Record<string, any> = {
  read: readRenderers, grep: grepRenderers, find: findRenderers, ls: lsRenderers,
};

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
    maybeShowInstallChangeWarning() {},
    hideThinkingBlock: false,
    outputPad: 1,
    getRegisteredToolDefinition: (name: string) => explorationRenderers[name],
    addMessageToChat(message: any) {
      if (message.role === "toolResult") return;
      this.chatContainer.addChild(message.role === "assistant"
        ? new AssistantMessageComponent(message, this.hideThinkingBlock, getMarkdownTheme())
        : new Text(message.role, 0, 0));
    },
  };
  return value;
}

function setup(theme?: Theme) {
  const host = mode();
  const controller = new ReadGroupingController(host, () => theme);
  expect(controller.attach()).toBe(true);
  return { host, controller };
}

function tool(host: any, input: { name: string; id: string; arguments: Record<string, unknown> }, completed = true) {
  const component = new ToolExecutionComponent(
    input.name, input.id, input.arguments, { showImages: false },
    explorationRenderers[input.name],
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

function addAssistant(host: any, controller: ReadGroupingController, message: any) {
  controller.recordMessage(message);
  host.addMessageToChat(message);
  return host.chatContainer.children.findLast((child: any) => child instanceof AssistantMessageComponent) as any;
}

function setHideThinking(host: any, hidden: boolean) {
  host.hideThinkingBlock = hidden;
  (InteractiveMode.prototype as any).updateThinkingBlockVisibility.call(host);
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

  test("hidden thinking renders no label, spacing, or mouse target", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    const message = assistant([{ type: "thinking", thinking: "Considering next file" }]);
    const saved = JSON.stringify(message);
    const component = addAssistant(host, controller, message);
    expect(rows(host)).toEqual([]);
    expect(component.contentContainer.children).toEqual([]);
    expect(component.lastMessage).toBe(message);
    expect(JSON.stringify(message)).toBe(saved);
    setHideThinking(host, false);
    expect(rows(host).join("\n")).toContain("Considering next file");
    setHideThinking(host, true);
    expect(rows(host)).toEqual([]);
  });

  test("hidden thinking preserves text without adding blank rows", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    const thinking = { type: "thinking", thinking: "Private reasoning" };
    const text = { type: "text", text: "User-facing explanation" };
    const message = assistant([thinking, text, thinking]);
    const component = addAssistant(host, controller, message);
    const expected = new AssistantMessageComponent(assistant([text]) as any, true, getMarkdownTheme());
    expect(rows(host)).toEqual(expected.render(80).map(stripTerminalSequences));
    component.invalidate();
    component.setHiddenThinkingLabel("A different collapsed label");
    expect(rows(host)).toEqual(expected.render(80).map(stripTerminalSequences));
    expect(component.lastMessage).toBe(message);
    setHideThinking(host, false);
    expect(rows(host).join("\n")).toContain("Private reasoning");
  });

  test("groups reads across hidden thinking within a message", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    addAssistant(host, controller, assistant([
      call("a"), { type: "thinking", thinking: "Next file" }, call("b"),
    ]));
    tool(host, call("a"));
    tool(host, call("b"));
    expect(rows(host).join("\n")).toContain("Read 2 files");
    expect(rows(host).join("\n")).not.toContain("Thinking");
    setHideThinking(host, false);
    expect(rows(host).join("\n")).toContain("Next file");
    expect(headers(host)).toHaveLength(0);
    setHideThinking(host, true);
    expect(rows(host).join("\n")).toContain("Read 2 files");
  });

  test("groups across hidden assistant transitions without moving original components", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    addAssistant(host, controller, assistant([call("a")]));
    const a = tool(host, call("a"));
    addAssistant(host, controller, assistant([{ type: "thinking", thinking: "Next file" }]));
    addAssistant(host, controller, assistant([
      { type: "thinking", thinking: "Reading B" }, call("b"),
    ]));
    const b = tool(host, call("b"));
    const originals = host.chatContainer.children.filter((child: any) => !headers(host).includes(child));
    expect(rows(host).join("\n")).toContain("Read 2 files");
    expect(rows(host).join("\n")).not.toContain("Next file");
    clickRow(host, "Read 2 files");
    clickRow(host, "a.txt");
    expect(rows(host).join("\n")).toContain("contents of a");
    setHideThinking(host, false);
    const visible = rows(host).join("\n");
    expect(headers(host)).toHaveLength(0);
    expect(visible.indexOf("a.txt")).toBeLessThan(visible.indexOf("Next file"));
    expect(visible.indexOf("Next file")).toBeLessThan(visible.indexOf("b.txt"));
    expect(host.chatContainer.children).toEqual(originals);
    setHideThinking(host, true);
    expect(rows(host).join("\n")).toContain("Read 2 files");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host).join("\n")).toContain("contents of a");
    expect(rows(host).join("\n")).toContain("contents of b");
    expect(host.chatContainer.children).toContain(a);
    expect(host.chatContainer.children).toContain(b);
  });

  test("hidden mode retains text, tool, and unknown content boundaries", () => {
    for (const boundary of [
      { type: "text", text: "Explanation" },
      { type: "text", text: "" },
      { type: "unknown" },
      { type: "toolCall", name: "bash", id: "bash", arguments: { command: "pwd" } },
    ]) {
      const { host, controller } = setup();
      host.hideThinkingBlock = true;
      addAssistant(host, controller, assistant([call("a"), boundary]));
      tool(host, call("a"));
      addAssistant(host, controller, assistant([call("b")]));
      tool(host, call("b"));
      rows(host);
      expect(headers(host)).toHaveLength(0);

      const sameMessage = setup();
      sameMessage.host.hideThinkingBlock = true;
      addAssistant(sameMessage.host, sameMessage.controller, assistant([call("a"), boundary, call("b")]));
      tool(sameMessage.host, call("a"));
      tool(sameMessage.host, call("b"));
      rows(sameMessage.host);
      expect(headers(sameMessage.host)).toHaveLength(0);
    }
  });

  test("mixed assistant and user/custom transcript boundaries stay visible and separate", () => {
    for (const boundary of [
      assistant([{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Explanation" }]),
      { role: "user", content: "New request" },
      { role: "custom", content: "Notice" },
    ]) {
      const { host, controller } = setup();
      host.hideThinkingBlock = true;
      addAssistant(host, controller, assistant([call("a")]));
      tool(host, call("a"));
      host.addMessageToChat(boundary);
      addAssistant(host, controller, assistant([call("b")]));
      tool(host, call("b"));
      expect(rows(host).join("\n")).toContain(boundary.role === "assistant" ? "Explanation" : boundary.role);
      expect(headers(host)).toHaveLength(0);
    }
  });

  test("hidden thinking never hides interruption notices or groups across them", () => {
    for (const stopReason of ["aborted", "error", "length"]) {
      const { host, controller } = setup();
      host.hideThinkingBlock = true;
      addAssistant(host, controller, assistant([call("a")]));
      tool(host, call("a"));
      const interrupted = {
        ...assistant([{ type: "thinking", thinking: "Partial reasoning" }]),
        stopReason, errorMessage: "Interrupted response",
      };
      addAssistant(host, controller, interrupted);
      addAssistant(host, controller, assistant([call("b")]));
      tool(host, call("b"));
      const output = rows(host).join("\n");
      expect(output).toContain(stopReason === "length" ? "truncated" : "Interrupted response");
      expect(output).not.toContain("Partial reasoning");
      expect(headers(host)).toHaveLength(0);
    }
  });

  test("a failed read stays visible in a group across hidden reasoning", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    addAssistant(host, controller, assistant([call("a")]));
    tool(host, call("a"));
    addAssistant(host, controller, assistant([{ type: "thinking", thinking: "Try B" }, call("b")]));
    const b = tool(host, call("b"));
    b.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
    expect(rows(host).join("\n")).toContain("Read 2 files");
    expect(rows(host).join("\n")).toContain("1 failed");
    expect(rows(host).join("\n")).toContain("Permission denied");
  });

  test("detaching restores thinking components and clears presentation-only wrappers", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    const message = assistant([{ type: "thinking", thinking: "Reasoning" }]);
    const component = addAssistant(host, controller, message);
    const wrapped = component.updateContent;
    expect(rows(host)).toEqual([]);
    controller.detach();
    expect(component.updateContent).not.toBe(wrapped);
    expect(component.lastMessage).toBe(message);
    expect(rows(host).join("\n")).toContain("Thinking...");
  });

  test("detaching leaves later extension wrappers intact and makes retained hooks pass through", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    const component = addAssistant(host, controller, assistant([
      { type: "thinking", thinking: "Reasoning" },
    ]));
    const wrapped = component.updateContent;
    const laterWrapper = function (this: any, ...args: any[]) {
      return wrapped.apply(this, args);
    };
    component.updateContent = laterWrapper;
    controller.detach();
    expect(component.updateContent).toBe(laterWrapper);
    expect(rows(host).join("\n")).toContain("Thinking...");
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

describe("mixed exploration grouping", () => {
  test("combines searches, reads and listings in a stable summary without reordering calls", () => {
    const { host, controller } = setup();
    const calls = [call("a"), explore("l", "ls", { path: "src" }), call("b"),
      explore("g", "grep", { pattern: "needle" })];
    const message = assistant(calls);
    const saved = JSON.stringify(message);
    controller.recordMessage(message);
    const originals = calls.map((input) => tool(host, input));
    expect(rows(host).join("\n")).toContain("Searched for 1 pattern, read 2 files, listed 1 directory");
    expect(rows(host).join("\n")).not.toContain("contents of");
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent)).toEqual(originals);
    expect(headers(host)[0].members).toEqual(originals);
    expect(JSON.stringify(message)).toBe(saved);
  });

  test("counts grep and find as searches and omits unused categories", () => {
    for (const [calls, expected] of [
      [[explore("g", "grep", { pattern: "needle" }), explore("f", "find", { pattern: "*.ts" })],
        "Searched for 2 patterns"],
      [[call("a"), explore("f", "find", { pattern: "*.ts" })], "Searched for 1 pattern, read 1 file"],
      [[explore("l", "ls", { path: "src" }), explore("m", "ls", { path: "test" })], "Listed 2 directories"],
      [[explore("l", "ls"), call("a")], "Read 1 file, listed 1 directory"],
      [[explore("l", "ls"), explore("g", "grep", { pattern: "needle" })], "Searched for 1 pattern, listed 1 directory"],
    ] as const) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([...calls]));
      calls.forEach((input) => tool(host, input));
      expect(rows(host).join("\n")).toContain(expected);
      expect(rows(host).join("\n")).not.toContain("0 files");
      expect(rows(host).join("\n")).not.toContain("0 patterns");
      expect(rows(host).join("\n")).not.toContain("0 directories");
    }
  });

  test("deduplicates file and directory paths but counts separate search operations", () => {
    const { host, controller } = setup();
    const calls = [call("a", "src/a.ts"), call("b", "/repo/src/a.ts", { offset: 20 }),
      explore("l", "ls"), explore("m", "ls", { path: "/repo" }),
      explore("g", "grep", { pattern: "needle", path: "src" }),
      explore("f", "find", { pattern: "needle", path: "test" })];
    controller.recordMessage(assistant(calls));
    calls.forEach((input) => tool(host, input));
    expect(rows(host, 160).join("\n")).toContain("Searched for 2 patterns, read 1 file, listed 1 directory (6 calls)");
  });

  test("expanded groups retain native per-tool output and keyboard expansion", () => {
    const { host, controller } = setup();
    const calls = [explore("g", "grep", { pattern: "needle" }), call("a"), explore("l", "ls")];
    controller.recordMessage(assistant(calls));
    const originals = calls.map((input) => tool(host, input));
    originals[0].updateResult({ content: [{ type: "text", text: "match1\nmatch2\nmatch3\nmatch4\nmatch5\nmatch6" }] });
    clickRow(host, "Searched for 1 pattern");
    expect(rows(host).join("\n")).toContain("match1");
    expect(rows(host).join("\n")).not.toContain("match6");
    clickRow(host, "/needle/");
    expect(rows(host).join("\n")).toContain("match6");
    clickRow(host, "Searched for 1 pattern");
    expect(rows(host).join("\n")).not.toContain("match1");
    clickRow(host, "Searched for 1 pattern");
    expect(rows(host).join("\n")).toContain("match6");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host).join("\n")).toContain("contents of a");
    expect(rows(host).join("\n")).toContain("contents of l");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, false);
    expect(rows(host).join("\n")).not.toContain("match1");
    for (const width of [24, 80, 160]) {
      expect(rows(host, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("active mixed summaries settle correctly and keep search and listing failures visible", () => {
    for (const name of ["grep", "find", "ls"] as const) {
      const { host, controller } = setup();
      const calls = [call("a"), explore("x", name, name === "ls" ? {} : { pattern: "needle" })];
      controller.recordMessage(assistant(calls));
      const originals = calls.map((input) => tool(host, input, false));
      const header = headers(host)[0];
      const active = rows(host).join("\n");
      expect(active).toContain(name === "ls" ? "Reading 1 file, listing 1 directory" : "Searching for 1 pattern, reading 1 file");
      expect(active).toContain("…");
      expect(active).not.toContain("pending");
      originals[1].updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
      originals[0].updateResult({ content: [{ type: "text", text: "OK" }] });
      const output = rows(host, 180).join("\n");
      expect(output).toContain(name === "ls" ? "Read 1 file, listed 1 directory" : "Searched for 1 pattern, read 1 file");
      expect(output).toContain("1 failed");
      expect(output).toContain("Permission denied");
      expect(output).not.toContain("pending");
      expect(headers(host)[0]).toBe(header);
    }
  });

  test("failure counts survive long mixed summaries and narrow terminal widths", () => {
    const { host, controller } = setup();
    const calls = [call("a"), call("b"), explore("g", "grep", { pattern: "needle" }), explore("l", "ls")];
    controller.recordMessage(assistant(calls));
    const originals = calls.map((input) => tool(host, input));
    originals[1].updateResult({ content: [{ type: "text", text: "Still reading" }] }, true);
    originals[2].updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
    for (const pending of [true, false]) {
      if (!pending) originals[1].updateResult({ content: [{ type: "text", text: "OK" }] });
      for (const width of [24, 60, 80]) {
        const output = rows(host, width);
        expect(output.join("\n")).toContain("1 failed");
        expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });

  test("valid empty and whitespace patterns count as searches, not missing arguments", () => {
    for (const name of ["grep", "find"] as const) {
      for (const pattern of ["", " ", "\t"]) {
        const { host, controller } = setup();
        const calls = [call("a"), explore("x", name, { pattern })];
        controller.recordMessage(assistant(calls));
        calls.forEach((input) => tool(host, input));
        expect(rows(host).join("\n")).toContain("Searched for 1 pattern, read 1 file");
      }
    }
  });

  test("path aliases accepted by Pi deduplicate file and directory counts", () => {
    for (const [first, second] of [
      ["@src", "src"],
      ["file:///repo/src", "src"],
      ["@file:///repo/my%20dir", "my dir"],
      ["src/my\u00a0dir", "src/my dir"],
    ]) {
      for (const name of ["read", "ls"]) {
        const { host, controller } = setup();
        const calls = name === "read" ? [call("a", first), call("b", second)]
          : [explore("a", "ls", { path: first }), explore("b", "ls", { path: second })];
        controller.recordMessage(assistant(calls));
        calls.forEach((input) => tool(host, input));
        expect(rows(host).join("\n")).toContain(name === "read"
          ? "Read 1 file (2 calls)" : "Listed 1 directory (2 calls)");
      }
    }
  });

  test("streaming growth keeps the same expanded header as tool types change", () => {
    const { host, controller } = setup();
    const calls = [call("a"), explore("g", "grep", { pattern: "needle" }), explore("l", "ls")];
    controller.recordMessage(assistant(calls.slice(0, 2)));
    calls.slice(0, 2).forEach((input) => tool(host, input));
    const header = headers(host)[0];
    clickRow(host, "Searched for 1 pattern");
    controller.recordMessage(assistant(calls));
    tool(host, calls[2]);
    expect(rows(host).join("\n")).toContain("Searched for 1 pattern, read 1 file, listed 1 directory");
    expect(headers(host)[0]).toBe(header);
    expect(header.expanded).toBe(true);
    expect(rows(host).join("\n")).toContain("contents of l");
  });

  test("mixed groups bridge hidden thinking and split when reasoning is shown", () => {
    const { host, controller } = setup();
    host.hideThinkingBlock = true;
    const calls = [call("a"), explore("g", "grep", { pattern: "needle" }), explore("l", "ls"), call("b")];
    for (const input of calls) {
      addAssistant(host, controller, assistant([{ type: "thinking", thinking: `Planning ${input.id}` }, input]));
      tool(host, input);
    }
    const summary = "Searched for 1 pattern, read 2 files, listed 1 directory";
    expect(rows(host).join("\n")).toContain(summary);
    expect(rows(host).join("\n")).not.toContain("Planning");
    setHideThinking(host, false);
    expect(rows(host).join("\n")).toContain("Planning g");
    expect(headers(host)).toHaveLength(0);
    setHideThinking(host, true);
    expect(rows(host).join("\n")).toContain(summary);
  });

  test("non-exploration tools and assistant text still break mixed groups", () => {
    for (const boundary of [
      { type: "text", text: "Explanation" },
      { type: "toolCall", name: "bash", id: "boundary", arguments: { command: "ls" } },
      { type: "toolCall", name: "edit", id: "boundary", arguments: {} },
      { type: "toolCall", name: "write", id: "boundary", arguments: {} },
      { type: "toolCall", name: "apply_patch", id: "boundary", arguments: {} },
    ]) {
      const { host, controller } = setup();
      host.hideThinkingBlock = true;
      const a = explore("g", "grep", { pattern: "needle" });
      const b = explore("l", "ls");
      controller.recordMessage(assistant([a, boundary, b]));
      tool(host, a);
      tool(host, b);
      expect(headers(host)).toHaveLength(0);
    }
  });

  test("partial search arguments do not invent patterns and optional roots default to cwd", () => {
    for (const name of ["grep", "find"] as const) {
      const { host, controller } = setup();
      const partial = explore("x", name);
      controller.recordMessage(assistant([call("a"), partial]));
      tool(host, call("a"));
      const component = tool(host, partial, false);
      expect(headers(host)).toHaveLength(0);
      const complete = explore("x", name, { pattern: "needle" });
      controller.recordMessage(assistant([call("a"), complete]));
      component.updateArgs(complete.arguments);
      expect(rows(host).join("\n")).toContain("Searching for 1 pattern, reading 1 file");
    }
    const { host, controller } = setup();
    const calls = [explore("l", "ls"), explore("m", "ls", { path: "/repo" })];
    controller.recordMessage(assistant(calls));
    calls.forEach((input) => tool(host, input));
    expect(rows(host).join("\n")).toContain("Listed 1 directory (2 calls)");
  });

  test("malformed exploration arguments remain individual calls instead of invented counts", () => {
    for (const invalid of [
      explore("x", "ls", { path: 42 }),
      explore("x", "ls", [] as any),
      explore("x", "grep", { pattern: "needle", path: {} }),
      explore("x", "find", { pattern: 42 }),
    ]) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([call("a"), invalid]));
      tool(host, call("a"));
      tool(host, invalid, false);
      rows(host);
      expect(headers(host)).toHaveLength(0);
    }
  });
});

describe("exploration group presentation", () => {
  test("shows actual execution targets, not queued calls, and removes them after completion", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"), false);
    const b = tool(host, call("b"), false);
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[1]).toStartWith("• Reading 2 files…");
    expect(rows(host).join("\n")).not.toContain("pending");
    a.markExecutionStarted();
    expect(rows(host)[2]).toBe("  ⎿ Reading a.txt");
    expect(rows(host).join("\n")).not.toContain("b.txt");
    a.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)).toHaveLength(2);
    b.markExecutionStarted();
    expect(rows(host)[2]).toBe("  ⎿ Reading b.txt");
    b.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[1]).toStartWith("• Read 2 files");
    expect(rows(host)[1]).not.toContain("…");
  });

  test("partial results and changed arguments update the target without rebuilding the group", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"), false);
    tool(host, call("b"));
    const header = headers(host)[0];
    a.markExecutionStarted();
    a.updateResult({ content: [{ type: "text", text: "Progress" }] }, true);
    expect(rows(host)[2]).toBe("  ⎿ Reading a.txt");
    a.updateArgs({ path: "/repo/src/updated.ts" });
    expect(rows(host)[2]).toBe("  ⎿ Reading src/updated.ts");
    expect(headers(host)[0]).toBe(header);
    a.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)).toHaveLength(2);
  });

  test("parallel execution uses a stable running target and never picks a queued last call", () => {
    const { host, controller } = setup();
    const calls = [call("a"), call("b"), call("queued")];
    controller.recordMessage(assistant(calls));
    const [a, b] = calls.map((input) => tool(host, input, false));
    b.markExecutionStarted();
    expect(rows(host)[2]).toBe("  ⎿ Reading b.txt");
    a.markExecutionStarted();
    expect(rows(host)[2]).toBe("  ⎿ Reading a.txt · +1 running");
    expect(rows(host).join("\n")).not.toContain("queued.txt");
    a.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)[2]).toBe("  ⎿ Reading b.txt");
    b.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)).toHaveLength(2);
  });

  test("search and listing targets use their real patterns and default roots", () => {
    for (const [input, expected] of [
      [explore("x", "grep", { pattern: "needle", path: "src" }), "Searching /needle/ in src"],
      [explore("x", "find", { pattern: "*.ts" }), 'Searching "*.ts" in .'],
      [explore("x", "grep", { pattern: "" }), "Searching // in ."],
      [explore("x", "grep", { pattern: " " }), "Searching / / in ."],
      [explore("x", "ls", { path: "/repo/src" }), "Listing src"],
      [explore("x", "ls"), "Listing ."],
    ] as const) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([call("a"), input]));
      tool(host, call("a"));
      const running = tool(host, input, false);
      running.markExecutionStarted();
      expect(rows(host)[2]).toBe(`  ⎿ ${expected}`);
    }
  });

  test("targets sanitize terminal controls and stay one line at narrow widths", () => {
    const { host, controller } = setup();
    const input = explore("x", "grep", { pattern: "\u001b[31mneedle\n\t", path: "src" });
    controller.recordMessage(assistant([call("a"), input]));
    tool(host, call("a"));
    const running = tool(host, input, false);
    running.markExecutionStarted();
    const output = headers(host)[0].render(80);
    expect(output[2]).toBe("  ⎿ Searching /needle\\n\\t/ in src");
    expect(output[2]).not.toContain("\u001b");
    running.updateArgs({ pattern: "needle", path: "文件/".repeat(30) });
    for (const width of [1, 2, 3, 5, 6, 24, 80]) {
      expect(rows(host, width)).toHaveLength(3);
      expect(rows(host, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(rows(host, 0)).toEqual([]);
  });

  test("only the header toggles a group, and expanded groups omit duplicate live details", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"), false);
    tool(host, call("b"));
    a.markExecutionStarted();
    const header = headers(host)[0];
    expect(clickRow(host, "⎿ Reading a.txt")).toBeUndefined();
    expect(header.expanded).toBe(false);
    expect(clickRow(host, "Reading 2 files")?.handled).toBe(true);
    expect(header.render(80)).toHaveLength(2);
    expect(rows(host).join("\n")).toContain("• Reading a.txt");
    expect(rows(host).join("\n")).not.toContain("⎿ Reading a.txt");
    clickRow(host, "Reading 2 files");
    expect(rows(host)[2]).toBe("  ⎿ Reading a.txt");
  });

  test("collapsed failures get a bounded separate detail while running activity stays visible", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"));
    const b = tool(host, call("b"), false);
    a.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
    b.markExecutionStarted();
    expect(rows(host)[1]).toStartWith("• 1 failed · Reading 2 files");
    expect(rows(host)[1]).not.toContain("Permission denied");
    expect(rows(host)[2]).toBe("  ⎿ a.txt: Permission denied");
    expect(rows(host)[3]).toBe("  ⎿ Reading b.txt");
    expect(clickRow(host, "Permission denied")).toBeUndefined();
    a.updateResult({ content: [{ type: "text", text: "Permission denied ".repeat(100) }], isError: true });
    for (const width of [1, 2, 3, 5, 6, 24, 80]) {
      const output = rows(host, width);
      expect(output.length).toBeLessThanOrEqual(6); // header, up to 3 error rows, live target
      expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(rows(host, 24).join("\n")).toContain("1 failed");
    b.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host).join("\n")).not.toContain("Reading b.txt");
    headers(host)[0].setExpanded(true);
    expect(headers(host)[0].render(80)).toHaveLength(2);
    expect(rows(host).join("\n")).toContain("Permission denied");
  });

  test("mouse targets below changing detail rows keep their correct positions", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"), false);
    const b = tool(host, call("b"), false);
    let clicks = 0;
    host.chatContainer.addChild(new MouseRegion(new Text("NEXT", 0, 0), (event) => {
      if (event.type === "click") { clicks++; return { handled: true }; }
    }));
    for (const width of [24, 80]) {
      a.markExecutionStarted();
      clickRow(host, "NEXT", width);
      a.updateResult({ content: [{ type: "text", text: "Permission denied ".repeat(8) }], isError: true });
      b.markExecutionStarted();
      clickRow(host, "NEXT", width);
      headers(host)[0].setExpanded(true);
      clickRow(host, "NEXT", width);
      headers(host)[0].setExpanded(false);
      clickRow(host, "NEXT", width);
    }
    expect(clicks).toBe(8);
  });

  test("wide-character error details never exceed even a one-column terminal", () => {
    const { host, controller } = setup();
    const calls = [call("a", "中"), call("b")];
    controller.recordMessage(assistant(calls));
    const a = tool(host, calls[0]);
    tool(host, calls[1]);
    a.updateResult({ content: [{ type: "text", text: "访问被拒绝 ".repeat(10) }], isError: true });
    for (const width of [1, 2, 3, 4, 5, 6, 8, 24, 80]) {
      expect(rows(host, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("status dots carry color while summaries remain neutral and hints muted", () => {
    const previous = getKeybindings();
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
    try {
      const colors: Record<string, number> = { accent: 36, success: 32, error: 31, toolTitle: 37, muted: 90 };
      const theme = { fg: (color: string, text: string) => `\u001b[${colors[color]}m${text}\u001b[39m` } as Theme;
      const { host, controller } = setup(theme);
      controller.recordMessage(assistant([call("a"), call("b")]));
      const a = tool(host, call("a"));
      const b = tool(host, call("b"));
      let header = headers(host)[0].render(180)[1];
      expect(header).toContain("\u001b[32m•\u001b[39m");
      expect(header).toContain("\u001b[37mRead 2 files\u001b[39m");
      expect(header).toContain("\u001b[90m (ctrl+o to expand all)\u001b[39m");
      b.updateResult({ content: [{ type: "text", text: "Progress" }] }, true);
      header = headers(host)[0].render(180)[1];
      expect(header).toContain("\u001b[36m•\u001b[39m");
      expect(header).toContain("\u001b[37mReading 2 files\u001b[39m");
      a.updateResult({ content: [], isError: true });
      const failed = headers(host)[0].render(180);
      expect(failed[1]).toContain("\u001b[31m•\u001b[39m");
      expect(failed[1]).toContain("\u001b[31m1 failed\u001b[39m");
      expect(failed[1]).toContain("\u001b[37mReading 2 files\u001b[39m");
      expect(failed[2]).toContain("\u001b[31ma.txt: Tool failed\u001b[39m");
    } finally {
      setKeybindings(previous);
    }
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

  test("hidden thinking groups identically in live streams and replay, including setting changes", async () => {
    install();
    const thinking = { type: "thinking", thinking: "Considering B" };
    const messages = [assistant([call("a")]), assistant([thinking, call("b")])];
    const items = messages.flatMap((message, index) => [message, {
      role: "toolResult", toolCallId: index === 0 ? "a" : "b", toolName: "read",
      content: [{ type: "text", text: `contents of ${index === 0 ? "a" : "b"}` }],
      isError: false, timestamp: 2,
    }]);
    const saved = JSON.stringify(items);
    const restored = mode();
    restored.hideThinkingBlock = true;
    (InteractiveMode.prototype as any).renderSessionItems.call(restored, items);

    const live = mode();
    live.hideThinkingBlock = true;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(live, event);
    for (const [index, message] of messages.entries()) {
      await emit({ type: "message_start", message: assistant([]) });
      if (index === 1) {
        await emit({ type: "message_update", message: assistant([thinking]) });
        expect(rows(live).join("\n")).not.toContain("Considering B");
        expect(rows(live).join("\n")).not.toContain("Thinking...");
      }
      await emit({ type: "message_update", message });
      await emit({ type: "message_end", message });
      const id = index === 0 ? "a" : "b";
      await emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: call(id).arguments });
      await emit({ type: "tool_execution_end", toolCallId: id, isError: false,
        result: { content: [{ type: "text", text: `contents of ${id}` }] } });
    }
    expect(rows(live)).toEqual(rows(restored));
    expect(rows(live).join("\n")).toContain("Read 2 files");
    expect(JSON.stringify(items)).toBe(saved);
    for (const host of [live, restored]) {
      for (const width of [24, 80]) {
        expect(rows(host, width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      setHideThinking(host, false);
      expect(rows(host).join("\n")).toContain("Considering B");
      expect(headers(host)).toHaveLength(0);
      setHideThinking(host, true);
      expect(rows(host).join("\n")).toContain("Read 2 files");
      expect(rows(host).join("\n")).not.toContain("Considering B");
    }
  });

  test("streaming content changes invalidate grouping without replacing transcript children", async () => {
    install();
    const host = mode();
    host.hideThinkingBlock = true;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([call("a")]) });
    await emit({ type: "message_end", message: assistant([call("a")]) });
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([
      { type: "thinking", thinking: "Next" }, call("b"),
    ]) });
    expect(rows(host).join("\n")).toContain("Reading 2 files");
    const originalTools = host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent);
    await emit({ type: "message_update", message: assistant([
      { type: "thinking", thinking: "Next" }, { type: "text", text: "Explanation" }, call("b"),
    ]) });
    expect(rows(host).join("\n")).toContain("Explanation");
    expect(headers(host)).toHaveLength(0);
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent)).toEqual(originalTools);
  });

  test("reload and branch rebuild preserve original reasoning and discard stale call metadata", () => {
    install();
    const host = mode();
    host.hideThinkingBlock = true;
    const items = [assistant([call("a")]), assistant([
      { type: "thinking", thinking: "Next" }, call("b"),
    ])];
    const renderItems = (InteractiveMode.prototype as any).renderSessionItems;
    renderItems.call(host, items);
    expect(rows(host).join("\n")).toContain("Reading 2 files");
    const oldAssistant = host.chatContainer.children.find((child: any) => child instanceof AssistantMessageComponent);
    const oldUpdate = oldAssistant.updateContent;
    install();
    host.chatContainer.clear();
    renderItems.call(host, items);
    expect(oldAssistant.updateContent).not.toBe(oldUpdate);
    expect(rows(host).join("\n")).toContain("Reading 2 files");
    setHideThinking(host, false);
    expect(rows(host).join("\n")).toContain("Next");
    expect(headers(host)).toHaveLength(0);
    host.chatContainer.clear();
    renderItems.call(host, [assistant([call("c")])]);
    tool(host, call("a"));
    tool(host, call("b"));
    expect(rows(host).join("\n")).not.toContain("files");
    expect(headers(host)).toHaveLength(0);
  });

  test("appending replay batches, including empty batches, preserves earlier groups", () => {
    install();
    const renderItems = (InteractiveMode.prototype as any).renderSessionItems;
    for (const hidden of [false, true]) {
      const host = mode();
      host.hideThinkingBlock = hidden;
      renderItems.call(host, [assistant([call("a"), call("b")])]);
      const header = headers(host)[0];
      expect(rows(host).join("\n")).toContain("Reading 2 files");
      renderItems.call(host, []);
      expect(rows(host).join("\n")).toContain("Reading 2 files");
      expect(headers(host)[0]).toBe(header);
      // A compaction divider is a hard boundary between retained batches.
      host.chatContainer.addChild(new Text("Compacted context", 0, 0));
      renderItems.call(host, [assistant([call("c"), call("d")])]);
      rows(host);
      expect(headers(host)).toHaveLength(2);
      expect(headers(host)[0]).toBe(header);
    }
  });

  test("mixed exploration summaries match across live execution, replay, and reload", async () => {
    install();
    const calls = [explore("g", "grep", { pattern: "needle" }), call("a"),
      explore("l", "ls", { path: "src" }), call("b"),
      explore("f", "find", { pattern: "*.ts" })];
    const messages = calls.map((input) => assistant([
      { type: "thinking", thinking: `Planning ${input.id}` }, input,
    ]));
    const resultFor = (input: typeof calls[number]) => ({
      role: "toolResult", toolCallId: input.id, toolName: input.name,
      content: [{ type: "text", text: `contents of ${input.id}` }],
      isError: false, timestamp: 2,
    });
    const items = messages.flatMap((message, index) => [message, resultFor(calls[index])]);
    const saved = JSON.stringify(items);
    const restored = mode();
    restored.hideThinkingBlock = true;
    const renderItems = (InteractiveMode.prototype as any).renderSessionItems;
    renderItems.call(restored, items);

    const live = mode();
    live.hideThinkingBlock = true;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(live, event);
    for (const [index, message] of messages.entries()) {
      const input = calls[index];
      await emit({ type: "message_start", message: assistant([]) });
      await emit({ type: "message_update", message });
      await emit({ type: "message_end", message });
      await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: input.name, args: input.arguments });
      await emit({ type: "tool_execution_end", toolCallId: input.id, isError: false, result: resultFor(input) });
    }
    const expected = "Searched for 2 patterns, read 2 files, listed 1 directory";
    expect(rows(live)).toEqual(rows(restored));
    expect(rows(live).join("\n")).toContain(expected);
    expect(JSON.stringify(items)).toBe(saved);
    expect(live.pendingTools.size).toBe(0);
    setHideThinking(live, false);
    expect(rows(live).join("\n")).toContain("Planning g");
    expect(headers(live)).toHaveLength(0);
    setHideThinking(live, true);
    expect(rows(live).join("\n")).toContain(expected);

    install();
    restored.chatContainer.clear();
    renderItems.call(restored, items);
    expect(rows(restored).join("\n")).toContain(expected);
    (InteractiveMode.prototype as any).setToolsExpanded.call(restored, true);
    for (const input of calls) expect(rows(restored).join("\n")).toContain(`contents of ${input.id}`);
    expect(JSON.stringify(items)).toBe(saved);
  });

  test("host lifecycle shows live execution only, not replayed pending tools or generated arguments", async () => {
    install();
    const calls = [call("a"), explore("g", "grep", { pattern: "needle", path: "src" })];
    const message = assistant(calls);
    const saved = JSON.stringify(message);
    const replay = mode();
    (InteractiveMode.prototype as any).renderSessionItems.call(replay, [message]);
    expect(rows(replay)).toHaveLength(2);
    expect(rows(replay).join("\n")).not.toContain("needle");
    expect(rows(replay).join("\n")).not.toContain("a.txt");

    const host = mode();
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message });
    await emit({ type: "message_end", message });
    expect(rows(host)).toHaveLength(2);
    await emit({ type: "tool_execution_start", toolCallId: "g", toolName: "grep", args: calls[1].arguments });
    expect(rows(host)[2]).toBe("  ⎿ Searching /needle/ in src");
    await emit({ type: "tool_execution_update", toolCallId: "g", toolName: "grep",
      partialResult: { content: [{ type: "text", text: "Progress" }] } });
    expect(rows(host)[2]).toBe("  ⎿ Searching /needle/ in src");
    await emit({ type: "tool_execution_end", toolCallId: "g", toolName: "grep", isError: true,
      result: { content: [{ type: "text", text: "Permission denied" }] } });
    expect(rows(host)[2]).toBe("  ⎿ grep needle in src: Permission denied");
    expect(rows(host).join("\n")).not.toContain("Searching /needle/");
    await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: calls[0].arguments });
    expect(rows(host).at(-1)).toBe("  ⎿ Reading a.txt");
    await emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false,
      result: { content: [{ type: "text", text: "Done" }] } });
    expect(rows(host).join("\n")).not.toContain("Reading a.txt");
    expect(rows(host)[1]).toStartWith("• 1 failed · Searched for 1 pattern, read 1 file");
    expect(host.pendingTools.size).toBe(0);
    expect(JSON.stringify(message)).toBe(saved);
  });
});
