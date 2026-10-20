import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { installGenericToolRenderer } from "../generic.ts";
import registerCodexRenderers from "../index.ts";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { codexBashRenderers } from "../renderers.ts";

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
    for (const name of ["Custom", "apply_patch", "read"]) {
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

  test("overrides stale bundled Bash presentation without replacing sandbox execution", () => {
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
    const legacyCall = () => new Text("• Ran echo ok", 0, 0);
    const execute = async () => ({ content: [], details: undefined });
    const sandboxTool = Object.freeze({ name: "bash", label: "bash (sandboxed)",
      parameters: { type: "object" }, executionMode: "sequential", execute,
      renderCall: legacyCall, renderResult: () => new Text("Legacy output", 0, 0) });
    for (let reload = 0; reload < 2; reload++) {
      const resolve = installResolver();
      const presentation = resolve("bash", () => sandboxTool)!;
      expectPresentationOnly(presentation);
      expect(presentation).toBe(codexBashRenderers);
      const resolved = { ...sandboxTool, ...presentation };
      expect(resolved.execute).toBe(execute);
      expect(resolved.parameters).toBe(sandboxTool.parameters);
      expect(resolved.executionMode).toBe("sequential");
      expect(sandboxTool.renderCall).toBe(legacyCall);
      const args = { command: "echo ok" };
      const ctx = { args, state: {}, isPartial: false, isError: false, executionStarted: false } as any;
      const call = resolved.renderCall!(args, theme, ctx);
      const rows = call.render(80).map(stripTerminalSequences);
      expect(rows[0]).toStartWith("• Bash(echo ok)");
      expect(rows.join("\n")).not.toContain("Ran ");
      expectPresentationOnly(resolve("bash", () => undefined));
    }
  });

  test("aliases known rich-tool headers without replacing result views or native state", () => {
    const resolve = installResolver();
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
    for (const name of ["SubagentWorkflow", "TaskUpdate", "mcp", "ask_user_question"]) {
      let nativeCalls = 0;
      const native = new Text("Original", 0, 0);
      const resultView = new Text("Rich result", 0, 0);
      const existing = {
        renderCall(_args: any, _theme: any, ctx: any) {
          expect(ctx.lastComponent).toBe(nativeCalls ? native : undefined);
          ctx.state.callComponent = native;
          nativeCalls++;
          return native;
        },
        renderResult(_result: any, _options: any, _theme: any, ctx: any) {
          expect(ctx.state.callComponent).toBe(native);
          return resultView;
        },
      };
      const adapted = resolve(name, () => existing)!;
      expectPresentationOnly(adapted);
      expect(adapted.renderResult).toBe(existing.renderResult);
      const args = name === "SubagentWorkflow" ? { name: "review" } : {};
      const ctx = { state: {}, args, isPartial: true, isError: false } as any;
      const header = adapted.renderCall!(args, theme, ctx);
      expect(header).not.toBe(native);
      const title = header.render(80).map(stripTerminalSequences).join("\n");
      expect(title).toStartWith("• ");
      expect(title).not.toMatch(/^[●⏺]/u);
      if (name === "SubagentWorkflow") expect(title).toContain("Workflow(review)");
      expect(adapted.renderCall!(args, theme, { ...ctx, lastComponent: header })).toBe(header);
      expect(nativeCalls).toBe(2);
      expect(adapted.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme, ctx)).toBe(resultView);
    }
  });

  test("explicitly overrides Agent, browser and web cards without execution replacement", () => {
    const resolve = installResolver();
    const original = () => ({ render: () => [], invalidate() {} });
    for (const name of ["Agent", "codemode", "agent_browser", "agent_browser_code", "agent_browser_action",
      "agent_browser_qa", "agent_browser_electron", "agent_browser_source",
      "agent_browser_network_source", "agent_browser_tools",
      "web_search", "source_check", "fetch_content", "get_search_content"]) {
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
