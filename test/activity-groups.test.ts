import { beforeAll, describe, expect, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, InteractiveMode,
  ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { createBrowserToolRenderers, createGenericToolRenderers } from "../generic.ts";
import { activityGroupKind, activityFailed } from "../group-model.ts";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { readRenderers } from "../renderers.ts";
import { createWebToolRenderers } from "../web.ts";
import { installReadGroupingForTest } from "./read-grouping-runtime.ts";

beforeAll(async () => { await initTheme("light", false); });

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { type: "toolCall", id, name, arguments: args };
}
function assistant(content: any[]) {
  return { role: "assistant", content, stopReason: "toolUse", timestamp: 1 };
}
function definition(name: string): any {
  if (name === "read") return readRenderers;
  return createWebToolRenderers(name) ?? (name.startsWith("agent_browser")
    ? createBrowserToolRenderers(name) : createGenericToolRenderers(name));
}
function setup(hidden = true, attach = true) {
  const host: any = {
    isInitialized: true, chatContainer: new Container(), loadedResourcesContainer: new Container(),
    toolOutputExpanded: false, pendingTools: new Map(), hideThinkingBlock: hidden, outputPad: 1,
    sessionManager: { getCwd: () => "/repo", getEntries: () => [] }, session: { retryAttempt: 0 },
    footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    settingsManager: { getShowCacheMissNotices: () => false, getShowImages: () => false, getImageWidthCells: () => 60,
      getShowTerminalProgress: () => false },
    ui: { requestRender() {} }, showStatus() {}, clearStatusIndicator() {},
    getMarkdownThemeWithSettings: () => getMarkdownTheme(), getMarkdownTransformers: () => [],
    maybeShowThinkingDropNotice() {}, maybeShowCacheMissNotice() {}, maybeSuggestBugReport() {}, maybeShowInstallChangeWarning() {},
    getRegisteredToolDefinition: definition,
    addMessageToChat(message: any) {
      if (message.role === "toolResult") return;
      this.chatContainer.addChild(message.role === "assistant"
        ? new AssistantMessageComponent(message, this.hideThinkingBlock, getMarkdownTheme()) : new Text(message.role, 0, 0));
    },
  };
  const controller = new ReadGroupingController(host);
  if (attach) expect(controller.attach()).toBe(true);
  else installReadGroupingForTest(host);
  return { host, controller };
}
function tool(host: any, input: ReturnType<typeof call>, completed = true, result?: any) {
  const component = new ToolExecutionComponent(input.name, input.id, input.arguments, { showImages: false },
    definition(input.name), host.ui, "/repo");
  component.setExpanded(host.toolOutputExpanded);
  if (completed) component.updateResult(result ?? { content: [{ type: "text", text: `raw result ${input.id}` }], details: undefined });
  host.chatContainer.addChild(component);
  return component;
}
function rows(host: any, width = 160): string[] { return host.chatContainer.render(width).map(stripTerminalSequences); }
function text(host: any, width = 160): string { return rows(host, width).join("\n"); }
function groups(host: any): any[] {
  return host.chatContainer.children.filter((child: any) => !(child instanceof ToolExecutionComponent) && typeof child.setExpanded === "function");
}
function click(host: any, target: string) {
  const rendered = rows(host);
  const y = rendered.findIndex(row => row.includes(target));
  expect(y).toBeGreaterThanOrEqual(0);
  return host.chatContainer.handleMouse({ type: "click", button: "left", x: 1, y,
    screenX: 1, screenY: y, width: 160, height: rendered.length, shift: false, ctrl: false, alt: false });
}
const web = (id: string) => call(id, "fetch_content", { url: `https://example.test/${id}` });
const status = (id: string) => call(id, "get_subagent_result", { agent_id: "agent-1" });
const browser = (id: string, args: string[] = ["snapshot", "-i"]) => call(id, "agent_browser", { args });

