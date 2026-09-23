import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  type CodexRenderState,
  type RendererContext,
  activityStatus,
  getTextOutput,
  inlineText,
  renderActivityHeader,
  renderTreeOutput,
  sanitizeTerminalText,
} from "./components.ts";
import { createWebToolRenderers } from "./web.ts";

type AnyDefinition = ToolDefinition<any, any, any>;
type GetToolDefinition = (toolName: string) => AnyDefinition | undefined;

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

const PATCH_KEY = Symbol.for("pi.codex-tool-renderer.generic-fallback");
const wrappedDefinitions = new WeakMap<object, AnyDefinition>();

interface PatchedInteractiveModePrototype {
  getRegisteredToolDefinition: GetToolDefinition;
  [PATCH_KEY]?: {
    original: GetToolDefinition;
    wrapper: GetToolDefinition;
  };
}

function compactArguments(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return "";
  }
  if (!serialized || serialized === "{}") return "";

  const safe = sanitizeTerminalText(serialized).replace(/\s+/gu, " ");
  const limit = 160;
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
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
      const argumentText = compactArguments(args);
      const name = inlineText(toolName) || "tool";
      const subject = theme.fg(
        "accent",
        argumentText ? `${name}(${argumentText})` : name,
      );
      return renderActivityHeader(
        context.state,
        context.lastComponent,
        {
          status: activityStatus(context),
          activeVerb: "Calling",
          successVerb: "Called",
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
): { status: "active" | "success" | "error"; activeVerb: string; successVerb: string; errorVerb: string } {
  const details = state.details;
  if (context.isError || details?.status === "error" || details?.status === "aborted") {
    return {
      status: "error",
      activeVerb: "Running",
      successVerb: "Ran",
      errorVerb: details?.status === "aborted" ? "Aborted" : "Failed",
    };
  }
  if (details?.status === "stopped") {
    return {
      status: "error",
      activeVerb: "Running",
      successVerb: "Ran",
      errorVerb: "Stopped",
    };
  }
  if (context.isPartial || details?.status === "running" || details?.status === "queued") {
    return {
      status: "active",
      activeVerb: "Running",
      successVerb: "Ran",
      errorVerb: "Failed",
    };
  }
  if (details?.status === "background") {
    return {
      status: "success",
      activeVerb: "Starting",
      successVerb: "Started",
      errorVerb: "Failed",
    };
  }
  if (state.fallbackResult) {
    return {
      status: "success",
      activeVerb: "Calling",
      successVerb: "Called",
      errorVerb: "Failed",
    };
  }
  return {
    status: "success",
    activeVerb: "Running",
    successVerb: details?.status === "steered" ? "Wrapped up" : "Ran",
    errorVerb: "Failed",
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
      subject: theme.fg(
        "accent",
        agentDescription(context.args, context.state.details),
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

function addGenericRenderers(
  toolName: string,
  definition: AnyDefinition | undefined,
): AnyDefinition | undefined {
  if (!definition) {
    return definition;
  }

  const webRenderers = createWebToolRenderers(toolName, definition.label);
  if (webRenderers) {
    const cached = wrappedDefinitions.get(definition);
    if (cached) return cached;
    const wrapped = { ...definition, ...webRenderers };
    wrappedDefinitions.set(definition, wrapped);
    return wrapped;
  }

  // pi-subagents intentionally ships a Claude-style Agent card. It is the one
  // known custom renderer that conflicts with this extension's transcript
  // layout, so adapt it explicitly while leaving every other rich renderer
  // (notably apply_patch and SubagentWorkflow) intact.
  if (toolName === "Agent") {
    const cached = wrappedDefinitions.get(definition);
    if (cached) return cached;
    const wrapped = { ...definition, ...createAgentToolRenderers() };
    wrappedDefinitions.set(definition, wrapped);
    return wrapped;
  }

  if (definition.renderCall || definition.renderResult) return definition;

  const cached = wrappedDefinitions.get(definition);
  if (cached) return cached;

  const wrapped = {
    ...definition,
    ...createGenericToolRenderers(toolName),
  };
  wrappedDefinitions.set(definition, wrapped);
  return wrapped;
}

/**
 * Install a presentation-only fallback at Pi's final definition lookup.
 *
 * Pi currently exposes no renderer-only registration API. Re-registering a
 * third-party tool would replace its execute function, so the safe integration
 * point is InteractiveMode's definition lookup after every extension has
 * registered its own behavior. Existing renderers are returned unchanged.
 */
export function installGenericToolRenderer(): void {
  const prototype = InteractiveMode.prototype as unknown as PatchedInteractiveModePrototype;
  let patch = prototype[PATCH_KEY];
  if (!patch) {
    patch = {
      original: prototype.getRegisteredToolDefinition,
      wrapper: prototype.getRegisteredToolDefinition,
    };
    Object.defineProperty(prototype, PATCH_KEY, {
      configurable: false,
      enumerable: false,
      value: patch,
      writable: false,
    });
  }

  const original = patch.original;
  const wrapper: GetToolDefinition = function (
    this: unknown,
    toolName: string,
  ): AnyDefinition | undefined {
    return addGenericRenderers(toolName, original.call(this, toolName));
  };
  patch.wrapper = wrapper;
  prototype.getRegisteredToolDefinition = wrapper;
}

