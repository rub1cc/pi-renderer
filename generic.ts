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

type AnyDefinition = ToolDefinition<any, any, any>;
type GetToolDefinition = (toolName: string) => AnyDefinition | undefined;

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

function addGenericRenderers(
  toolName: string,
  definition: AnyDefinition | undefined,
): AnyDefinition | undefined {
  if (!definition || definition.renderCall || definition.renderResult) {
    return definition;
  }

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

