import { inlineText } from "./components.ts";

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "List",
  bash: "Bash",
  apply_patch: "Patch",
  write: "Write",
  edit: "Update",
  web_enable: "EnableWeb",
  web_search: "WebSearch",
  source_check: "CheckSources",
  fetch_content: "WebFetch",
  get_search_content: "WebContent",
  agent_browser: "Browser",
  agent_browser_code: "BrowserScript",
  agent_browser_tools: "BrowserTools",
  agent_browser_action: "BrowserAction",
  agent_browser_qa: "BrowserQA",
  agent_browser_electron: "BrowserElectron",
  agent_browser_source: "BrowserSource",
  agent_browser_network_source: "BrowserNetwork",
  Agent: "Agent",
  SubagentWorkflow: "Workflow",
  get_subagent_result: "AgentResult",
  steer_subagent: "SteerAgent",
  TaskCreate: "CreateTask",
  TaskList: "ListTasks",
  TaskGet: "GetTask",
  TaskUpdate: "UpdateTask",
  TaskExecute: "RunTasks",
  TaskOutput: "TaskOutput",
  TaskStop: "StopTask",
  ask_user_question: "AskUser",
  mcp: "MCP",
  parallel: "Parallel",
  "multi_tool_use.parallel": "Parallel",
};

export function toolLabel(name: string): string {
  return Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : inlineText(name) || "Tool";
}

function bounded(value: unknown, max = 120): string {
  const text = inlineText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function quoted(value: unknown): string {
  const text = bounded(value);
  return text ? JSON.stringify(text) : "";
}

function browserArguments(name: string, input: Record<string, unknown>): string {
  // Keep scripts, selectors, entered values and stdin out of transcript headers.
  if (name === "agent_browser_code") return "browser script";
  if (name === "agent_browser_tools" && Array.isArray(input.enable)) {
    const enabled = input.enable.filter((value): value is string => typeof value === "string" &&
      ["action", "qa", "electron", "source", "network"].includes(value));
    return enabled.length ? `enable: ${enabled.join(", ")}` : "";
  }
  if (name !== "agent_browser") return typeof input.action === "string" && /^[a-z-]+$/.test(input.action) ? input.action : "";
  if (!Array.isArray(input.args)) return "";
  const [command, ...rest] = input.args;
  if (typeof command !== "string" || !/^[a-z][a-z-]*$/.test(command)) return "";
  const safeFlags = new Set(["-i", "--interactive", "--json", "--full", "--labels", "--compact"]);
  const subcommands = command === "get" ? ["title", "url", "text", "html", "value", "count", "attr", "attribute"]
    : command === "is" ? ["visible", "enabled", "checked"] : [];
  const safe = rest.filter((value, index): value is string => typeof value === "string" &&
    (safeFlags.has(value) || /^@e\d+$/.test(value) || (index === 0 && subcommands.includes(value))));
  return [command, ...safe].join(" ");
}

/** Summarize known inputs without printing scripts, prompts, or full payloads. */
export function toolArgumentSummary(name: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const id = bounded(input.taskId ?? input.task_id ?? input.agent_id);
  const task = id ? `#${id.replace(/^#/, "")}` : "";
  switch (name) {
    case "agent_browser":
    case "agent_browser_code":
    case "agent_browser_tools":
    case "agent_browser_action":
    case "agent_browser_qa":
    case "agent_browser_electron":
    case "agent_browser_source":
    case "agent_browser_network_source": return browserArguments(name, input);
    case "web_enable":
    case "TaskList": return "";
    case "TaskCreate": return quoted(input.subject);
    case "TaskGet": return task;
    case "TaskUpdate": return [task, bounded(input.status)].filter(Boolean).join(", ");
    case "TaskExecute": return Array.isArray(input.task_ids)
      ? input.task_ids.slice(0, 8).map(value => `#${bounded(value, 24)}`).join(", ") + (input.task_ids.length > 8 ? ", …" : "") : "";
    case "TaskOutput":
    case "TaskStop": return bounded(input.task_id ?? input.shell_id);
    case "get_subagent_result": return id;
    case "steer_subagent": return [id, quoted(input.message)].filter(Boolean).join(", ");
    case "ask_user_question": {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = questions[0] as { question?: unknown } | undefined;
      return questions.length > 1 ? `${questions.length} questions` : quoted(first?.question);
    }
    case "SubagentWorkflow": {
      // The workflow name lives in literal meta, never in the ignored title field.
      const script = typeof input.script === "string" ? input.script : "";
      const meta = /^\s*export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}/.exec(script)?.[1];
      const literalName = meta && /(?:^|,)\s*name\s*:\s*(['"])([^'"\r\n]+)\1/.exec(meta)?.[2];
      return bounded(input.name ?? input.scriptPath ?? literalName ?? input.resumeFromRunId) || "workflow script";
    }
    case "parallel":
    case "multi_tool_use.parallel": return Array.isArray(input.tool_uses) ? `${input.tool_uses.length} tool calls` : "";
    case "mcp": {
      for (const key of ["action", "tool", "connect", "describe", "search", "instructions", "server"]) {
        const value = bounded(input[key]);
        if (value) return `${key}: ${value}`;
      }
      return "";
    }
    default: {
      try {
        const json = JSON.stringify(args);
        return json && json !== "{}" ? bounded(json, 160) : "";
      } catch {
        return "";
      }
    }
  }
}
