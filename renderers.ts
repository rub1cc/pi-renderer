import type {
  AgentToolResult,
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  Theme,
  ToolRenderResultOptions,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  getLanguageFromPath,
  highlightCode,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import { type Component, MouseRegion } from "@earendil-works/pi-tui";
import {
  createDiffComponent,
  normalizeApplyPatchDetails,
  type DiffComponent,
} from "@rub1cc/pi-apply-patch/renderer";
import {
  type CodexRenderState,
  type RendererContext,
  activityStatus,
  asNumber,
  asString,
  countDiffLines,
  countLines,
  displayPath,
  formatCommandPreview,
  formatDuration,
  formatStats,
  getTextOutput,
  inlineText,
  renderActivityHeader,
  renderTreeOutput,
  sanitizeTerminalText,
} from "./components.ts";
import { toolLabel } from "./labels.ts";

type AnyResult = AgentToolResult<unknown>;

export interface RendererClock {
  now(): number;
  setInterval(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const systemClock: RendererClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle),
};

export interface BashCodexRenderState extends CodexRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  exitCode?: number;
}

interface EditCodexRenderState extends CodexRenderState {
  stats?: { added: number; removed: number };
  diffComponent?: DiffComponent;
  headerRegion?: MouseRegion;
}

function pathSubject(value: unknown, cwd: string, theme: Theme): string {
  return theme.fg("accent", displayPath(value, cwd));
}

function outputTone(context: { isError: boolean }): "error" | "output" {
  return context.isError ? "error" : "output";
}

function highlightSource(value: string, filePath: string): string {
  const normalized = sanitizeTerminalText(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ");
  const language = getLanguageFromPath(filePath);
  if (!language) return normalized;
  try {
    return highlightCode(normalized, language).join("\n");
  } catch {
    return normalized;
  }
}

function lineRange(args: Partial<ReadToolInput>, theme: Theme): string {
  const offset = asNumber(args.offset);
  const limit = asNumber(args.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit === undefined ? "" : start + limit - 1;
  return theme.fg("warning", `:${start}${end === "" ? "" : `-${end}`}`);
}

function grepSubject(args: Partial<GrepToolInput>, theme: Theme, cwd: string): string {
  const pattern = inlineText(args.pattern) || "…";
  const root = pathSubject(args.path || ".", cwd, theme);
  const glob = asString(args.glob);
  const globText = glob ? theme.fg("muted", ` (${glob})`) : "";
  return `${theme.fg("accent", `/${pattern}/`)}${theme.fg(
    "muted",
    " in ",
  )}${root}${globText}`;
}

function findSubject(args: Partial<FindToolInput>, theme: Theme, cwd: string): string {
  const pattern = inlineText(args.pattern) || "…";
  return `${theme.fg("accent", pattern)}${theme.fg(
    "muted",
    " in ",
  )}${pathSubject(args.path || ".", cwd, theme)}`;
}

function updateBashTiming(
  state: BashCodexRenderState,
  context: RendererContext<BashCodexRenderState, BashToolInput>,
  clock: RendererClock,
): void {
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = clock.now();
    state.endedAt = undefined;
  }

  if (context.executionStarted && context.isPartial && !state.interval) {
    state.interval = clock.setInterval(context.invalidate, 1_000);
    (state.interval as ReturnType<typeof setInterval> & {
      unref?: () => void;
    }).unref?.();
  }

  if (!context.isPartial || context.isError) {
    if (state.startedAt !== undefined) state.endedAt ??= clock.now();
    if (state.interval) {
      clock.clearInterval(state.interval);
      state.interval = undefined;
    }
  }
}

function bashDuration(
  state: BashCodexRenderState,
  theme: Theme,
  clock: RendererClock,
): string {
  if (state.startedAt === undefined) return "";
  const end = state.endedAt ?? clock.now();
  return theme.fg("muted", `(${formatDuration(end - state.startedAt)})`);
}

function renderBashHeader(
  args: BashToolInput,
  theme: Theme,
  context: RendererContext<BashCodexRenderState, BashToolInput>,
  clock: RendererClock,
  lastComponent: Component | undefined = context.lastComponent,
): Component {
  updateBashTiming(context.state, context, clock);
  const timeout = asNumber(args.timeout);
  const timeoutText = timeout === undefined
    ? ""
    : theme.fg("muted", `[timeout ${timeout}s]`);
  const duration = bashDuration(context.state, theme, clock);
  const suffix = [timeoutText, duration].filter(Boolean).join(" ");
  const errorVerb = context.state.exitCode === undefined
    ? "Failed"
    : `Failed (exit ${context.state.exitCode})`;

  return renderActivityHeader(
    context.state,
    lastComponent,
    {
      status: activityStatus(context),
      label: toolLabel("bash"),
      statusText: context.isError ? errorVerb : undefined,
      subject: theme.fg("accent", formatCommandPreview(args.command)),
      suffix,
    },
    theme,
  );
}

export function createCodexBashRenderers(clock: RendererClock = systemClock) {
  return {
    renderShell: "self" as const,

    renderCall(
      args: BashToolInput,
      theme: Theme,
      context: RendererContext<BashCodexRenderState, BashToolInput>,
    ) {
      return renderBashHeader(args, theme, context, clock);
    },

    renderResult(
      result: AgentToolResult<BashToolDetails | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RendererContext<BashCodexRenderState, BashToolInput>,
    ) {
      const output = getTextOutput(result as AnyResult);
      if (context.isError) {
        const match = /Command exited with code (\d+)/u.exec(output);
        context.state.exitCode = match ? Number(match[1]) : undefined;
      }
      renderBashHeader(
        context.args,
        theme,
        context,
        clock,
        context.state.callComponent,
      );
      return renderTreeOutput(context.lastComponent, {
        text: output,
        expanded: options.expanded,
        direction: "tail",
        previewRows: 3,
        tone: outputTone(context),
        theme,
      });
    },
  };
}

export const codexBashRenderers = createCodexBashRenderers();

export const readRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: ReadToolInput,
    theme: Theme,
    context: RendererContext<CodexRenderState, ReadToolInput>,
  ) {
    return renderActivityHeader(
      context.state,
      context.lastComponent,
      {
        status: activityStatus(context),
        label: toolLabel("read"),
        subject: `${pathSubject(args.path, context.cwd, theme)}${lineRange(
          args,
          theme,
        )}`,
      },
      theme,
    );
  },

  renderResult(
    result: AgentToolResult<ReadToolDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<CodexRenderState, ReadToolInput>,
  ) {
    const raw = getTextOutput(result as AnyResult);
    const show = context.isError || options.expanded;
    const text = show && !context.isError
      ? highlightSource(raw, asString(context.args.path))
      : show
        ? raw
        : "";
    return renderTreeOutput(context.lastComponent, {
      text,
      expanded: true,
      tone: context.isError ? "error" : "prestyled",
      theme,
    });
  },
};

