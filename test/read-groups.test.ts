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
  getCapabilities,
  KeybindingsManager,
  MouseRegion,
  setKeybindings,
  setCapabilities,
  Text,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { codexBashRenderers, findRenderers, grepRenderers, lsRenderers, readRenderers } from "../renderers.ts";
import { decorateAssistantReply } from "../assistant-replies.ts";
import { createDiffComponent, normalizeApplyPatchDetails } from "@rub1cc/pi-apply-patch/renderer";

beforeAll(async () => { await initTheme("light", false); });

function call(id: string, file = `${id}.txt`, extra = {}) {
  return { type: "toolCall", id, name: "read", arguments: { path: file, ...extra } };
}

function explore(id: string, name: "grep" | "find" | "ls", args: Record<string, unknown> = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

const explorationRenderers: Record<string, any> = {
  read: readRenderers, grep: grepRenderers, find: findRenderers, ls: lsRenderers,
  bash: codexBashRenderers,
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
      getShowTerminalProgress: () => false,
    },
    ui: { requestRender() {} },
    showStatus() {},
    clearStatusIndicator() {},
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

  test("thinking, text and missing tools split groups, but tool-only messages do not", () => {
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
      expect(headers(host)).toHaveLength(2);
      expect(headers(host).every(group => group.members.length === 1)).toBe(true);
    }
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a")]));
    tool(host, call("a"));
    controller.recordMessage(assistant([call("b")]));
    tool(host, call("b"));
    expect(headers(host)).toHaveLength(1);
    expect(rows(host).join("\n")).toContain("Read 2 files");
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
    decorateAssistantReply(expected, () => undefined);
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
    expect(headers(host)).toHaveLength(2);
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
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    const visible = rows(host).join("\n");
    expect(headers(host)).toHaveLength(2);
    expect(visible.indexOf("a.txt")).toBeLessThan(visible.indexOf("Next file"));
    expect(visible.indexOf("Next file")).toBeLessThan(visible.indexOf("b.txt"));
    expect(host.chatContainer.children.filter((child: any) => !headers(host).includes(child))).toEqual(originals);
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
      expect(headers(host)).toHaveLength(2);

      const sameMessage = setup();
      sameMessage.host.hideThinkingBlock = true;
      addAssistant(sameMessage.host, sameMessage.controller, assistant([call("a"), boundary, call("b")]));
      tool(sameMessage.host, call("a"));
      tool(sameMessage.host, call("b"));
      rows(sameMessage.host);
      expect(headers(sameMessage.host)).toHaveLength(2);
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
      expect(headers(host)).toHaveLength(2);
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
      expect(headers(host)).toHaveLength(2);
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
    expect(headers(host)).toHaveLength(2);
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

  test("removal keeps a singleton summary and clear discards orphan headers", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b")]));
    const a = tool(host, call("a"));
    const b = tool(host, call("b"));
    host.chatContainer.removeChild(a);
    expect(rows(host).join("\n")).toContain("Read 1 file");
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].members).toEqual([b]);
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
    rows(host);
    expect(headers(host)).toHaveLength(2);
    expect(headers(host).map(group => group.members.map((member: any) => member.toolCallId))).toEqual([["a"], ["b"]]);
  });

  test("unknown partial paths do not invent file counts", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("b", "")]));
    tool(host, call("a"));
    const b = tool(host, call("b", ""), false);
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].members.map((member: any) => member.toolCallId)).toEqual(["a"]);
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

