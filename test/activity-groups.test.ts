import { beforeAll, describe, expect, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, InteractiveMode,
  ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { createBrowserToolRenderers, createGenericToolRenderers } from "../generic.ts";
import { activityGroupKind, activityFailed } from "../group-model.ts";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { readRenderers } from "../renderers.ts";
import { createWebToolRenderers } from "../web.ts";

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
    settingsManager: { getShowCacheMissNotices: () => false, getShowImages: () => false, getImageWidthCells: () => 60 },
    ui: { requestRender() {} }, showStatus() {},
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

describe("routine activity groups", () => {
  test("groups web operations separately from files, task bookkeeping and polls without mutating records", () => {
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
    expect(text(host)).toContain("Web research · 1 search, 1 source check, 1 fetch, 1 content read");
    expect(text(host)).toContain("Read 2 files");
    expect(text(host)).toContain("Task activity · 1 creation, 1 update, 1 list, 1 lookup");
    expect(text(host)).toContain("Status checks · 1 agent check, 1 task check");
    expect(text(host)).toContain("Browser inspection · 1 snapshot, 1 read");
    expect(groups(host)).toHaveLength(5);
    expect(text(host)).not.toContain("raw result");
    expect(host.chatContainer.children.filter((child: any) => child instanceof ToolExecutionComponent)).toEqual(originals);
    expect(JSON.stringify(message)).toBe(saved);
  });

  test("does not move calls across prose, action boundaries or different group categories even when their tool component is absent", () => {
    const boundaries = [
      { type: "text", text: "Explanation" },
      call("action", "bash", { command: "pwd" }), call("action", "apply_patch", { patch: "patch" }),
      call("action", "ask_user_question", { questions: [{ question: "Choose" }] }),
      call("action", "Agent", { description: "Inspect" }), call("action", "TaskExecute", { task_ids: ["1"] }),
      call("action", "TaskStop", { task_id: "1" }), call("action", "TaskUpdate", { taskId: "1", status: "deleted" }),
      call("action", "agent_browser", { args: ["click", "@e1"] }),
      call("action", "agent_browser_code", { code: "document.body.click()" }),
      call("category", "TaskList"), call("category", "read", { path: "one.ts" }),
    ];
    for (const boundary of boundaries) {
      const { host, controller } = setup();
      controller.recordMessage(assistant([web("a"), boundary, web("b")]));
      tool(host, web("a")); tool(host, web("b"));
      expect(groups(host)).toHaveLength(0);
      expect(text(host)).toContain("WebFetch");
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
      expect(groups(host)).toHaveLength(0);
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
      expect(text(host)).toContain("1 failed");
      expect(text(host)).toContain(expected);
      for (const width of [1, 2, 4, 24, 80]) expect(rows(host, width).every(line => visibleWidth(line) <= width)).toBe(true);
      expect(text(host, 24)).toContain("1 failed");
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
      [[call("a", "TaskUpdate", { taskId: "1", status: "pending" }), call("b", "TaskUpdate", { taskId: "2", status: "pending" })], { taskId: "2", status: "deleted" }, undefined],
      [[web("a"), web("b")], undefined, { content: [{ type: "image", data: "payload", mimeType: "image/png" }], details: undefined }],
    ] as any[]) {
      const { host, controller } = setup();
      controller.recordMessage(assistant(inputs));
      const components = inputs.map((input: any) => tool(host, input));
      expect(groups(host)).toHaveLength(1);
      if (changedArgs) components[1].updateArgs(changedArgs);
      if (changedResult) components[1].updateResult(changedResult);
      rows(host);
      expect(groups(host)).toHaveLength(0);
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
    expect(groups(host)).toHaveLength(0);
  });

  test("missing unsafe calls in hidden assistant messages still prevent cross-message grouping", () => {
    const { host, controller } = setup();
    for (const input of [browser("a"), browser("unsafe", ["click", "@e1"]), browser("b")]) {
      const message = assistant([input]);
      controller.recordMessage(message); host.addMessageToChat(message);
      if (input.id !== "unsafe") tool(host, input);
    }
    expect(groups(host)).toHaveLength(0);
  });

  test("missing calls from another category still break groups across hidden assistant messages", () => {
    for (const boundary of [call("task", "TaskList"), status("status"), browser("browser"), call("file", "read", { path: "file.ts" })]) {
      const { host, controller } = setup();
      for (const input of [web("a"), boundary, web("b")]) {
        const message = assistant([input]);
        controller.recordMessage(message); host.addMessageToChat(message);
        if (input !== boundary) tool(host, input);
      }
      expect(groups(host)).toHaveLength(0);
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
    expect(groups(live)).toHaveLength(2);
    installReadGrouping({ on() { return () => {}; } } as any);
    restored.chatContainer.clear(); renderItems.call(restored, items);
    expect(text(restored)).toContain("Web research · 2 fetches");
    expect(JSON.stringify(items)).toBe(saved);
  });
});