const taskCalls = () => [
  call("create", "TaskCreate", { subject: "Review" }), call("list", "TaskList"),
  call("get", "TaskGet", { taskId: "1" }), call("update", "TaskUpdate", { taskId: "1", status: "completed" }),
  call("delete", "TaskUpdate", { taskId: "2", status: "deleted" }),
  call("execute", "TaskExecute", { task_ids: ["1"] }), call("output", "TaskOutput", { task_id: "1" }),
  call("stop", "TaskStop", { task_id: "1" }),
];

describe("hidden task tools", () => {
  test("task calls stay hidden while queued, executing, completed and globally expanded", () => {
    const { host, controller } = setup();
    const calls = taskCalls();
    const message = assistant(calls);
    const saved = JSON.stringify(message);
    controller.recordMessage(message);
    const originals = calls.map(input => tool(host, input, false));
    expect(rows(host)).toEqual([]);
    for (const component of originals) {
      component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: "Progress" }] }, true);
    }
    expect(rows(host)).toEqual([]);
    originals.forEach((component, index) => component.updateResult({
      content: [{ type: "text", text: "Done" }],
      details: calls[index].name === "TaskStop" ? { status: "stopped" } : undefined,
    }));
    expect(rows(host)).toEqual([]);
    expect(groups(host)).toHaveLength(0);
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(rows(host)).toEqual([]);
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent)).toEqual(originals);
    expect(JSON.stringify(message)).toBe(saved);
    controller.detach();
    expect(text(host)).toContain("CreateTask");
    expect(text(host)).toContain("RunTasks");
  });

  test("task failures surface and split groups, including background failure text, then can recover", () => {
    const { host, controller } = setup();
    const output = call("task", "TaskOutput", { task_id: "run-1" });
    controller.recordMessage(assistant([web("a"), output, web("b")]));
    tool(host, web("a"));
    const component = tool(host, output);
    tool(host, web("b"));
    expect(text(host)).toContain("Web research · 2 fetches");
    expect(text(host)).not.toContain("TaskOutput");
    for (const result of [
      { content: [{ type: "text", text: "Permission denied" }], isError: true },
      { content: [{ type: "text", text: "Task #run-1 (completed) exit code: 2\nTest failed" }] },
    ]) {
      component.updateResult(result);
      expect(text(host)).toContain("TaskOutput");
      expect(text(host)).toContain(result.content[0].text.split("\n")[0]);
      expect(groups(host)).toHaveLength(2);
    }
    component.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(text(host)).not.toContain("TaskOutput");
    expect(text(host)).toContain("Web research · 2 fetches");
    expect(groups(host)).toHaveLength(1);
  });

  test("details-only task failures remain readable and retained wrappers fail open after detach", () => {
    const { host, controller } = setup();
    const input = call("task", "TaskGet", { taskId: "1" });
    controller.recordMessage(assistant([input]));
    const component = tool(host, input);
    component.updateResult({ content: [], details: { error: "Task lookup unavailable" } });
    expect(text(host)).toContain("Task lookup unavailable");
    component.updateResult({ content: [{ type: "text", text: "Done" }] });
    expect(rows(host)).toEqual([]);
    const wrapped = component.render;
    const later = function (this: any, ...args: any[]) { return wrapped.apply(this, args); };
    component.render = later;
    controller.detach();
    expect(component.render).toBe(later);
    expect(text(host)).toContain("GetTask(#1)");
    expect(text(host)).toContain("Done");
  });

  test("live task-only rounds leave the prior preview intact and add no summary counts", async () => {
    installReadGrouping({ on() { return () => {}; } } as any);
    const host = setup(true, false).host;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
    const read = call("read", "read", { path: "/repo/package.json" });
    await emit({ type: "agent_start" });
    for (const input of [read, ...taskCalls()]) {
      await emit({ type: "message_start", message: assistant([]) });
      if (input !== read) {
        await emit({ type: "message_update", message: assistant([{ ...input, arguments: {} }]) });
        expect(rows(host)).toEqual(["", "  Reading package.json", "  ⎿ /repo/package.json"]);
      }
      await emit({ type: "message_update", message: assistant([input]) });
      await emit({ type: "message_end", message: assistant([input]) });
      await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: input.name, args: input.arguments });
      await emit({ type: "tool_execution_end", toolCallId: input.id, isError: false, result: { content: [] } });
      expect(rows(host)).toEqual(["", "  Reading package.json", "  ⎿ /repo/package.json"]);
    }
    const reply = assistant([{ type: "text", text: "Complete." }]);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: reply });
    await emit({ type: "message_end", message: reply });
    await emit({ type: "agent_end" });
    expect(rows(host)[1]).toBe("  Read 1 file");
    expect(text(host)).not.toContain("Task activity");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(text(host)).not.toContain("CreateTask");
    expect(text(host)).not.toContain("RunTasks");
  });

  test("replay and reload hide successful tasks without suppressing historical failures", () => {
    installReadGrouping({ on() { return () => {}; } } as any);
    const calls = taskCalls();
    const items = [assistant(calls), ...calls.map(input => ({
      role: "toolResult", toolCallId: input.id, toolName: input.name,
      content: [{ type: "text", text: input.id === "get" ? "Permission denied" : "Done" }],
      isError: input.id === "get", timestamp: 2,
    }))];
    const saved = JSON.stringify(items);
    const host = setup(true, false).host;
    for (let i = 0; i < 2; i++) {
      installReadGroupingForTest(host);
      host.chatContainer.clear();
      (InteractiveMode.prototype as any).renderSessionItems.call(host, items);
      expect(text(host)).toContain("GetTask(#1)");
      expect(text(host)).toContain("Permission denied");
      expect(text(host)).not.toContain("CreateTask");
      expect(text(host)).not.toContain("Task activity");
    }
    expect(JSON.stringify(items)).toBe(saved);
  });
});