describe("continuous live activity groups", () => {
  async function start() {
    installReadGrouping({ on() { return () => {}; } } as any);
    const host = mode();
    host.hideThinkingBlock = true;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
    await emit({ type: "agent_start" });
    return { host, emit };
  }

  async function message(emit: (event: any) => any, content: any[]) {
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant(content) });
    await emit({ type: "message_end", message: assistant(content) });
  }

  async function execute(emit: (event: any) => any, input: any, isError = false) {
    await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: input.name, args: input.arguments });
    await emit({ type: "tool_execution_end", toolCallId: input.id, isError,
      result: { content: [{ type: "text", text: isError ? "Permission denied" : "Done" }] } });
  }

  test("a retained file preview is replaced by command output, then counts only when prose resumes", async () => {
    const { host, emit } = await start();
    const read = call("a", "/repo/package.json");
    const shell = { type: "toolCall", id: "s", name: "bash", arguments: { command: "pwd" } };
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([{ ...read, arguments: {} }]) });
    const group = headers(host)[0];
    expect(rows(host)).toEqual([]);
    await emit({ type: "message_update", message: assistant([read]) });
    expect(rows(host)).toEqual([]);
    await emit({ type: "message_end", message: assistant([read]) });
    const filePreview = ["", "  Reading package.json", "  ⎿ /repo/package.json"];
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: read.arguments });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "tool_execution_end", toolCallId: "a", isError: false, result: { content: [{ type: "text", text: "file contents" }] } });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "turn_end" });
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([{ type: "thinking", thinking: "Choosing a file" }]) });
    expect(rows(host)).toEqual(filePreview);
    expect(headers(host)[0]).toBe(group);
    await emit({ type: "message_update", message: assistant([{ ...shell, arguments: {} }]) });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "message_update", message: assistant([shell]) });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "message_end", message: assistant([shell]) });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "tool_execution_start", toolCallId: "s", toolName: "bash", args: shell.arguments });
    expect(rows(host)).toEqual(["", "  Running pwd", "  ⎿ No output"]);
    await emit({ type: "tool_execution_update", toolCallId: "s", toolName: "bash",
      partialResult: { content: [{ type: "text", text: "/repo\n" }] } });
    const shellPreview = ["", "  Running pwd", "  ⎿ /repo"];
    expect(rows(host)).toEqual(shellPreview);
    await emit({ type: "tool_execution_end", toolCallId: "s", isError: false,
      result: { content: [{ type: "text", text: "/repo\n" }] } });
    expect(rows(host)).toEqual(shellPreview);
    expect(headers(host)[0]).toBe(group);
    await message(emit, [{ type: "text", text: "Here is what I found." }]);
    expect(rows(host)[1]).toBe("  Read 1 file, ran 1 shell command");
    expect(rows(host).join("\n")).toContain("⏺ Here is what I found.");
    expect(rows(host).join("\n")).not.toContain("Running pwd");
    await emit({ type: "agent_end" });
  });

  test("fast calls do not collapse between rounds, but real assistant prose closes the group", async () => {
    const { host, emit } = await start();
    for (const input of [call("a"), call("b")]) {
      await message(emit, [input]);
      await execute(emit, input);
      expect(rows(host)).toHaveLength(3);
      expect(rows(host)[1]).toBe(`  Reading ${input.id}.txt`);
      expect(rows(host)[2]).toBe(`  ⎿ /repo/${input.id}.txt`);
    }
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([{ type: "text", text: "" }]) });
    expect(rows(host)[1]).toBe("  Reading b.txt");
    await emit({ type: "message_update", message: assistant([{ type: "text", text: "Here is what I found." }]) });
    expect(rows(host)[1]).toBe("  Read 2 files");
    expect(rows(host).join("\n")).not.toContain("awaiting next step");
    expect(rows(host).join("\n")).toContain("Here is what I found.");
    await emit({ type: "message_end", message: assistant([{ type: "text", text: "Here is what I found." }]) });
    await message(emit, [call("c")]);
    await execute(emit, call("c"));
    expect(headers(host)).toHaveLength(2);
    expect(headers(host)[0].render(80)[1]).toBe("  Read 2 files");
    expect(headers(host)[1].render(80)[1]).toBe("  Reading c.txt");
    await emit({ type: "agent_end" });
    expect(headers(host)[1].render(80)[1]).toBe("  Reading c.txt");
  });

  test("parallel completion does not replace the most recently started operation", async () => {
    const { host, emit } = await start();
    await message(emit, [call("a"), call("b")]);
    for (const id of ["a", "b"]) {
      await emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.txt` } });
    }
    const preview = ["", "  Reading b.txt", "  ⎿ /repo/b.txt"];
    expect(rows(host)).toEqual(preview);
    await emit({ type: "tool_execution_end", toolCallId: "b", isError: false, result: { content: [] } });
    expect(rows(host)).toEqual(preview);
    await emit({ type: "tool_execution_end", toolCallId: "a", isError: false, result: { content: [] } });
    expect(rows(host)).toEqual(preview);
    for (const width of [1, 2, 3, 6, 24, 80]) {
      expect(rows(host, width).every(row => visibleWidth(row) <= width)).toBe(true);
    }
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host).join("\n")).toContain("Read(a.txt)");
    expect(rows(host).join("\n")).not.toContain("awaiting next step");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, false);
    expect(rows(host)).toEqual(preview);
    await emit({ type: "agent_end" });
  });

  test("shell output stays bounded and unchanged on completion and incomplete next arguments", async () => {
    const { host, emit } = await start();
    const shell = { type: "toolCall", id: "s", name: "bash", arguments: { command: "npm test" } };
    await message(emit, [shell]);
    await emit({ type: "tool_execution_start", toolCallId: "s", toolName: "bash", args: shell.arguments });
    const output = { content: [{ type: "text", text: "one\ntwo\nthree\n\u001b[31mfour\nfive\nsix\n" }] };
    await emit({ type: "tool_execution_update", toolCallId: "s", toolName: "bash", partialResult: output });
    const preview = ["", "  Running npm test", "  ⎿ four", "    five", "    six"];
    expect(rows(host)).toEqual(preview);
    expect(headers(host)[0].render(80).join("\n")).not.toContain("\u001b[31m");
    await emit({ type: "tool_execution_end", toolCallId: "s", isError: false, result: output });
    expect(rows(host)).toEqual(preview);
    await emit({ type: "message_start", message: assistant([]) });
    for (const args of [{}, { path: "/repo/par" }, { path: "/repo/package.json" }]) {
      await emit({ type: "message_update", message: assistant([{ ...call("a"), arguments: args }]) });
      expect(rows(host)).toEqual(preview);
    }
    for (const width of [0, 1, 2, 3, 6, 24, 80]) {
      expect(rows(host, width).length).toBeLessThanOrEqual(5);
      expect(rows(host, width).every(row => visibleWidth(row) <= width)).toBe(true);
    }
    await emit({ type: "message_end", message: assistant([call("a", "/repo/package.json")]) });
    expect(rows(host)).toEqual(preview);
    await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "/repo/package.json" } });
    expect(rows(host)).toEqual(["", "  Reading package.json", "  ⎿ /repo/package.json"]);
    await emit({ type: "tool_execution_end", toolCallId: "a", isError: false, result: { content: [] } });
    await emit({ type: "agent_end" });
    expect(rows(host)).toEqual(["", "  Reading package.json", "  ⎿ /repo/package.json"]);
  });

  test("live path titles sanitize terminal controls as well as their gutter details", async () => {
    const { host, emit } = await start();
    const input = call("a", "/repo/\u001b[31mpackage.json");
    await message(emit, [input]);
    await execute(emit, input);
    expect(rows(host)).toEqual(["", "  Reading package.json", "  ⎿ /repo/package.json"]);
    expect(headers(host)[0].render(80).join("\n")).not.toContain("\u001b");
    await emit({ type: "agent_end" });
  });

  test("errors remain visible while waiting and actionable tools close the live group", async () => {
    const { host, emit } = await start();
    await message(emit, [call("a")]);
    await execute(emit, call("a"), true);
    expect(rows(host).join("\n")).toContain("1 failed");
    expect(rows(host).join("\n")).toContain("Permission denied");
    expect(rows(host)[1]).toBe("  Reading a.txt");
    const patch = { type: "toolCall", id: "patch", name: "apply_patch", arguments: { patch: "patch body" } };
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([patch]) });
    expect(rows(host).join("\n")).not.toContain("awaiting next step");
    expect(rows(host)[1]).toStartWith("• 1 failed · Read 1 file");
    expect(rows(host).join("\n")).toContain("Permission denied");
    await emit({ type: "message_end", message: assistant([patch]) });
    await emit({ type: "agent_end" });
  });

  test("interruptions close live groups and do not hide incomplete-call errors", async () => {
    const { host, emit } = await start();
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([call("a", "")]) });
    expect(rows(host)).toEqual([]);
    await emit({ type: "message_end", message: { ...assistant([call("a", "")]), stopReason: "aborted" } });
    expect(rows(host).join("\n")).toContain("Operation aborted");
    expect(rows(host).join("\n")).not.toContain("awaiting next step");
    expect(rows(host).join("\n")).not.toContain("running");
    await emit({ type: "agent_end" });
  });

  test("completed live runs replay and reload without inventing preparation or waiting", async () => {
    const { host, emit } = await start();
    const items: any[] = [];
    for (const input of [call("a"), call("b")]) {
      const content = [{ type: "thinking", thinking: "Next operation" }, input];
      items.push(assistant(content), {
        role: "toolResult", toolCallId: input.id, toolName: input.name,
        content: [{ type: "text", text: "Done" }], isError: false, timestamp: 2,
      });
      await message(emit, content);
      await execute(emit, input);
    }
    expect(rows(host)[1]).toBe("  Reading b.txt");
    const reply = [{ type: "text", text: "Complete." }];
    items.push(assistant(reply));
    const saved = JSON.stringify(items);
    await message(emit, reply);
    await emit({ type: "agent_end" });
    const complete = rows(host);
    expect(complete[1]).toBe("  Read 2 files");
    const restored = mode();
    restored.hideThinkingBlock = true;
    (InteractiveMode.prototype as any).renderSessionItems.call(restored, items);
    expect(rows(restored)).toEqual(complete);
    installReadGrouping({ on() { return () => {}; } } as any);
    restored.chatContainer.clear();
    (InteractiveMode.prototype as any).renderSessionItems.call(restored, items);
    expect(rows(restored)).toEqual(complete);
    expect(JSON.stringify(items)).toBe(saved);
  });

  test("hidden custom messages preserve the live group while displayed messages close it", async () => {
    const { host, emit } = await start();
    const original = host.addMessageToChat;
    host.session.extensionRunner = { getMessageRenderer: () => undefined };
    host.addMessageToChat = function (message: any) {
      if (message.role === "custom") return (InteractiveMode.prototype as any).addMessageToChat.call(this, message);
      return original.call(this, message);
    };
    await message(emit, [call("a")]);
    await execute(emit, call("a"));
    const waiting = rows(host);
    for (const display of [false, true]) {
      const notice = { role: "custom", customType: "notice", content: "Custom notice", display, timestamp: 1 };
      await emit({ type: "message_start", message: notice });
      await emit({ type: "message_end", message: notice });
      if (!display) expect(rows(host)).toEqual(waiting);
      else {
        expect(rows(host)[1]).toBe("  Read 1 file");
        expect(rows(host).join("\n")).toContain("Custom notice");
        expect(rows(host).join("\n")).not.toContain("awaiting next step");
      }
    }
    await emit({ type: "agent_end" });
  });

  test("custom entries close a live group only when the host actually renders a component", async () => {
    const { host, emit } = await start();
    host.entriesRenderedByBoundaryCompaction = new Set();
    host.session.extensionRunner = {
      getEntryRenderer: (type: string) => type === "visible" ? () => new Text("Visible custom entry", 0, 0)
        : type === "empty" ? () => undefined : undefined,
    };
    host.addCustomEntryToChat = (InteractiveMode.prototype as any).addCustomEntryToChat;
    await message(emit, [call("a")]);
    await execute(emit, call("a"));
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([{ type: "thinking", thinking: "Next operation" }]) });
    const waiting = rows(host);
    for (const customType of ["unregistered", "empty", "visible"]) {
      await emit({ type: "entry_appended", entry: { type: "custom", id: customType, customType, data: {}, timestamp: "now" } });
      if (customType !== "visible") expect(rows(host)).toEqual(waiting);
      else {
        expect(rows(host)[1]).toBe("  Read 1 file");
        expect(rows(host).join("\n")).toContain("Visible custom entry");
        expect(rows(host).join("\n")).not.toContain("awaiting next step");
      }
    }
    await emit({ type: "agent_end" });
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
    expect(headers(host)).toHaveLength(calls.length);
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
      expect(headers(host)).toHaveLength(2);
      expect(headers(host).every(group => group.members.length === 1)).toBe(true);
    }
  });

  test("partial search arguments do not invent patterns and optional roots default to cwd", () => {
    for (const name of ["grep", "find"] as const) {
      const { host, controller } = setup();
      const partial = explore("x", name);
      controller.recordMessage(assistant([call("a"), partial]));
      tool(host, call("a"));
      const component = tool(host, partial, false);
      expect(headers(host)).toHaveLength(1);
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
      expect(headers(host)).toHaveLength(1);
      expect(headers(host)[0].members.map((member: any) => member.toolCallId)).toEqual(["a"]);
    }
  });
});

describe("exploration group presentation", () => {
  test("a single file or shell call has the same live-to-summary lifecycle as a batch", () => {
    for (const [input, active, target, completed] of [
      [call("a"), "Reading 1 file", "Reading a.txt", "Read 1 file"],
      [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "npm test" } },
        "Running 1 shell command", "$ npm test", "Ran 1 shell command"],
    ] as const) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([input]));
      const component = tool(host, input, false);
      expect(headers(host)).toHaveLength(1);
      const group = headers(host)[0];
      expect(rows(host)[1]).toBe(`• ${active}…`);
      expect(rows(host)).toHaveLength(2); // Queued, not executing yet.
      component.markExecutionStarted();
      expect(rows(host)[2]).toBe(`  ⎿ ${target}`);
      component.updateResult({ content: [{ type: "text", text: "partial result" }] }, true);
      expect(rows(host)[1]).toBe(`• ${active}…`);
      component.updateResult({ content: [{ type: "text", text: "complete result" }] });
      expect(rows(host)).toEqual(["", `  ${completed}`]);
      expect(headers(host)[0]).toBe(group);
      expect(clickRow(host, completed)?.handled).toBe(true);
      expect(rows(host).join("\n")).toContain(input.name === "read" ? "Read(a.txt)" : "Bash(npm test)");
      (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
      expect(rows(host).join("\n")).toContain("complete result");
      (InteractiveMode.prototype as any).setToolsExpanded.call(host, false);
      expect(rows(host)).toEqual(["", `  ${completed}`]);
    }
  });

  test("reads and shell commands share one receipt and wait for every call to finish", () => {
    const { host, controller } = setup();
    const bash = { type: "toolCall", id: "bash", name: "bash", arguments: { command: "npm test" } };
    const calls = [call("a"), bash, call("b"), call("c")];
    const message = assistant(calls);
    const saved = JSON.stringify(message);
    controller.recordMessage(message);
    const originals = calls.map(input => tool(host, input, false));
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].members).toEqual(originals);
    originals[0].markExecutionStarted();
    originals[0].updateResult({ content: [] });
    originals[1].markExecutionStarted();
    originals[2].markExecutionStarted();
    expect(rows(host)[1]).toBe("• Reading 3 files, running 1 shell command…");
    expect(rows(host)[2]).toBe("  ⎿ $ npm test · +1 running");
    originals[1].updateResult({ content: [{ type: "text", text: "Tests pass" }] });
    expect(rows(host)[2]).toBe("  ⎿ Reading b.txt");
    originals[2].updateResult({ content: [] });
    expect(rows(host)[1]).toContain("Reading 3 files, running 1 shell command…");
    originals[3].updateResult({ content: [] });
    expect(rows(host)).toEqual(["", "  Read 3 files, ran 1 shell command"]);
    expect(JSON.stringify(message)).toBe(saved);
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host).join("\n")).toContain("Tests pass");
  });

  test("tool-only rounds merge under either thinking setting, but assistant prose ends the group", () => {
    for (const hidden of [false, true]) {
      const { host, controller } = setup();
      host.hideThinkingBlock = hidden;
      const shell = { type: "toolCall", id: "s", name: "bash", arguments: { command: "pwd" } };
      for (const input of [call("a"), shell]) {
        addAssistant(host, controller, assistant([input]));
        tool(host, input);
      }
      expect(rows(host)).toEqual(["", "  Read 1 file, ran 1 shell command"]);
      addAssistant(host, controller, assistant([{ type: "text", text: "Now I will check another file." }]));
      addAssistant(host, controller, assistant([call("b")]));
      tool(host, call("b"));
      expect(headers(host)).toHaveLength(2);
      const output = rows(host).join("\n");
      expect(output.indexOf("Read 1 file, ran 1 shell command")).toBeLessThan(output.indexOf("Now I will"));
      expect(output.lastIndexOf("Read 1 file")).toBeGreaterThan(output.indexOf("Now I will"));
    }
  });

  test("shell failures and interruptions keep their command and diagnostics visible, even alone", () => {
    for (const diagnostic of ["Command exited with code 2", "Command aborted"]) {
      const { host, controller } = setup();
      const input = { type: "toolCall", id: "b", name: "bash", arguments: { command: "npm test" } };
      controller.recordMessage(assistant([input]));
      const component = tool(host, input, false);
      component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: diagnostic }], isError: true });
      expect(rows(host)[1]).toStartWith("• 1 failed · Ran 1 shell command");
      expect(rows(host)[2]).toBe(`  ⎿ $ npm test: ${diagnostic}`);
      expect(rows(host).join("\n")).not.toContain("Running");
    }
  });

  test("shell commands sanitize controls and truncate without classifying scripts as file reads", () => {
    const { host, controller } = setup();
    const input = { type: "toolCall", id: "b", name: "bash",
      arguments: { command: "\u001b[31mcat 文件.ts\nls src\t# more" } };
    controller.recordMessage(assistant([input]));
    const component = tool(host, input, false);
    component.markExecutionStarted();
    expect(headers(host)[0].render(80)[2]).toBe("  ⎿ $ cat 文件.ts ls src # more");
    for (const width of [0, 1, 2, 3, 5, 6, 24, 80]) {
      expect(rows(host, width).every(row => visibleWidth(row) <= width)).toBe(true);
    }
    component.updateResult({ content: [] });
    expect(rows(host)).toEqual(["", "  Ran 1 shell command"]);
  });

  test("apply_patch diffs stay visible between singleton summaries", () => {
    const { host, controller } = setup();
    const patch = { type: "toolCall", id: "p", name: "apply_patch", arguments: { patch: "patch body" } };
    controller.recordMessage(assistant([call("a"), patch, call("b")]));
    tool(host, call("a"));
    const definition: any = {
      renderShell: "self",
      renderCall: () => new Text("Patch(example.ts)", 0, 0),
      renderResult: (_result: any, options: any, theme: any) => createDiffComponent({
        details: normalizeApplyPatchDetails({
          changes: [{ type: "update", path: "example.ts", diff: "@@ -1 +1 @@\n-before\n+after" }],
        })!,
        expanded: options.expanded, theme,
      }),
    };
    const component = new ToolExecutionComponent("apply_patch", "p", patch.arguments,
      { showImages: false }, definition, host.ui, "/repo");
    component.updateResult({ content: [], details: undefined });
    const originalRender = component.render;
    host.chatContainer.addChild(component);
    tool(host, call("b"));
    const output = rows(host).join("\n");
    expect(headers(host)).toHaveLength(2);
    expect(output).toContain("Patch(example.ts)");
    expect(output).toContain("before");
    expect(output).toContain("after");
    expect(component.render).toBe(originalRender);
    expect(output.indexOf("Read 1 file")).toBeLessThan(output.indexOf("Patch(example.ts)"));
    expect(output.lastIndexOf("Read 1 file")).toBeGreaterThan(output.indexOf("Patch(example.ts)"));
  });

  test("returned file images collapse into read counts and keep original payloads on expansion", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("a"), call("image", "image.png"), call("b")]));
    tool(host, call("a"));
    const image = tool(host, call("image", "image.png"), false);
    const result = { content: [{ type: "image" as const, data: "payload", mimeType: "image/png" }], details: undefined };
    image.updateResult(result);
    tool(host, call("b"));
    rows(host);
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].members).toHaveLength(3);
    expect(rows(host).join("\n")).toContain("Read 3 files");
    expect(rows(host).join("\n")).not.toContain("Read(image.png)");
    expect(image.render(80)).toEqual([]);
    clickRow(host, "Read 3 files");
    expect(rows(host).join("\n")).toContain("Read(image.png)");
    expect((image as any).result).toBe(result);
    clickRow(host, "Read 3 files");
    expect(image.render(80)).toEqual([]);
  });

  test("a singleton image read reveals its native graphic when expanded", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, images: "kitty" });
    const { host, controller } = setup();
    try {
      controller.recordMessage(assistant([call("image", "image.png")]));
      const image = tool(host, call("image", "image.png"), false);
      image.setShowImages(true);
      const result = {
        content: [{ type: "image" as const, mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=" }],
        details: undefined,
      };
      image.updateResult(result);
      const graphics = [...(image as any).imageComponents];
      expect(graphics).toHaveLength(1);
      expect(rows(host).join("\n")).toContain("Read 1 file");
      expect(host.chatContainer.render(80).join("\n")).not.toContain("\x1b_G");
      clickRow(host, "Read 1 file");
      expect(rows(host).join("\n")).toContain("Read(image.png)");
      expect(host.chatContainer.render(80).join("\n")).toContain("\x1b_G");
      expect((image as any).imageComponents).toEqual(graphics);
      expect((image as any).result).toBe(result);
      clickRow(host, "Read 1 file");
      expect(host.chatContainer.render(80).join("\n")).not.toContain("\x1b_G");
      (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
      expect(host.chatContainer.render(80).join("\n")).toContain("\x1b_G");
      controller.detach();
      expect(host.chatContainer.render(80).join("\n")).toContain("\x1b_G");
    } finally {
      controller.detach();
      setCapabilities(capabilities);
    }
  });

  test("failed image reads retain their visible error in a collapsed group", () => {
    const { host, controller } = setup();
    controller.recordMessage(assistant([call("image", "image.png")]));
    const image = tool(host, call("image", "image.png"), false);
    image.updateResult({ isError: true, details: undefined,
      content: [{ type: "image", data: "payload", mimeType: "image/png" },
        { type: "text", text: "Cannot decode image" }] });
    const output = rows(host).join("\n");
    expect(headers(host)).toHaveLength(1);
    expect(output).toContain("1 failed");
    expect(output).toContain("Cannot decode image");
  });

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
    expect(rows(host)[1]).toStartWith("  Read 2 files");
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
    expect(rows(host).join("\n")).toContain("Read(a.txt) · running…");
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

  test("completed summaries stay muted while active and failed groups retain status colors", () => {
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
      expect(header).toBe("  \u001b[90mRead 2 files\u001b[39m");
      headers(host)[0].setExpanded(true);
      expect(headers(host)[0].render(180)[1]).toContain("\u001b[90m (ctrl+o to collapse all)\u001b[39m");
      headers(host)[0].setExpanded(false);
      b.updateResult({ content: [{ type: "text", text: "Progress" }] }, true);
      header = headers(host)[0].render(180)[1];
      expect(header).toContain("\u001b[36m•\u001b[39m");
      expect(header).toContain("\u001b[36mReading 2 files\u001b[39m");
      a.updateResult({ content: [], isError: true });
      const failed = headers(host)[0].render(180);
      expect(failed[1]).toContain("\u001b[31m•\u001b[39m");
      expect(stripTerminalSequences(failed[1])).not.toMatch(/^[●⏺]/u);
      expect(failed[1]).toContain("\u001b[31m1 failed\u001b[39m");
      expect(failed[1]).toContain("\u001b[36mReading 2 files\u001b[39m");
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

  test("singleton shells and mixed read/shell rounds match live, replay and reload", async () => {
    install();
    const bash = { type: "toolCall", id: "shell", name: "bash", arguments: { command: "npm test" } };
    for (const calls of [[bash], [call("a"), bash, call("b")]]) {
      const messages = calls.map(input => assistant([
        { type: "thinking", thinking: "Next operation" }, input,
      ]));
      const resultFor = (input: typeof calls[number]) => ({
        role: "toolResult", toolCallId: input.id, toolName: input.name,
        content: [{ type: "text", text: `contents of ${input.id}` }], isError: false, timestamp: 2,
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
        expect(rows(live).join("\n")).toContain(input.name === "bash" ? "⎿ $ npm test" : `⎿ Reading ${input.id}.txt`);
        await emit({ type: "tool_execution_end", toolCallId: input.id, isError: false, result: resultFor(input) });
      }
      const summary = calls.length === 1 ? "Ran 1 shell command" : "Read 2 files, ran 1 shell command";
      expect(rows(live)).toEqual(rows(restored));
      expect(rows(live)).toEqual(["", `  ${summary}`]);
      expect(headers(live)).toHaveLength(1);
      install();
      restored.chatContainer.clear();
      renderItems.call(restored, items);
      expect(rows(restored)).toEqual(rows(live));
      (InteractiveMode.prototype as any).setToolsExpanded.call(restored, true);
      expect(rows(restored).join("\n")).toContain("contents of shell");
      expect(JSON.stringify(items)).toBe(saved);
    }
  });

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
      expect(headers(host)).toHaveLength(2);
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
    expect(headers(host)).toHaveLength(2);
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
    expect(headers(host)).toHaveLength(2);
    host.chatContainer.clear();
    renderItems.call(host, [assistant([call("c")])]);
    tool(host, call("a"));
    tool(host, call("b"));
    expect(rows(host).join("\n")).not.toContain("files");
    expect(headers(host)).toHaveLength(1);
    expect(headers(host)[0].members.map((member: any) => member.toolCallId)).toEqual(["c"]);
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
    expect(headers(live)).toHaveLength(calls.length);
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