export const grepRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: GrepToolInput,
    theme: Theme,
    context: RendererContext<CodexRenderState, GrepToolInput>,
  ) {
    return renderActivityHeader(
      context.state,
      context.lastComponent,
      {
        status: activityStatus(context),
        label: toolLabel("grep"),
        subject: grepSubject(args, theme, context.cwd),
      },
      theme,
    );
  },

  renderResult(
    result: AgentToolResult<GrepToolDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<CodexRenderState, GrepToolInput>,
  ) {
    return renderTreeOutput(context.lastComponent, {
      text: getTextOutput(result as AnyResult),
      expanded: options.expanded,
      direction: "head",
      previewRows: 3,
      tone: outputTone(context),
      theme,
    });
  },
};

export const findRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: FindToolInput,
    theme: Theme,
    context: RendererContext<CodexRenderState, FindToolInput>,
  ) {
    return renderActivityHeader(
      context.state,
      context.lastComponent,
      {
        status: activityStatus(context),
        label: toolLabel("find"),
        subject: findSubject(args, theme, context.cwd),
      },
      theme,
    );
  },

  renderResult(
    result: AgentToolResult<FindToolDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<CodexRenderState, FindToolInput>,
  ) {
    return renderTreeOutput(context.lastComponent, {
      text: getTextOutput(result as AnyResult),
      expanded: options.expanded,
      direction: "head",
      previewRows: 3,
      tone: outputTone(context),
      theme,
    });
  },
};

