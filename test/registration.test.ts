import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import registerCodexRenderers from "../index.ts";
import { codexBashRenderers } from "../renderers.ts";
import registerSandbox from "../../sandbox/index.ts";

describe("renderer registration", () => {
  test("registers six non-bash definitions with self-rendered shells", () => {
    const tools: any[] = [];
    registerCodexRenderers({
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as ExtensionAPI);

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
    for (const tool of tools) {
      expect(tool.renderShell).toBe("self");
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
    expect(tools[0].name).toBe("bash");
    expect(tools[0].label).toBe("bash (sandboxed)");
    expect(tools[0].renderShell).toBe("self");
    expect(tools[0].renderCall).toBe(codexBashRenderers.renderCall);
    expect(tools[0].renderResult).toBe(codexBashRenderers.renderResult);
    expect(typeof tools[0].execute).toBe("function");
    expect(handlers.some(([name]) => name === "user_bash")).toBe(true);
  });

  test("adds presentation to renderer-less extension tools only", () => {
    const tools: any[] = [];
    registerCodexRenderers({
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as ExtensionAPI);

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
