import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type CodexRenderState,
  type RendererContext,
  activityStatus,
  getTextOutput,
  inlineText,
  renderActivityHeader,
  renderTreeOutput,
} from "./components.ts";
import { createWebToolRenderers } from "./web.ts";
import { TOOL_LABELS, toolArgumentSummary, toolLabel } from "./labels.ts";
import { codexBashRenderers } from "./renderers.ts";
import { createCodemodeRenderers } from "./codemode.ts";

interface AgentToolDetails {
  description?: string;
  subagentType?: string;
  toolUses?: number;
  tokens?: string;
  durationMs?: number;
  status?:
    | "queued"
    | "running"
    | "completed"
    | "steered"
    | "aborted"
    | "stopped"
    | "error"
    | "background";
  activity?: string;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

interface AgentCodexRenderState extends CodexRenderState {
  details?: AgentToolDetails;
  fallbackResult?: boolean;
}

/** Codex-style fallback for extension tools that provide no renderer at all. */
export function createGenericToolRenderers(toolName: string) {
  return {
    renderShell: "self" as const,

    renderCall(
      args: unknown,
      theme: Theme,
      context: RendererContext<CodexRenderState, unknown>,
    ) {
      const subject = theme.fg("accent", toolArgumentSummary(toolName, args));
      return renderActivityHeader(
        context.state,
        context.lastComponent,
        {
          status: activityStatus(context),
          label: toolLabel(toolName),
          subject,
        },
        theme,
      );
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RendererContext<CodexRenderState, unknown>,
    ) {
      return renderTreeOutput(context.lastComponent, {
        text: getTextOutput(result),
        expanded: options.expanded,
        direction: "head",
        previewRows: 3,
        tone: context.isError ? "error" : "output",
        theme,
      });
    },
  };
}

const BROWSER_TOOLS = new Set([
  "agent_browser", "agent_browser_code", "agent_browser_action",
  "agent_browser_qa", "agent_browser_electron", "agent_browser_source",
  "agent_browser_network_source", "agent_browser_tools",
]);

interface BrowserRenderState extends CodexRenderState {
  resultFailed?: boolean;
}

/** Presentation-only browser adapter; results and image payloads stay intact. */
export function createBrowserToolRenderers(toolName = "agent_browser") {
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: Theme, context: RendererContext<BrowserRenderState, unknown>) {
      return renderActivityHeader(context.state, context.lastComponent, {
        status: context.state.resultFailed ? "error" : activityStatus(context),
        label: toolLabel(toolName),
        subject: theme.fg("accent", toolArgumentSummary(toolName, args)),
      }, theme);
    },
    renderResult(
      result: AgentToolResult<unknown>, options: ToolRenderResultOptions,
      theme: Theme, context: RendererContext<BrowserRenderState, unknown>,
    ) {
      const details = result.details as { resultCategory?: string; summary?: unknown } | undefined;
      const nativeError = (result as AgentToolResult<unknown> & { isError?: boolean }).isError;
      const failed = context.isError || nativeError === true || details?.resultCategory === "failure";
      context.state.resultFailed = failed;
      // A completed browser action is not necessarily a verified page change.
      renderActivityHeader(context.state, context.state.callComponent, {
        status: failed ? "error" : options.isPartial ? "active" : "success",
        label: toolLabel(toolName),
        subject: theme.fg("accent", toolArgumentSummary(toolName, context.args)),
      }, theme);
      return renderTreeOutput(context.lastComponent, {
        text: getTextOutput(result) || (typeof details?.summary === "string" ? details.summary : ""),
        expanded: options.expanded, direction: "head", previewRows: 3,
        tone: failed ? "error" : "output", theme,
      });
    },
  };
}

function agentDescription(args: unknown, details?: AgentToolDetails): string {
  if (details?.description) return inlineText(details.description);
  if (!args || typeof args !== "object") return "agent";
  const description = (args as { description?: unknown }).description;
  const type = (args as { subagent_type?: unknown }).subagent_type;
  return inlineText(description) || inlineText(type) || "agent";
}

function agentStats(details: AgentToolDetails | undefined, theme: Theme): string {
  if (!details) return "";
  const parts: string[] = [];
  if (details.modelName) parts.push(inlineText(details.modelName));
  if (Array.isArray(details.tags)) {
    parts.push(...details.tags.map(inlineText).filter(Boolean));
  }
  if (details.turnCount !== undefined && details.turnCount > 0) {
    parts.push(
      details.maxTurns === undefined
        ? `↻${details.turnCount}`
        : `↻${details.turnCount}≤${details.maxTurns}`,
    );
  }
  if (details.toolUses !== undefined && details.toolUses > 0) {
    parts.push(
      `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`,
    );
  }
  if (details.tokens) parts.push(inlineText(details.tokens));
  if (
    details.status !== "running" &&
    details.durationMs !== undefined &&
    Number.isFinite(details.durationMs)
  ) {
    parts.push(`${(Math.max(0, details.durationMs) / 1_000).toFixed(1)}s`);
  }
  return parts.length > 0 ? theme.fg("muted", `(${parts.join(" · ")})`) : "";
}