export const lsRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: LsToolInput,
    theme: Theme,
    context: RendererContext<CodexRenderState, LsToolInput>,
  ) {
    return renderActivityHeader(
      context.state,
      context.lastComponent,
      {
        status: activityStatus(context),
        label: toolLabel("ls"),
        subject: pathSubject(args.path || ".", context.cwd, theme),
      },
      theme,
    );
  },

  renderResult(
    result: AgentToolResult<LsToolDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<CodexRenderState, LsToolInput>,
  ) {
    return renderTreeOutput(context.lastComponent, {
      text: getTextOutput(result as AnyResult),
      expanded: options.expanded,
      direction: "head",
      previewRows: 3,
      tone: outputTone(context),
      theme,
    });
  },
};

export const writeRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: WriteToolInput,
    theme: Theme,
    context: RendererContext<CodexRenderState, WriteToolInput>,
  ) {
    const lines = countLines(asString(args.content));
    const lineText = theme.fg(
      "muted",
      `(${lines} line${lines === 1 ? "" : "s"})`,
    );
    return renderActivityHeader(
      context.state,
      context.lastComponent,
      {
        status: activityStatus(context),
        label: toolLabel("write"),
        subject: pathSubject(args.path, context.cwd, theme),
        suffix: lineText,
      },
      theme,
    );
  },

  renderResult(
    result: AgentToolResult<undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<CodexRenderState, WriteToolInput>,
  ) {
    const text = context.isError
      ? getTextOutput(result as AnyResult)
      : highlightSource(asString(context.args.content), asString(context.args.path));
    return renderTreeOutput(context.lastComponent, {
      text,
      expanded: options.expanded,
      direction: "head",
      previewRows: 3,
      tone: context.isError ? "error" : "prestyled",
      theme,
    });
  },
};

function editPath(args: EditToolInput): unknown {
  return (args as EditToolInput & { file_path?: string }).path ??
    (args as EditToolInput & { file_path?: string }).file_path;
}

function renderEditHeader(
  args: EditToolInput,
  theme: Theme,
  context: RendererContext<EditCodexRenderState, EditToolInput>,
  lastComponent: Component | undefined = context.lastComponent,
): Component {
  const edits = Array.isArray(args.edits) ? args.edits.length : 0;
  const pendingSuffix = edits > 1
    ? theme.fg("muted", `(${edits} replacements)`)
    : "";
  const suffix = context.state.stats
    ? formatStats(context.state.stats.added, context.state.stats.removed, theme)
    : pendingSuffix;
  return renderActivityHeader(
    context.state,
    lastComponent,
    {
      status: activityStatus(context),
      label: toolLabel("edit"),
      subject: pathSubject(editPath(args), context.cwd, theme),
      suffix,
    },
    theme,
  );
}

export const editRenderers = {
  renderShell: "self" as const,

  renderCall(
    args: EditToolInput,
    theme: Theme,
    context: RendererContext<EditCodexRenderState, EditToolInput>,
  ) {
    const header = renderEditHeader(args, theme, context);
    return context.state.headerRegion ??= new MouseRegion(header, (event) => {
      if (event.type !== "click" || event.button !== "left" || !context.state.diffComponent) return;
      context.state.diffComponent.toggleExpanded();
      return { handled: true };
    });
  },

  renderResult(
    result: AgentToolResult<EditToolDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RendererContext<EditCodexRenderState, EditToolInput>,
  ) {
    const diff = context.isError ? "" : asString(result.details?.diff);
    const details = diff ? normalizeApplyPatchDetails({
      changes: [{
        type: "update",
        path: displayPath(editPath(context.args), context.cwd),
        diff: sanitizeTerminalText(diff),
      }],
    }) : undefined;
    if (diff) {
      context.state.stats = details?.stats ?? countDiffLines(diff);
      renderEditHeader(
        context.args,
        theme,
        context,
        context.state.callComponent,
      );
    }
    if (details) {
      const component = createDiffComponent({
        details,
        expanded: options.expanded,
        showHeader: false,
        theme,
        onToggle: context.invalidate,
      }, context.state.diffComponent ?? context.lastComponent);
      context.state.diffComponent = component;
      return component;
    }

    context.state.diffComponent = undefined;

    // Preserve readable output for errors or an unrecognized persisted format.
    const text = context.isError
      ? getTextOutput(result as AnyResult)
      : diff
        ? renderDiff(diff, { filePath: asString(editPath(context.args)) })
        : "";
    return renderTreeOutput(context.lastComponent, {
      text,
      expanded: options.expanded,
      direction: "head",
      previewRows: context.isError ? 3 : 24,
      showCollapseHint: !context.isError,
      tone: context.isError ? "error" : "prestyled",
      theme,
    });
  },
};
