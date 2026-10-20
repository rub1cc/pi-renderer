import {
  highlightCode,
  type AgentToolResult,
  type CodemodeToolDetails,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  activityMarker,
  activityStatus,
  asNumber,
  displayPath,
  formatDuration,
  getTextOutput,
  inlineText,
  renderTreeOutput,
  sanitizeTerminalText,
  type ActivityStatus,
  type RendererContext,
} from "./components.ts";
import { TOOL_LABELS, toolArgumentSummary, toolLabel } from "./labels.ts";

type NestedCall = CodemodeToolDetails["calls"][number];
interface Snapshot {
  calls: NestedCall[];
  failed: boolean;
  partial: boolean;
  durationMs?: number;
  images: number;
}
interface CodemodeState {
  header?: CodemodeHeader;
  snapshot?: Snapshot;
}
type Context = RendererContext<CodemodeState, unknown> & { durationMs?: number };
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;
const SEPARATOR = " \u00b7 ";

/** Keep the summary on one visual row, even for mixed or unknown tool names. */
class CodemodeHeader implements Component {
  private text = "";
  setText(text: string): void { this.text = text; }
  render(width: number): string[] {
    return width < 1 ? [] : [truncateToWidth(this.text, width, "\u2026")];
  }
  invalidate(): void {}
}

function callsOf(details: unknown): NestedCall[] {
  const calls = (details as Partial<CodemodeToolDetails> | undefined)?.calls;
  return Array.isArray(calls) ? calls.flatMap(call => {
    if (!call || typeof call.name !== "string" ||
      !["running", "ok", "error", "cancelled"].includes(call.status)) return [];
    return [{
      id: typeof call.id === "string" ? call.id : "",
      name: call.name,
      status: call.status,
      args: typeof call.args === "string" ? call.args : "",
      error: typeof call.error === "string" ? call.error : undefined,
      durationMs: asNumber(call.durationMs),
      cost: asNumber(call.cost),
    }];
  }) : [];
}

