import { inlineText } from "./components.ts";
import { toolArgumentSummary, toolLabel } from "./labels.ts";
import { webFailureText, webResultFailed } from "./web.ts";

export type ActivityGroupKind = "files" | "web" | "tasks" | "status" | "browser";
export const FILE_EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStrings(args: Record<string, any>, singular: string, plural: string): boolean {
  return nonempty(args[singular]) || (Array.isArray(args[plural]) &&
    args[plural].length > 0 && args[plural].every(nonempty));
}

/** Deliberately allowlist native inspections; scripts and batches are opaque. */
function isBrowserInspection(args: Record<string, any>): boolean {
  if (args.stdin || args.outputPath || args.sessionMode === "fresh" || !Array.isArray(args.args) ||
    !args.args.every((arg: unknown) => typeof arg === "string")) return false;
  const [command, ...rest] = args.args as string[];
  if (command === "snapshot") {
    const flags = new Set(["-i", "--interactive", "--json", "--full", "--labels", "--compact", "-c"]);
    for (let i = 0; i < rest.length; i++) {
      if (flags.has(rest[i])) continue;
      if (["-d", "--depth"].includes(rest[i]) && /^\d+$/.test(rest[i + 1] ?? "")) { i++; continue; }
      return false;
    }
    return true;
  }
  if (command === "get") {
    if (["title", "url"].includes(rest[0])) return rest.length === 1;
    if (["text", "html", "value", "count"].includes(rest[0])) return rest.length === 2 && nonempty(rest[1]);
    if (["attr", "attribute"].includes(rest[0])) return rest.length === 3 && rest.slice(1).every(nonempty);
  }
  return command === "is" && ["visible", "enabled", "checked"].includes(rest[0]) &&
    rest.length === 2 && nonempty(rest[1]);
}

export function activityGroupKind(name: string, value: unknown): ActivityGroupKind | undefined {
  const args = object(value);
  if (!args) return;
  if (FILE_EXPLORATION_TOOLS.has(name)) {
    if (name === "read") return nonempty(args.path) ? "files" : undefined;
    if (args.path !== undefined && typeof args.path !== "string") return;
    return name === "ls" || typeof args.pattern === "string" ? "files" : undefined;
  }
  if (name === "web_search") return hasStrings(args, "query", "queries") ? "web" : undefined;
  if (name === "source_check") return nonempty(args.claim) ? "web" : undefined;
  if (name === "fetch_content") return hasStrings(args, "url", "urls") ? "web" : undefined;
  if (name === "get_search_content") return nonempty(args.responseId) ? "web" : undefined;
  if (name === "TaskList") return "tasks";
  if (name === "TaskCreate") return nonempty(args.subject) ? "tasks" : undefined;
  if (name === "TaskGet") return nonempty(args.taskId) ? "tasks" : undefined;
  if (name === "TaskUpdate") return nonempty(args.taskId) && args.status !== "deleted" ? "tasks" : undefined;
  if (name === "get_subagent_result") return nonempty(args.agent_id) ? "status" : undefined;
  if (name === "TaskOutput") return nonempty(args.task_id) ? "status" : undefined;
  if (name === "agent_browser") return isBrowserInspection(args) ? "browser" : undefined;
}

function countSummary(members: any[], entries: Array<[string, string, string]>): string {
  return entries.flatMap(([name, singular, plural]) => {
    const count = members.filter(member => member.toolName === name).length;
    return count ? [`${count} ${count === 1 ? singular : plural}`] : [];
  }).join(", ");
}

/** Counts operations, not unique targets or successful side effects. */
export function activityGroupSummary(kind: Exclude<ActivityGroupKind, "files">, members: any[]): string {
  if (kind === "web") return `Web research · ${countSummary(members, [
    ["web_search", "search", "searches"], ["source_check", "source check", "source checks"],
    ["fetch_content", "fetch", "fetches"], ["get_search_content", "content read", "content reads"],
  ])}`;
  if (kind === "tasks") return `Task activity · ${countSummary(members, [
    ["TaskCreate", "creation", "creations"], ["TaskUpdate", "update", "updates"],
    ["TaskList", "list", "lists"], ["TaskGet", "lookup", "lookups"],
  ])}`;
  if (kind === "status") return `Status checks · ${countSummary(members, [
    ["get_subagent_result", "agent check", "agent checks"], ["TaskOutput", "task check", "task checks"],
  ])}`;
  const counts = ["snapshot", "get", "is"].flatMap(command => {
    const count = members.filter(member => member.args.args[0] === command).length;
    const noun = command === "snapshot" ? "snapshot" : command === "get" ? "read" : "state check";
    return count ? [`${count} ${noun}${count === 1 ? "" : "s"}`] : [];
  });
  return `Browser inspection · ${counts.join(", ")}`;
}

function concise(value: unknown): string {
  const text = inlineText(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function activityTarget(member: any): string {
  const { toolName: name, args } = member;
  let summary: string;
  if (name === "web_search") {
    summary = Array.isArray(args.queries) ? `${args.queries.length} queries` : JSON.stringify(concise(args.query));
  } else if (name === "source_check") summary = JSON.stringify(concise(args.claim));
  else if (name === "fetch_content") summary = Array.isArray(args.urls) ? `${args.urls.length} URLs` : concise(args.url);
  else if (name === "get_search_content") {
    const count = Array.isArray(args.findText) ? args.findText.length : args.findText ? 1 : 0;
    summary = count ? `${count} passage${count === 1 ? "" : "s"}` : concise(args.responseId);
  } else summary = toolArgumentSummary(name, args);
  return `${toolLabel(name)}(${summary})`;
}

export function activityFailed(member: any): boolean {
  const result = member.result;
  if (!result) return false;
  if (result.isError === true || webResultFailed(member.toolName, result, member.isPartial === true)) return true;
  const details = object(result.details);
  if (details?.error || details?.isError === true || details?.resultCategory === "failure" || details?.success === false) return true;
  if (["failed", "error", "aborted", "stopped"].includes(details?.status)) return true;
  // These tools also return background failures as successful text retrievals.
  if (member.toolName !== "TaskOutput" && member.toolName !== "get_subagent_result") return false;
  const text = result.content?.find((part: any) => part?.type === "text")?.text?.slice(0, 512) ?? "";
  if (member.toolName === "TaskOutput") {
    return /^Task #[^\r\n]*?(?:\((?:failed|error|aborted|stopped)\)|\[(?:failed|error|aborted|stopped)\]|exit code:\s*[1-9]\d*)/u.test(text);
  }
  return member.toolName === "get_subagent_result" &&
    /^Type: [^\r\n]*\| Status: (?:failed|error|aborted|stopped)\b/mu.test(text);
}

export function activityFailureText(member: any): string {
  const result = member.result;
  const details = object(result?.details);
  if (nonempty(details?.error)) return details.error;
  const webDiagnostic = webFailureText(member.toolName, result);
  if (webDiagnostic) return webDiagnostic;
  if (details?.resultCategory === "failure" && nonempty(details.summary)) return details.summary;
  const first = result?.content?.find((part: any) => part?.type === "text");
  return first?.text || (details?.status ? `Status: ${concise(details.status)}` : "Tool failed");
}