describe("routine activity groups", () => {
  test("switching routine categories replaces one preview without exposing counts before prose", async () => {
    installReadGrouping({ on() { return () => {}; } } as any);
    const host = setup(true, false).host;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
    const read = call("r", "read", { path: "/repo/package.json" });
    const fetch = web("w");
    await emit({ type: "agent_start" });
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([read]) });
    await emit({ type: "message_end", message: assistant([read]) });
    await emit({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: read.arguments });
    await emit({ type: "tool_execution_end", toolCallId: "r", isError: false, result: { content: [] } });
    const filePreview = ["", "  Reading package.json", "  ⎿ /repo/package.json"];
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: assistant([{ ...fetch, arguments: {} }]) });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "message_update", message: assistant([fetch]) });
    await emit({ type: "message_end", message: assistant([fetch]) });
    expect(rows(host)).toEqual(filePreview);
    await emit({ type: "tool_execution_start", toolCallId: "w", toolName: "fetch_content", args: fetch.arguments });
    await emit({ type: "tool_execution_end", toolCallId: "w", isError: false,
      result: { content: [{ type: "text", text: "Page title\nPage excerpt" }] } });
    expect(groups(host)).toHaveLength(1);
    expect(rows(host)).toEqual(["", "  WebFetch(https://example.test/w)", "  ⎿ Page title", "    Page excerpt"]);
    expect(text(host)).not.toContain("Read 1 file");
    const reply = assistant([{ type: "text", text: "Here is what I found." }]);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message: reply });
    await emit({ type: "message_end", message: reply });
    await emit({ type: "agent_end" });
    expect(rows(host)[1]).toBe("  Read 1 file · Web research · 1 fetch");
  });

  test("live category previews persist until assistant prose replaces them with summaries", async () => {
    installReadGrouping({ on() { return () => {}; } } as any);
    for (const [input, summary] of [
      [web("w"), "Web research · 1 fetch"],
      [status("s"), "Status checks · 1 agent check"],
      [browser("b"), "Browser inspection · 1 snapshot"],
    ] as const) {
      const host = setup(true, false).host;
      const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(host, event);
      await emit({ type: "agent_start" });
      await emit({ type: "message_start", message: assistant([]) });
      if (input.name !== "agent_browser") {
        await emit({ type: "message_update", message: assistant([{ ...input, arguments: {} }]) });
        expect(rows(host)).toEqual([]);
        expect(text(host)).not.toContain("running");
      }
      const message = assistant([input]);
      await emit({ type: "message_update", message });
      await emit({ type: "message_end", message });
      const preview = rows(host);
      expect(preview).toHaveLength(3);
      expect(preview[1]).not.toContain(summary);
      await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: input.name, args: input.arguments });
      await emit({ type: "tool_execution_end", toolCallId: input.id, isError: false, result: { content: [] } });
      expect(rows(host)).toEqual(preview);
      const reply = assistant([{ type: "text", text: "Complete." }]);
      await emit({ type: "message_start", message: assistant([]) });
      await emit({ type: "message_update", message: reply });
      await emit({ type: "message_end", message: reply });
      await emit({ type: "agent_end" });
      expect(rows(host)[1]).toBe(`  ${summary}`);
    }
  });

  test("singleton web, status and browser calls also collapse after completion", () => {
    for (const [input, summary] of [
      [web("w"), "Web research · 1 fetch"],
      [status("s"), "Status checks · 1 agent check"],
      [browser("b"), "Browser inspection · 1 snapshot"],
    ] as const) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([input]));
      const component = tool(host, input, false);
      component.markExecutionStarted();
      expect(rows(host)).toHaveLength(3);
      expect(text(host)).toContain("⎿");
      component.updateResult({ content: [{ type: "text", text: "raw result" }], details: undefined });
      expect(rows(host)).toEqual(["", `  ${summary}`]);
      expect(groups(host)[0].members).toEqual([component]);
      (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
      expect(text(host)).toContain("raw result");
    }
  });

  test("groups consecutive safe categories without mutating records or hiding their summary counts", () => {
    const { host, controller } = setup();
    const calls = [
      call("s", "web_search", { queries: ["one", "two", "three"] }), web("f"),
      call("c", "source_check", { claim: "A claim" }), call("w", "get_search_content", { responseId: "result", findText: ["a", "b"] }),
      call("r1", "read", { path: "one.ts" }), call("r2", "read", { path: "two.ts" }),
      call("t", "TaskCreate", { subject: "Review" }), call("u", "TaskUpdate", { taskId: "1", status: "completed" }),
      call("l", "TaskList"), call("g", "TaskGet", { taskId: "1" }),
      status("p1"), call("p2", "TaskOutput", { task_id: "task-1" }), browser("b1"), browser("b2", ["get", "title"]),
    ];
    const message = assistant(calls);
    const saved = JSON.stringify(message);
    controller.recordMessage(message);
    const originals = calls.map(input => tool(host, input));
    expect(text(host, 1000)).toContain("Web research · 1 search, 1 source check, 1 fetch, 1 content read");
    expect(text(host, 1000)).toContain("Read 2 files");
    expect(text(host, 1000)).not.toContain("Task activity");
    expect(text(host, 1000)).toContain("Status checks · 1 agent check");
    expect(text(host, 1000)).not.toContain("task check");
    expect(text(host, 1000)).toContain("Browser inspection · 1 snapshot, 1 read");
    expect(groups(host)).toHaveLength(1);
    expect(text(host)).not.toContain("raw result");
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent)).toEqual(originals);
    expect(JSON.stringify(message)).toBe(saved);
  });

  test("does not move calls across prose, action boundaries or different group categories even when their tool component is absent", () => {
    const boundaries = [
      { type: "text", text: "Explanation" },
      call("action", "bash", { command: "pwd" }), call("action", "apply_patch", { patch: "patch" }),
      call("action", "ask_user_question", { questions: [{ question: "Choose" }] }),
      call("action", "Agent", { description: "Inspect" }),
      call("action", "agent_browser", { args: ["click", "@e1"] }),
      call("action", "agent_browser_code", { code: "document.body.click()" }),
      call("category", "read", { path: "one.ts" }),
    ];
    for (const boundary of boundaries) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([web("a"), boundary, web("b")]));
      tool(host, web("a")); tool(host, web("b"));
      expect(groups(host)).toHaveLength(2);
      expect(groups(host).every(group => group.members.length === 1)).toBe(true);
      expect(text(host).match(/Web research · 1 fetch/g)).toHaveLength(2);
    }
  });

  test("user, custom and interrupted messages remain hard boundaries", () => {
    for (const boundary of [
      { role: "user", content: "New request" }, { role: "custom", content: "Notice" },
      { ...assistant([{ type: "thinking", thinking: "Interrupted" }]), stopReason: "aborted", errorMessage: "Stopped" },
    ]) {
      const { host, controller } = setup();
      for (const [message, input] of [[assistant([web("a")]), web("a")], [boundary, undefined], [assistant([web("b")]), web("b")]] as any[]) {
        controller.recordMessage(message); host.addMessageToChat(message);
        if (input) tool(host, input);
      }
      expect(groups(host)).toHaveLength(2);
      expect(groups(host).every(group => group.members.length === 1)).toBe(true);
    }
  });

  test("group expansion reveals original aliases and global expansion reveals full results", () => {
    const { host, controller } = setup();
    const calls = [web("a"), web("b")];
    controller.recordMessage(assistant(calls)); calls.forEach(input => tool(host, input));
    expect(click(host, "Web research")?.handled).toBe(true);
    expect(text(host)).toContain("• WebFetch(https://example.test/a)");
    expect(click(host, "https://example.test/a")?.handled).toBe(true);
    expect(text(host)).toContain("raw result a");
    click(host, "Web research"); expect(text(host)).not.toContain("raw result a");
    click(host, "Web research"); expect(text(host)).toContain("raw result a");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, true);
    expect(text(host)).toContain("raw result b");
    (InteractiveMode.prototype as any).setToolsExpanded.call(host, false);
    expect(text(host)).not.toContain("raw result");
  });

  test("live targets show actual executing calls, never queued calls, and disappear on completion", () => {
    const { host, controller } = setup();
    const calls = [web("queued"), web("a"), web("b")];
    controller.recordMessage(assistant(calls));
    const [queued, a, b] = calls.map(input => tool(host, input, false));
    expect(rows(host)).toHaveLength(2);
    a.markExecutionStarted(); b.markExecutionStarted();
    expect(text(host)).toContain("⎿ WebFetch(https://example.test/a) · +1 running");
    expect(text(host)).not.toContain("/queued");
    a.updateResult({ content: [], details: undefined });
    expect(text(host)).toContain("⎿ WebFetch(https://example.test/b)");
    b.updateResult({ content: [], details: undefined });
    queued.updateResult({ content: [], details: undefined });
    expect(rows(host)).toHaveLength(2);
    expect(text(host)).not.toContain("⎿");
  });

  test("failures, partial successes and background failures stay visible when collapsed", () => {
    const cases = [
      [web("bad"), { content: [{ type: "text", text: "Permission denied" }], isError: true }, "Permission denied"],
      [web("bad"), { content: [], details: { error: "Fetch failed" } }, "Fetch failed"],
      [web("bad"), { content: [], details: { successful: 1, urlCount: 3 } }, "1/3 URLs succeeded"],
      [call("bad", "web_search", { query: "x" }), { content: [], details: { successfulQueries: 1, queryCount: 2 } }, "1/2 queries succeeded"],
      [call("bad", "source_check", { claim: "A claim" }), { content: [{ type: "text", text: "{\nartifact\n}" }],
        details: { artifact: { errors: [{ error: "Evidence search unavailable" }] } } }, "Evidence search unavailable"],
      [browser("bad"), { content: [], details: { resultCategory: "failure", summary: "Page missing" } }, "Page missing"],
      [status("bad"), { content: [], details: { status: "error", error: "Agent crashed" } }, "Agent crashed"],
      [call("bad", "TaskOutput", { task_id: "run-1" }), { content: [{ type: "text", text: "Task #run-1 (completed) exit code: 2\n\nTest failed" }] }, "exit code: 2"],
    ] as const;
    for (const [input, result, expected] of cases) {
      const { host, controller } = setup();
      const second = { ...input, id: "good" };
      controller.recordMessage(assistant([input, second]));
      tool(host, input as any, true, result); tool(host, second as any);
      if (input.name !== "TaskOutput") expect(text(host)).toContain("1 failed");
      expect(text(host)).toContain(expected);
      for (const width of [1, 2, 4, 24, 80]) expect(rows(host, width).every(line => visibleWidth(line) <= width)).toBe(true);
      if (input.name !== "TaskOutput") expect(text(host, 24)).toContain("1 failed");
    }
    expect(activityFailed({ toolName: "TaskOutput", result: { content: [{ type: "text", text: "Task #run-1 (running)\n\nError mentioned in ordinary logs" }] } })).toBe(false);
  });

  test("in-progress query counts are not failures, while explicit streaming errors are", () => {
    const { host, controller } = setup();
    const calls = [call("s", "web_search", { queries: ["one", "two", "three"] }), web("f")];
    controller.recordMessage(assistant(calls));
    const [search] = calls.map(input => tool(host, input, false));
    search.markExecutionStarted();
    search.updateResult({ content: [], details: { queryCount: 3, successfulQueries: 1 } }, true);
    expect(text(host)).not.toContain("failed");
    expect(text(host)).toContain("⎿ WebSearch(3 queries)");
    search.updateResult({ content: [], details: { error: "Provider unavailable" } }, true);
    expect(text(host)).toContain("1 failed");
    expect(text(host)).toContain("Provider unavailable");
  });

  test("changed browser arguments, task deletions and returned images split existing groups", () => {
    for (const [inputs, changedArgs, changedResult] of [
      [[browser("a"), browser("b")], { args: ["click", "@e1"] }, undefined],
      [[web("a"), web("b")], undefined, { content: [{ type: "image", data: "payload", mimeType: "image/png" }], details: undefined }],
    ] as any[]) {
      const { host, controller } = setup();
      controller.recordMessage(assistant(inputs));
      const components = inputs.map((input: any) => tool(host, input));
      expect(groups(host)).toHaveLength(1);
      if (changedArgs) components[1].updateArgs(changedArgs);
      if (changedResult) components[1].updateResult(changedResult);
      rows(host);
      expect(groups(host)).toHaveLength(1);
      expect(groups(host)[0].members).toEqual([components[0]]);
      expect(text(host)).toContain(changedResult ? "WebFetch" : changedArgs.args ? "Browser(click" : "UpdateTask");
    }
  });

  test("browser inspection allowlist never groups arbitrary code, actions, batches or output writes", () => {
    for (const argv of [["snapshot"], ["snapshot", "-i", "--depth", "3"], ["get", "title"], ["get", "text", "PRIVATE_SELECTOR"], ["is", "visible", "@e1"]]) {
      expect(activityGroupKind("agent_browser", { args: argv })).toBe("browser");
    }
    for (const argv of [["click", "@e1"], ["fill", "@e1", "PRIVATE"], ["eval", "code"], ["batch"], ["screenshot", "file.png"], ["get", "unknown"], ["snapshot", "--output", "file.txt"]]) {
      expect(activityGroupKind("agent_browser", { args: argv })).toBeUndefined();
    }
    expect(activityGroupKind("agent_browser_code", { code: "read only maybe" })).toBeUndefined();
    expect(activityGroupKind("agent_browser", { args: ["snapshot"], stdin: "PRIVATE" })).toBeUndefined();
    const { host, controller } = setup();
    const calls = [browser("a", ["get", "text", "PRIVATE_SELECTOR"]), browser("b", ["is", "visible", "PRIVATE_SELECTOR"])];
    controller.recordMessage(assistant(calls));
    calls.forEach(input => tool(host, input, false).markExecutionStarted());
    expect(text(host)).not.toContain("PRIVATE_SELECTOR");
    expect(text(host)).toContain("Browser(get text)");
  });

  test("hidden thinking permits consecutive same-category groups but visible reasoning separates messages", () => {
    const { host, controller } = setup();
    for (const input of [web("a"), web("b")]) {
      const message = assistant([{ type: "thinking", thinking: "Private reasoning" }, input]);
      controller.recordMessage(message); host.addMessageToChat(message); tool(host, input);
    }
    expect(text(host)).toContain("Web research · 2 fetches");
    expect(text(host)).not.toContain("Private reasoning");
    host.hideThinkingBlock = false;
    (InteractiveMode.prototype as any).updateThinkingBlockVisibility.call(host);
    expect(text(host)).toContain("Private reasoning");
    expect(groups(host)).toHaveLength(2);
  });

  test("missing unsafe calls in hidden assistant messages still prevent cross-message grouping", () => {
    const { host, controller } = setup();
    for (const input of [browser("a"), browser("unsafe", ["click", "@e1"]), browser("b")]) {
      const message = assistant([input]);
      controller.recordMessage(message); host.addMessageToChat(message);
      if (input.id !== "unsafe") tool(host, input);
    }
    expect(groups(host)).toHaveLength(2);
    expect(groups(host).every(group => group.members.length === 1)).toBe(true);
  });

  test("missing calls from another category still break groups across hidden assistant messages", () => {
    for (const boundary of [status("status"), browser("browser"), call("file", "read", { path: "file.ts" })]) {
      const { host, controller } = setup();
      for (const input of [web("a"), boundary, web("b")]) {
        const message = assistant([input]);
        controller.recordMessage(message); host.addMessageToChat(message);
        if (input !== boundary) tool(host, input);
      }
      expect(groups(host)).toHaveLength(2);
      expect(groups(host).every(group => group.members.length === 1)).toBe(true);
    }
  });

  test("replay, live updates and reload produce equivalent category groups", async () => {
    installReadGrouping({ on() { return () => {}; } } as any);
    const calls = [web("a"), web("b"), call("t", "TaskList"), call("u", "TaskGet", { taskId: "1" })];
    const message = assistant(calls);
    const results = calls.map(input => ({ role: "toolResult", toolCallId: input.id, toolName: input.name,
      content: [{ type: "text", text: `raw result ${input.id}` }], details: undefined, isError: false, timestamp: 2 }));
    const items = [message, ...results];
    const saved = JSON.stringify(items);
    const restored = setup(true, false).host;
    const renderItems = (InteractiveMode.prototype as any).renderSessionItems;
    renderItems.call(restored, items);
    const live = setup(true, false).host;
    const emit = (event: any) => (InteractiveMode.prototype as any).handleEvent.call(live, event);
    await emit({ type: "message_start", message: assistant([]) });
    await emit({ type: "message_update", message }); await emit({ type: "message_end", message });
    for (const [i, input] of calls.entries()) {
      await emit({ type: "tool_execution_start", toolCallId: input.id, toolName: input.name, args: input.arguments });
      await emit({ type: "tool_execution_end", toolCallId: input.id, toolName: input.name, isError: false, result: results[i] });
    }
    expect(rows(live)).toEqual(rows(restored));
    expect(groups(live)).toHaveLength(1);
    installReadGroupingForTest(restored);
    restored.chatContainer.clear(); renderItems.call(restored, items);
    expect(text(restored)).toContain("Web research · 2 fetches");
    expect(JSON.stringify(items)).toBe(saved);
  });
});
