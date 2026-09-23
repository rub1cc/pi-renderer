import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentToolResult,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  type Component,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type ActivityStatus = "active" | "success" | "error";

export interface CodexRenderState {
  callComponent?: Text;
}

/**
 * Structural subset of Pi's tool render context. Pi 0.87 does not export the
 * ToolRenderContext type from its package root, so the renderer keeps this
 * small public-compatible shape instead of deep-importing a private module.
 */
export interface RendererContext<TState, TArgs> {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

export function activityStatus(
  context: Pick<RendererContext<unknown, unknown>, "isError" | "isPartial">,
): ActivityStatus {
  if (context.isError) return "error";
  return context.isPartial ? "active" : "success";
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function sanitizeTerminalText(value: string): string {
  return stripTerminalSequences(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
    "",
  );
}

export function inlineText(value: unknown): string {
  return sanitizeTerminalText(asString(value))
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
}

export function displayPath(value: unknown, cwd: string): string {
  const raw = inlineText(value);
  if (!raw) return "…";
  if (!path.isAbsolute(raw)) return raw;

  const relative = path.relative(cwd, raw);
  if (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }

  const home = homedir();
  if (raw === home) return "~";
  if (raw.startsWith(`${home}${path.sep}`)) return `~${raw.slice(home.length)}`;
  return raw;
}

export function countLines(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const count = normalized.split("\n").length;
  return normalized.endsWith("\n") ? Math.max(0, count - 1) : count;
}

export function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 1_000) return `${Math.round(safeMilliseconds)}ms`;

  const seconds = safeMilliseconds / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m ${String(
    remainingSeconds,
  ).padStart(2, "0")}s`;
}

export function formatCommandPreview(value: unknown): string {
  const command = stripTerminalSequences(asString(value))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!command) return "…";

  const lines = command.split("\n");
  const visible = lines.slice(0, 3);
  if (lines.length > visible.length) visible.push("…");
  return visible.join("\n  ");
}

export function getTextOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => ("text" in item ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function countDiffLines(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function formatStats(
  added: number,
  removed: number,
  theme: Theme,
): string {
  return [
    theme.fg("muted", "("),
    theme.fg("toolDiffAdded", `+${added}`),
    theme.fg("muted", " "),
    theme.fg("toolDiffRemoved", `-${removed}`),
    theme.fg("muted", ")"),
  ].join("");
}

export interface ActivityHeaderOptions {
  status: ActivityStatus;
  activeVerb: string;
  successVerb: string;
  errorVerb?: string;
  subject?: string;
  suffix?: string;
}

export function renderActivityHeader<TState extends CodexRenderState>(
  state: TState,
  lastComponent: Component | undefined,
  options: ActivityHeaderOptions,
  theme: Theme,
): Text {
  const component =
    lastComponent instanceof Text
      ? lastComponent
      : state.callComponent ?? new Text("", 0, 0);
  state.callComponent = component;

  const marker = theme.fg(
    options.status === "error"
      ? "error"
      : options.status === "success"
        ? "success"
        : "accent",
    "•",
  );
  const verb =
    options.status === "error"
      ? options.errorVerb ?? "Failed"
      : options.status === "success"
        ? options.successVerb
        : options.activeVerb;
  const verbColor = options.status === "error" ? "error" : "toolTitle";
  const subject = options.subject ? ` ${options.subject}` : "";
  const suffix = options.suffix ? ` ${options.suffix}` : "";

  component.setText(
    `${marker} ${theme.fg(verbColor, theme.bold(verb))}${subject}${suffix}`,
  );
  return component;
}

export type PreviewDirection = "head" | "tail";
export type TreeTone = "output" | "error" | "warning" | "prestyled";

export interface TreeOutputOptions {
  text: string;
  expanded: boolean;
  theme: Theme;
  direction?: PreviewDirection;
  previewRows?: number;
  tone?: TreeTone;
}

function normalizePlainOutput(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ");
}

function sourceLines(value: string): string[] {
  const lines = value.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export class TreeOutputComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private options: TreeOutputOptions) {}

  setOptions(options: TreeOutputOptions): this {
    this.options = options;
    this.invalidate();
    return this;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.cachedWidth === safeWidth && this.cachedLines) {
      return this.cachedLines;
    }

    const {
      expanded,
      theme,
      direction = "head",
      previewRows = 3,
      tone = "output",
    } = this.options;
    const plain = tone === "prestyled"
      ? this.options.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      : normalizePlainOutput(this.options.text);
    if (!plain) {
      this.cachedWidth = safeWidth;
      this.cachedLines = [];
      return this.cachedLines;
    }

    const fullPrefix = safeWidth >= 6 ? "  └ " : safeWidth >= 3 ? "└ " : "";
    const continuationPrefix = " ".repeat(visibleWidth(fullPrefix));
    const contentWidth = Math.max(1, safeWidth - visibleWidth(fullPrefix));
    const styleLine = (line: string): string => {
      if (tone === "prestyled") return line;
      if (tone === "error") return theme.fg("error", line);
      if (tone === "warning") return theme.fg("warning", line);
      return theme.fg("toolOutput", line);
    };

    const visualLines: string[] = [];
    for (const line of sourceLines(plain)) {
      const wrapped = wrapTextWithAnsi(styleLine(line), contentWidth);
      visualLines.push(...(wrapped.length > 0 ? wrapped : [""]));
    }

    const limit = Math.max(1, previewRows);
    let selected = visualLines;
    let hidden = 0;
    if (!expanded && visualLines.length > limit) {
      hidden = visualLines.length - limit;
      selected = direction === "tail"
        ? visualLines.slice(-limit)
        : visualLines.slice(0, limit);
    }

    const omission = hidden > 0
      ? theme.fg(
          "muted",
          `… +${hidden} ${direction === "tail" ? "earlier " : ""}line${
            hidden === 1 ? "" : "s"
          } (ctrl+e to expand)`,
        )
      : undefined;
    const rows = omission
      ? direction === "tail"
        ? [omission, ...selected]
        : [...selected, omission]
      : selected;

    this.cachedLines = rows.map((line, index) => {
      const prefix = index === 0 ? fullPrefix : continuationPrefix;
      return truncateToWidth(
        `${theme.fg("muted", prefix)}${line}`,
        safeWidth,
        "…",
      );
    });
    this.cachedWidth = safeWidth;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function renderTreeOutput(
  lastComponent: Component | undefined,
  options: TreeOutputOptions,
): TreeOutputComponent {
  if (lastComponent instanceof TreeOutputComponent) {
    return lastComponent.setOptions(options);
  }
  return new TreeOutputComponent(options);
}