function agentPresentation(
  state: AgentCodexRenderState,
  context: RendererContext<AgentCodexRenderState, unknown>,
): { status: "active" | "success" | "error"; statusText?: string } {
  const details = state.details;
  if (context.isError || details?.status === "error" || details?.status === "aborted") {
    return {
      status: "error",
      statusText: details?.status === "aborted" ? "Aborted" : "Failed",
    };
  }
  if (details?.status === "stopped") {
    return {
      status: "error",
      statusText: "Stopped",
    };
  }
  if (context.isPartial || details?.status === "running" || details?.status === "queued") {
    return {
      status: "active",
      statusText: details?.status === "queued" ? "queued" : undefined,
    };
  }
  if (details?.status === "background") {
    return {
      status: "success",
      statusText: "background",
    };
  }
  if (state.fallbackResult) {
    return {
      status: "success",
    };
  }
  return {
    status: "success",
    statusText: details?.status === "steered" ? "wrapped up" : undefined,
  };
}

function renderAgentHeader(
  theme: Theme,
  context: RendererContext<AgentCodexRenderState, unknown>,
) {
  const presentation = agentPresentation(context.state, context);
  return renderActivityHeader(
    context.state,
    context.state.callComponent ?? context.lastComponent,
    {
      ...presentation,
      label: toolLabel("Agent"),
      subject: theme.fg(
        "accent",
        [
          inlineText(context.state.details?.subagentType) || inlineText((context.args as { subagent_type?: unknown } | null)?.subagent_type),
          JSON.stringify(agentDescription(context.args, context.state.details)),
        ].filter(Boolean).join(", "),
      ),
      suffix: agentStats(context.state.details, theme),
    },
    theme,
  );
}

/** Codex-style adapter for pi-subagents' otherwise full-width Agent card. */
export function createAgentToolRenderers() {
  return {
    renderShell: "self" as const,

    renderCall(
      _args: unknown,
      theme: Theme,
      context: RendererContext<AgentCodexRenderState, unknown>,
    ) {
      return renderAgentHeader(theme, context);
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RendererContext<AgentCodexRenderState, unknown>,
    ) {
      const details = result.details as AgentToolDetails | undefined;
      context.state.details = details?.status ? details : undefined;
      context.state.fallbackResult = !details?.status;
      renderAgentHeader(theme, context);

      let text = getTextOutput(result);
      if (details?.status === "running" || details?.status === "queued") {
        text = inlineText(details.activity) || "thinking…";
      } else if (details?.status === "background" && !text && details.agentId) {
        text = `Running in background (ID: ${inlineText(details.agentId)})`;
      } else if (details?.status === "error" && !text && details.error) {
        text = inlineText(details.error);
      }

      return renderTreeOutput(context.lastComponent, {
        text,
        expanded: options.expanded,
        direction: "head",
        previewRows: 3,
        tone: context.isError || details?.status === "error" || details?.status === "aborted"
          ? "error"
          : "output",
        theme,
      });
    },
  };
}

const ALIAS_STATE = Symbol("tool-display-alias");

/** Keep rich result views and native call state while replacing only the header. */
function aliasHeader(toolName: string, existing: ToolRenderers): ToolRenderers {
  const alias = createGenericToolRenderers(toolName);
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state as Record<symbol, { header: CodexRenderState; nativeCall?: any }>;
      const view = state[ALIAS_STATE] ??= { header: {} };
      if (existing.renderCall) {
        view.nativeCall = existing.renderCall(args, theme, { ...context, lastComponent: view.nativeCall });
      }
      return alias.renderCall(args, theme, { ...context, state: view.header });
    },
    renderResult: existing.renderResult ?? alias.renderResult,
  };
}

/** Register presentation only, including fallback for not-yet-registered tools. */
export function installGenericToolRenderer(pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next) => {
    // Sandbox may bundle an older renderer. Resolve presentation here without
    // registering bash again or touching its sandbox-owned execution function.
    if (toolName === "bash") return codexBashRenderers as ToolRenderers;
    if (toolName === "codemode") return createCodemodeRenderers();

    const webRenderers = createWebToolRenderers(toolName);
    if (webRenderers) return webRenderers;

    if (BROWSER_TOOLS.has(toolName)) return createBrowserToolRenderers(toolName);

    // Execution-owned file renderers keep their specialized presentation.
    if (toolName === "Agent") return createAgentToolRenderers();

    const existing = next();
    if (existing && Object.hasOwn(TOOL_LABELS, toolName) && !["read", "grep", "find", "ls", "write", "edit", "bash", "apply_patch"].includes(toolName)) {
      return aliasHeader(toolName, existing);
    }
    if (existing?.renderCall || existing?.renderResult) return existing;
    return createGenericToolRenderers(toolName);
  });
}

