import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import registerCodexRenderers from "../index.ts";
import { codexBashRenderers } from "../renderers.ts";
import registerSandbox from "../../sandbox/index.ts";

describe("renderer registration", () => {
  test("registers six non-bash definitions with self-rendered shells", () => {
    const tools: any[] = [];
    const handlers: Array<[string, unknown]> = [];
    const messageRenderers: string[] = [];
    registerCodexRenderers({
      on(name: string, handler: unknown) {
        handlers.push([name, handler]);
        return () => {};
      },
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerMessageRenderer(customType: string) {
        messageRenderers.push(customType);
      },
    } as unknown as ExtensionAPI);

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
    ]);
    expect(tools.some((tool) => tool.name === "bash")).toBe(false);
    expect(tools.some((tool) => tool.name === "apply_patch")).toBe(false);
    expect(handlers.some(([name]) => name === "input")).toBe(true);
    expect(messageRenderers).toEqual([
      "web-search-content-ready",
      "web-search-error",
    ]);
    for (const tool of tools) {
      expect(tool.renderShell).toBe("self");
      expect(tool.executionMode).toBe("sequential");
      expect(typeof tool.execute).toBe("function");
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  test("keeps sandbox as the owner of the rendered bash tool", () => {
    const tools: any[] = [];
    const handlers: Array<[string, unknown]> = [];
    registerSandbox({
      registerFlag() {},
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      on(name: string, handler: unknown) {
        handlers.push([name, handler]);
        return () => {};
      },
      registerCommand() {},
      getFlag() {
        return false;
      },
    } as unknown as ExtensionAPI);

    expect(tools).toHaveLength(1);
    const bash = tools[0];
    expect(bash.name).toBe("bash");
    expect(bash.label).toBe("bash (sandboxed)");
    expect(bash.renderShell).toBe("self");
    expect(bash.renderCall).toBe(codexBashRenderers.renderCall);
    expect(bash.renderResult).toBe(codexBashRenderers.renderResult);
    expect(bash.executionMode).toBe("sequential");
    expect(typeof bash.execute).toBe("function");
    expect(handlers.some(([name]) => name === "user_bash")).toBe(true);
  });

  test("adds generic presentation and adapts the Agent card", () => {
    const tools: any[] = [];
    registerCodexRenderers({
      on() {
        return () => {};
      },
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI);

    const taskDefinition = {
      name: "TaskList",
      label: "TaskList",
      description: "List tasks",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "No tasks" }] };
      },
    };
    const lookup = (InteractiveMode.prototype as any)
      .getRegisteredToolDefinition;
    const resolved = lookup.call(
      { session: { getToolDefinition: () => taskDefinition } },
      "TaskList",
    );
    expect(resolved.renderShell).toBe("self");
    expect(typeof resolved.renderCall).toBe("function");
    expect(typeof resolved.renderResult).toBe("function");
    expect(resolved.execute).toBe(taskDefinition.execute);

    const agentRenderCall = () => ({ render: () => [], invalidate() {} });
    const agentDefinition = {
      ...taskDefinition,
      name: "Agent",
      renderCall: agentRenderCall,
    };
    const adaptedAgent = lookup.call(
      { session: { getToolDefinition: () => agentDefinition } },
      "Agent",
    );
    expect(adaptedAgent.renderShell).toBe("self");
    expect(adaptedAgent.renderCall).not.toBe(agentRenderCall);
    expect(typeof adaptedAgent.renderResult).toBe("function");
    expect(adaptedAgent.execute).toBe(agentDefinition.execute);

    const searchRenderCall = () => ({ render: () => [], invalidate() {} });
    const searchDefinition = {
      ...taskDefinition,
      name: "web_search",
      label: "Web Search",
      renderCall: searchRenderCall,
    };
    const adaptedSearch = lookup.call(
      { session: { getToolDefinition: () => searchDefinition } },
      "web_search",
    );
    expect(adaptedSearch.renderShell).toBe("self");
    expect(adaptedSearch.renderCall).not.toBe(searchRenderCall);
    expect(typeof adaptedSearch.renderResult).toBe("function");
    expect(adaptedSearch.execute).toBe(searchDefinition.execute);

    const customRenderCall = () => ({ render: () => [], invalidate() {} });
    const alreadyRendered = { ...taskDefinition, name: "Custom", renderCall: customRenderCall };
    const untouched = lookup.call(
      { session: { getToolDefinition: () => alreadyRendered } },
      "Custom",
    );
    expect(untouched.renderCall).toBe(customRenderCall);
    expect(untouched.renderResult).toBeUndefined();
  });
});
