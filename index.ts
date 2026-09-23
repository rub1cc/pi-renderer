import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  editRenderers,
  findRenderers,
  grepRenderers,
  lsRenderers,
  readRenderers,
  writeRenderers,
} from "./renderers.ts";
import { installGenericToolRenderer } from "./generic.ts";

type AnyDefinition = ToolDefinition<any, any, any>;
type DefinitionFactory = (cwd: string) => AnyDefinition;
type RendererOverride = Pick<
  AnyDefinition,
  "renderShell" | "renderCall" | "renderResult"
>;

const definitionCache = new WeakMap<
  DefinitionFactory,
  Map<string, AnyDefinition>
>();

function getDefinition(
  factory: DefinitionFactory,
  cwd: string,
): AnyDefinition {
  let byCwd = definitionCache.get(factory);
  if (!byCwd) {
    byCwd = new Map();
    definitionCache.set(factory, byCwd);
  }

  let definition = byCwd.get(cwd);
  if (!definition) {
    definition = factory(cwd);
    byCwd.set(cwd, definition);
  }
  return definition;
}

function registerRenderedTool(
  pi: ExtensionAPI,
  factory: DefinitionFactory,
  renderers: RendererOverride,
): void {
  const initial = getDefinition(factory, process.cwd());
  pi.registerTool({
    ...initial,
    ...renderers,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const definition = getDefinition(factory, context.cwd);
      return definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        context,
      );
    },
  });
}

/** Register Codex-style presentation without changing built-in behavior. */
export function registerCodexRenderers(pi: ExtensionAPI): void {
  installGenericToolRenderer();
  registerRenderedTool(pi, createReadToolDefinition, readRenderers);
  registerRenderedTool(pi, createGrepToolDefinition, grepRenderers);
  registerRenderedTool(pi, createFindToolDefinition, findRenderers);
  registerRenderedTool(pi, createLsToolDefinition, lsRenderers);
  registerRenderedTool(pi, createWriteToolDefinition, writeRenderers);
  registerRenderedTool(pi, createEditToolDefinition, editRenderers);

  // Bash is intentionally not registered here. The sibling sandbox extension
  // owns bash execution and composes codexBashRenderers into that definition.
  // Registering a second bash tool could bypass the sandbox because Pi uses the
  // first extension registration for a duplicate tool name.
}

export default registerCodexRenderers;

export {
  codexBashRenderers,
  createCodexBashRenderers,
} from "./renderers.ts";
export {
  createGenericToolRenderers,
  installGenericToolRenderer,
} from "./generic.ts";

