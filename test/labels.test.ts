import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderActivityHeader } from "../components.ts";
import { TOOL_LABELS, toolArgumentSummary, toolLabel } from "../labels.ts";
import { createAgentToolRenderers, createGenericToolRenderers } from "../generic.ts";
import { createWebToolRenderers } from "../web.ts";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function context(args: unknown, overrides = {}) {
  return { args, state: {}, cwd: "/repo", executionStarted: true, isPartial: false,
    isError: false, lastComponent: undefined, ...overrides } as any;
}

describe("tool display aliases", () => {
  test("covers the agreed labels without changing tool names or inputs", () => {
    const cases: Array<[string, unknown, string]> = [
      ["web_enable", {}, "EnableWeb()"],
      ["SubagentWorkflow", { name: "review" }, "Workflow(review)"],
      ["get_subagent_result", { agent_id: "agent-1" }, "AgentResult(agent-1)"],
      ["steer_subagent", { agent_id: "agent-1", message: "Focus on headers" }, 'SteerAgent(agent-1, "Focus on headers")'],
      ["TaskCreate", { subject: "Compare renderers" }, 'CreateTask("Compare renderers")'],
      ["TaskList", {}, "ListTasks()"],
      ["TaskGet", { taskId: "7" }, "GetTask(#7)"],
      ["TaskUpdate", { taskId: "7", status: "completed" }, "UpdateTask(#7, completed)"],
      ["TaskExecute", { task_ids: ["7", "8"] }, "RunTasks(#7, #8)"],
      ["TaskOutput", { task_id: "run-1" }, "TaskOutput(run-1)"],
      ["TaskStop", { task_id: "run-1" }, "StopTask(run-1)"],
      ["ask_user_question", { questions: [{ question: "Which style?" }] }, 'AskUser("Which style?")'],
      ["mcp", { search: "pull requests" }, "MCP(search: pull requests)"],
      ["parallel", { tool_uses: [{}, {}] }, "Parallel(2 tool calls)"],
      ["multi_tool_use.parallel", { tool_uses: [{}, {}] }, "Parallel(2 tool calls)"],
    ];
    for (const [name, args, expected] of cases) {
      const saved = JSON.stringify(args);
      const component = createGenericToolRenderers(name).renderCall(args, theme, context(args));
      const rows = component.render(200).map(stripTerminalSequences);
      expect(rows[0].trimEnd()).toBe(`• ${expected}`);
      expect(JSON.stringify(args)).toBe(saved);
    }
    expect(TOOL_LABELS.read).toBe("Read");
    expect(TOOL_LABELS.grep).toBe("Grep");
    expect(TOOL_LABELS.find).toBe("Glob");
    expect(TOOL_LABELS.ls).toBe("List");
    expect(TOOL_LABELS.bash).toBe("Bash");
    expect(TOOL_LABELS.apply_patch).toBe("Patch");
  });

  test("uses safe summaries for workflow scripts, MCP payloads and question forms", () => {
    expect(toolArgumentSummary("SubagentWorkflow", {
      script: "export const meta = { name: 'review', description: 'Review' }; PRIVATE_SCRIPT()",
      title: "IGNORED_TITLE",
    })).toBe("review");
    expect(toolArgumentSummary("SubagentWorkflow", { script: "PRIVATE_SCRIPT()", title: "IGNORED_TITLE" })).toBe("workflow script");
    expect(toolArgumentSummary("mcp", { tool: "search", args: { token: "PRIVATE_TOKEN" } })).toBe("tool: search");
    expect(toolArgumentSummary("ask_user_question", {
      questions: [{ question: "First", options: ["PRIVATE_OPTION"] }, { question: "Second" }],
    })).toBe("2 questions");
  });

  test("sanitizes unknown labels and bounds fallback arguments", () => {
    expect(toolLabel("unsafe\u001b[31m_tool\n")).toBe("unsafe_tool");
    expect(toolLabel("constructor")).toBe("constructor");
    expect(toolLabel("__proto__")).toBe("__proto__");
    expect(toolArgumentSummary("Unknown", { content: "x".repeat(500) }).length).toBeLessThanOrEqual(160);
    const circular: any = {};
    circular.self = circular;
    expect(toolArgumentSummary("Unknown", circular)).toBe("");
    expect(toolArgumentSummary("TaskExecute", { task_ids: Array.from({ length: 30 }, (_, i) => String(i)) })).toEndWith(", …");
  });

  test("keeps small dots, aliased labels and explicit running, failed and background states", () => {
    for (const [status, suffix] of [["active", "running…"], ["error", "Failed"], ["success", ""]] as const) {
      const header = renderActivityHeader({}, undefined, { status, label: "Read", subject: "file.ts" }, theme);
      const text = header.render(80).map(stripTerminalSequences).join("\n");
      expect(text).toStartWith("• Read(file.ts)");
      if (suffix) expect(text).toContain(suffix);
      expect(text).not.toMatch(/^[●⏺]/u);
      for (const width of [1, 2, 8, 20]) {
        expect(header.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
      }
    }
    const args = { subagent_type: "Explore", description: "Find files" };
    const adapter = createAgentToolRenderers();
    const ctx = context(args);
    const header = adapter.renderCall(args, theme, ctx);
    adapter.renderResult({ content: [], details: { status: "background", agentId: "agent-1" } },
      { expanded: false, isPartial: false }, theme, ctx);
    expect(header.render(100).map(stripTerminalSequences).join("\n")).toContain('Agent(Explore, "Find files") · background');
  });

  test("web content stays visibly distinct from file reads and reports tool-level failures", () => {
    const args = { findText: ["one", "two", "three", "four", "five"] };
    const adapter = createWebToolRenderers("get_search_content")!;
    const ctx = context(args);
    const call = adapter.renderCall(args, theme, ctx);
    expect(call.render(100).map(stripTerminalSequences).join("\n")).toContain("WebContent(5 passages)");
    adapter.renderResult({ content: [], details: { error: "Not found" } }, { expanded: false, isPartial: false }, theme, ctx);
    expect(call.render(100).map(stripTerminalSequences).join("\n")).toContain("· Failed");
  });
});