function callSummary(calls: NestedCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = toolLabel(call.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${count} ${name} call${count === 1 ? "" : "s"}`).join(", ");
}

function renderHeader(theme: Theme, context: Context): CodemodeHeader {
  const header = context.state.header ??= new CodemodeHeader();
  const snapshot = context.state.snapshot;
  let status: ActivityStatus = activityStatus(context);
  const parts: string[] = [];
  if (snapshot) {
    const errors = snapshot.calls.filter(call => call.status === "error").length;
    const cancelled = snapshot.calls.filter(call => call.status === "cancelled").length;
    const running = snapshot.calls.filter(call => call.status === "running").length;
    status = snapshot.failed || errors || cancelled ? "error" : snapshot.partial ? "active" : "success";
    if (snapshot.failed) parts.push("script failed");
    if (errors) parts.push(`${errors} nested call${errors === 1 ? "" : "s"} failed`);
    if (cancelled) parts.push(`${cancelled} nested call${cancelled === 1 ? "" : "s"} cancelled`);
    if (snapshot.calls.length) parts.push(callSummary(snapshot.calls));
    if (snapshot.partial) parts.push(running ? `${running} running` : "running\u2026");
    if (snapshot.images) parts.push(`${snapshot.images} image${snapshot.images === 1 ? "" : "s"}`);
    if (!snapshot.partial && snapshot.durationMs !== undefined) parts.push(formatDuration(snapshot.durationMs));
    if (!parts.length) parts.push(snapshot.partial ? "running\u2026" : "script completed");
  } else {
    parts.push(({ preparing: "preparing\u2026", queued: "waiting\u2026", active: "running\u2026",
      success: "script completed", error: "script failed" })[status]);
  }
  const color = status === "error" ? "error" : status === "success" ? "toolTitle" : "accent";
  header.setText(`${activityMarker(status, theme)} ${theme.fg(color, theme.bold("Codemode"))}` +
    theme.fg(status === "error" ? "error" : "muted", SEPARATOR + parts.join(SEPARATOR)));
  return header;
}

function target(call: NestedCall, cwd: string): string {
  let summary = "";
  try {
    // Pi's argument preview is bounded JSON, not JavaScript source. Truncated
    // previews are deliberately left opaque rather than guessed from the script.
    const args = JSON.parse(call.args);
    if (args && typeof args === "object" && !Array.isArray(args)) {
      if (call.name === "bash") summary = inlineText(args.command);
      else if (["read", "ls"].includes(call.name)) summary = displayPath(args.path ?? ".", cwd);
      else if (["grep", "find"].includes(call.name)) summary = inlineText(args.pattern);
      else if (Object.hasOwn(TOOL_LABELS, call.name)) summary = toolArgumentSummary(call.name, args);
    }
  } catch { /* Arguments may be truncated or unavailable on older results. */ }
  return toolLabel(call.name) + (summary ? `: ${summary}` : "");
}

function expandedCalls(calls: NestedCall[]): string {
  return calls.map(call => {
    const duration = asNumber(call.durationMs);
    const cost = asNumber(call.cost);
    const stats = [duration === undefined ? "" : formatDuration(duration),
      cost === undefined ? "" : `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`].filter(Boolean);
    return `${toolLabel(call.name)} (${call.status}) ${typeof call.args === "string" ? call.args : ""}` +
      (stats.length ? SEPARATOR + stats.join(SEPARATOR) : "") +
      (call.error ? `\n  ${call.error}` : "");
  }).join("\n");
}

function imageLabels(result: AgentToolResult<unknown>): string[] {
  return result.content.flatMap((block, index) => {
    if (block.type !== "image") return [];
    const previous = result.content[index - 1];
    const label = previous?.type === "text" ? previous.text.trimEnd().split("\n").at(-1) : undefined;
    return [label && /^\[Image (?:saved to |\().*\]$/.test(label)
      ? label : `[Image: ${block.mimeType}]`];
  });
}

/** Presentation only: Pi still owns execution, nested calls, images and clicks. */
export function createCodemodeRenderers() {
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: Theme, context: Context) {
      const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
      container.clear();
      container.addChild(renderHeader(theme, context));
      if (context.expanded) {
        const code = (args as { code?: unknown } | null)?.code;
        const source = typeof code === "string" ? sanitizeTerminalText(code).replace(/\t/g, "    ") : "[invalid script]";
        container.addChild(renderTreeOutput(undefined, {
          text: highlightCode(source, "javascript").join("\n"),
          expanded: true, tone: "prestyled", theme,
        }));
      }
      return container;
    },
    renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: Context) {
      const first = result.content[0];
      const header = first?.type === "text" ? SCRIPT_HEADER.exec(first.text) : null;
      const calls = callsOf(result.details);
      const failed = context.isError || (result as { isError?: boolean }).isError === true || header?.[1] === "failed";
      const duration = asNumber(context.durationMs) ?? (header ? asNumber(Number(header[2]) * 1000) : undefined);
      context.state.snapshot = {
        calls, failed, partial: options.isPartial, durationMs: duration,
        images: result.content.filter(block => block.type === "image").length,
      };
      renderHeader(theme, context);

      const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
      container.clear();
      const output = getTextOutput({ ...result, content: header ? result.content.slice(1) : result.content });
      const add = (text: string, error = false, expanded = options.expanded) => {
        if (text) container.addChild(renderTreeOutput(undefined, {
          text, expanded, previewRows: 3, tone: error ? "error" : "output", theme,
        }));
      };
      if (options.expanded) {
        if (calls.length) add(`Nested calls\n${expandedCalls(calls)}`);
        if (output) add(`Output\n${output}`, failed);
      } else {
        if (failed) {
          // Script output may itself contain this marker; Pi appends its final
          // diagnostic after that output, so prefer the trailing marker.
          const errorStart = output.lastIndexOf("\nScript error:\n");
          add(errorStart >= 0 ? output.slice(errorStart + 1) : output || "Script failed", true);
        }
        const error = calls.find(call => call.status === "error") ?? calls.find(call => call.status === "cancelled");
        if (error) add(`${toolLabel(error.name)}: ${error.error || `Nested call ${error.status === "error" ? "failed" : "cancelled"}`}`, true);
        if (options.isPartial) {
          const running = calls.findLast(call => call.status === "running");
          if (running) add(target(running, context.cwd));
        }
        for (const label of imageLabels(result)) add(label, false, true);
      }
      const fullOutputPath = (result.details as Partial<CodemodeToolDetails> | undefined)?.fullOutputPath;
      if (typeof fullOutputPath === "string" && fullOutputPath) add(`Full output: ${fullOutputPath}`, false, true);
      return container;
    },
  };
}
