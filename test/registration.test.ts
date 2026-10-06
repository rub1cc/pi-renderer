import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { installGenericToolRenderer } from "../generic.ts";
import registerCodexRenderers from "../index.ts";

describe("renderer registration", () => {
  test("registers six non-bash definitions with self-rendered shells", () => {
    const tools: any[] = [];
    const handlers: Array<[string, unknown]> = [];
    const messageRenderers: string[] = [];
    const resolvers: ToolRendererResolver[] = [];
    registerCodexRenderers({
      on(name: string, handler: unknown) {
        handlers.push([name, handler]);
        return () => {};
      },
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerToolRenderer(resolver: ToolRendererResolver) {
        resolvers.push(resolver);
      },
      registerMessageRenderer(customType: string) {
        messageRenderers.push(customType);
      },
    } as unknown as ExtensionAPI);

    expect(resolvers).toHaveLength(1);
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
    expect(tools.find((tool) => tool.name === "edit").exposure).toBe("hidden");
    expect(tools.find((tool) => tool.name === "write").exposure).toBe("hidden");
    expect(tools.filter((tool) => !["edit", "write"].includes(tool.name)).every(
      (tool) => tool.exposure === "direct",
    )).toBe(true);
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

  function installResolver(): ToolRendererResolver {
    const resolvers: ToolRendererResolver[] = [];
    // No execution registration API: installation must be presentation-only.
    installGenericToolRenderer({
      registerToolRenderer(resolver: ToolRendererResolver) {
        resolvers.push(resolver);
      },
    } as ExtensionAPI);
    expect(resolvers).toHaveLength(1);
    return resolvers[0];
  }

  function expectPresentationOnly(renderers: ToolRenderers | undefined) {
    expect(renderers?.renderShell).toBe("self");
    expect(typeof renderers?.renderCall).toBe("function");
    expect(typeof renderers?.renderResult).toBe("function");
    expect(Object.keys(renderers!).sort()).toEqual([
      "renderCall", "renderResult", "renderShell",
    ]);
  }

  test("fills renderer-less and not-yet-registered tools through next", () => {
    const resolve = installResolver();
    for (const base of [undefined, {}, { renderShell: "default" as const }]) {
      let nextCalls = 0;
      const resolved = resolve("TaskList", () => {
        nextCalls++;
        return base;
      });
      expect(nextCalls).toBe(1);
      expectPresentationOnly(resolved);
    }
    expectPresentationOnly(resolve("mcp_server_unknown", () => undefined));
  });

  test("preserves rich renderers from registered tools or later resolvers", () => {
    const resolve = installResolver();
    const component = () => ({ render: () => [], invalidate() {} });
    for (const name of ["Custom", "apply_patch", "SubagentWorkflow", "bash", "read"]) {
      for (const existing of [
        { renderCall: component },
        { renderResult: component },
        { renderShell: "self" as const, renderCall: component, renderResult: component },
      ]) {
        let nextCalls = 0;
        expect(resolve(name, () => {
          nextCalls++;
          return existing;
        })).toBe(existing);
        expect(nextCalls).toBe(1);
      }
    }

    // A tool can become available after an earlier fallback resolution.
    expectPresentationOnly(resolve("LateTool", () => undefined));
    const laterResolver: ToolRendererResolver = () => ({ renderCall: component });
    const rich = laterResolver("LateTool", () => undefined);
    expect(resolve("LateTool", () => rich)).toBe(rich);
  });

  test("explicitly overrides Agent and all web cards without execution replacement", () => {
    const resolve = installResolver();
    const original = () => ({ render: () => [], invalidate() {} });
    for (const name of ["Agent", "web_search", "source_check", "fetch_content", "get_search_content"]) {
      const definition = Object.freeze({
        name,
        renderCall: original,
        renderResult: original,
        async execute() {
          return { content: [], details: undefined };
        },
      });
      const execute = definition.execute;
      const adapted = resolve(name, () => definition);
      expectPresentationOnly(adapted);
      expect(adapted?.renderCall).not.toBe(original);
      expect(adapted?.renderResult).not.toBe(original);
      expect(definition.execute).toBe(execute);
      expect(definition.renderCall).toBe(original);
      expect(definition.renderResult).toBe(original);
      expectPresentationOnly(resolve(name, () => undefined));
    }
  });
});
