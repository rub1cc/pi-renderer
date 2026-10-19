import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  type CodexRenderState,
  type RendererContext,
  activityMarker,
  asNumber,
  getTextOutput,
  inlineText,
  renderActivityHeader,
  renderTreeOutput,
  sanitizeTerminalText,
} from "./components.ts";
import { toolLabel } from "./labels.ts";

type WebToolKind =
  | "search"
  | "source-check"
  | "fetch"
  | "stored-content";

interface WebToolDetails {
  error?: string;
  phase?: string;
  progress?: number;
  currentQuery?: string;
  queryCount?: number;
  successfulQueries?: number;
  totalResults?: number;
  fetchUrls?: string[];
  urlCount?: number;
  successful?: number;
  totalChars?: number;
  matchCount?: number;
  returnedMatches?: number;
  resultCount?: number;
  contentLength?: number;
  returnedChars?: number;
  title?: string;
  sourceCount?: number;
  passageCount?: number;
  artifact?: unknown;
}

interface WebCodexRenderState extends CodexRenderState {
  details?: WebToolDetails;
  failed?: boolean;
}

type WebResult = { isError?: boolean; content?: unknown; details?: unknown };

function objectValue(args: unknown, key: string): unknown {
  if (!args || typeof args !== "object") return undefined;
  return (args as Record<string, unknown>)[key];
}

function compact(value: unknown, limit = 90): string {
  const text = inlineText(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function stringList(args: unknown, plural: string, singular: string): string[] {
  const values = objectValue(args, plural);
  if (Array.isArray(values)) {
    return values.map((value) => compact(value, 200)).filter(Boolean);
  }
  const value = compact(objectValue(args, singular), 200);
  return value ? [value] : [];
}

function webToolKind(toolName: string, label?: string): WebToolKind | undefined {
  const key = `${toolName}\n${label ?? ""}`.toLowerCase();
  if (toolName === "web_search" || key.includes("web search")) return "search";
  if (toolName === "source_check" || key.includes("source check")) {
    return "source-check";
  }
  if (toolName === "fetch_content" || key.includes("fetch content")) return "fetch";
  if (toolName === "get_search_content" || key.includes("get search content")) {
    return "stored-content";
  }
  return undefined;
}

function count(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0
    ? number
    : undefined;
}

function hasError(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function incompleteCounts(kind: WebToolKind | undefined, details: unknown): string {
  const keys = kind === "search" ? ["successfulQueries", "queryCount", "queries"]
    : kind === "fetch" ? ["successful", "urlCount", "URLs"] : undefined;
  if (!keys) return "";
  const successful = count(objectValue(details, keys[0]));
  const total = count(objectValue(details, keys[1]));
  return successful !== undefined && total !== undefined && successful < total
    ? `${successful}/${total} ${keys[2]} succeeded; partial failure`
    : "";
}

function researchErrors(details: unknown): unknown[] {
  const artifact = objectValue(details, "artifact");
  const errors = objectValue(artifact, "errors");
  const sources = objectValue(artifact, "sources");
  return [
    ...(Array.isArray(errors) ? errors.map((entry) => objectValue(entry, "error")) : []),
    ...(Array.isArray(sources) ? sources.map((entry) => objectValue(entry, "fetch_error")) : []),
  ].filter(hasError);
}

// Also used by grouped headers. Missing or unfamiliar metadata is not a failure.
export function webResultFailed(toolName: string, result: WebResult | undefined, isPartial = false): boolean {
  return resultFailed(webToolKind(toolName), result, isPartial);
}

function resultFailed(kind: WebToolKind | undefined, result: WebResult | undefined, isPartial = false): boolean {
  if (!result) return false;
  if (result.isError || hasError(objectValue(result.details, "error"))) return true;
  return (!isPartial && Boolean(incompleteCounts(kind, result.details))) ||
    (kind === "source-check" && researchErrors(result.details).length > 0);
}

function counted(value: unknown, singular: string, plural = `${singular}s`): string {
  const number = count(value);
  return number === undefined ? "" : `${number} ${number === 1 ? singular : plural}`;
}

function pageTitles(text: string): string[] {
  // Native multi-fetch summaries, not arbitrary Markdown headings in page bodies.
  if (!sanitizeTerminalText(text.slice(0, 256)).trimStart().startsWith("## Fetched URLs")) return [];
  const lines = sanitizeTerminalText(text).replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines[0] === "## Fetched URLs") {
    const entries = lines.slice(1, lines.indexOf("---") < 0 ? undefined : lines.indexOf("---"))
      .filter((line) => line.trim());
    const matches = entries.map((line) => /^- (.+) \(\d+ chars\)$/.exec(line));
    return matches.length && matches.every(Boolean)
      ? matches.map((match) => compact(match![1])) : [];
  }
  return [];
}

function webPreview(kind: WebToolKind, text: string, details?: WebToolDetails): string | undefined {
  const parts: string[] = [];
  let titles: string[] = [];
  if (kind === "search") {
    parts.push(counted(details?.totalResults, "source"), counted(details?.queryCount, "query", "queries"));
    // A numbered title is only a source title when followed by its source URL.
    const sources = sanitizeTerminalText(text).matchAll(/^\d+\. (\S[^\n]*)\n[ \t]+https?:\/\/\S+/gm);
    titles = [...sources].map((match) => compact(match[1]));
  } else if (kind === "source-check") {
    parts.push(counted(details?.sourceCount, "source"), counted(details?.passageCount, "passage"));
  } else if (kind === "fetch") {
    parts.push(counted(details?.urlCount, "page"), counted(details?.totalChars, "char"));
    const title = compact(details?.title);
    titles = title ? [title] : pageTitles(text);
  } else {
    const title = compact(details?.title);
    if (title) titles.push(title);
    if (count(details?.matchCount) !== undefined) {
      parts.push(counted(details?.matchCount, "match", "matches"));
      if (count(details?.returnedMatches) !== undefined) {
        parts.push(`${details!.returnedMatches} returned`);
      }
    } else {
      parts.push(counted(details?.resultCount, "result"));
    }
    if (count(details?.returnedChars) !== undefined) {
      parts.push(`${details!.returnedChars} chars returned`);
    } else {
      parts.push(counted(details?.contentLength, "char"));
    }
  }
  const stats = parts.filter(Boolean).join(" · ");
  // Search titles alone are not enough to identify an unfamiliar output shape.
  if (!stats && kind !== "fetch" && kind !== "stored-content") return undefined;
  if (!stats && !titles.length) return undefined;
  return [stats, titles.join("; ")].filter(Boolean).join("\n");
}

function failurePreview(kind: WebToolKind, text: string, details?: WebToolDetails): string {
  const reasons = [
    compact(details?.error, 400),
    incompleteCounts(kind, details),
    ...(kind === "source-check" ? researchErrors(details).map((error) => compact(error, 400)) : []),
  ];
  // Bring native diagnostics to the front when a failure follows successful pages.
  const diagnostics = sanitizeTerminalText(text).split(/\r?\n/)
    .filter((line) => /^\s*(?:Error:|Failed:|- .+: Error -)/i.test(line));
  return [...new Set([...reasons, ...diagnostics].filter(Boolean)), text].filter(Boolean).join("\n");
}

export function webFailureText(toolName: string, result: WebResult | undefined): string | undefined {
  const kind = webToolKind(toolName);
  return kind && result ? failurePreview(kind, messageText(result.content), result.details as WebToolDetails | undefined) : undefined;
}

function webSubject(kind: WebToolKind, args: unknown): string {
  if (kind === "search") {
    const queries = stringList(args, "queries", "query");
    if (queries.length === 1) return JSON.stringify(compact(queries[0]));
    return queries.length > 1 ? `${queries.length} queries` : "the web";
  }

  if (kind === "source-check") {
    return compact(objectValue(args, "claim")) || "sources";
  }

  if (kind === "fetch") {
    const urls = stringList(args, "urls", "url");
    if (urls.length === 1) return compact(urls[0]);
    return urls.length > 1 ? `${urls.length} URLs` : "content";
  }

  const findText = objectValue(args, "findText");
  const findCount = Array.isArray(findText) ? findText.length : findText ? 1 : 0;
  if (findCount > 0) return `${findCount} passage${findCount === 1 ? "" : "s"}`;
  const target = compact(objectValue(args, "url")) ||
    compact(objectValue(args, "query"));
  if (target) return target;
  const responseId = compact(objectValue(args, "responseId"), 20);
  return responseId || "stored content";
}

function webLabel(kind: WebToolKind): string {
  if (kind === "search") return toolLabel("web_search");
  if (kind === "source-check") return toolLabel("source_check");
  if (kind === "fetch") return toolLabel("fetch_content");
  return toolLabel("get_search_content");
}

function webStats(kind: WebToolKind, details: WebToolDetails | undefined): string {
  if (!details) return "";
  const parts: string[] = [];

  if (kind === "search") {
    if (count(details.queryCount) !== undefined) {
      parts.push(count(details.successfulQueries) === undefined
        ? `${details.queryCount} queries`
        : `${details.successfulQueries}/${details.queryCount} queries`);
    }
    if (count(details.totalResults) !== undefined) {
      parts.push(`${details.totalResults} sources`);
    }
    if (Array.isArray(details.fetchUrls) && details.fetchUrls.length) {
      parts.push(`fetching ${details.fetchUrls.length} URLs`);
    }
  } else if (kind === "fetch") {
    if (count(details.urlCount) !== undefined) {
      parts.push(count(details.successful) === undefined
        ? `${details.urlCount} URLs`
        : `${details.successful}/${details.urlCount} URLs`);
    }
    if (count(details.totalChars) !== undefined) parts.push(`${details.totalChars} chars`);
  } else if (kind === "stored-content") {
    if (count(details.matchCount) !== undefined) {
      parts.push(`${details.matchCount} matches`);
    } else if (count(details.resultCount) !== undefined) {
      parts.push(`${details.resultCount} results`);
    } else if (count(details.contentLength) !== undefined) {
      parts.push(`${details.contentLength} chars`);
    }
  }

  return parts.length > 0 ? `(${parts.join(" · ")})` : "";
}

function renderWebHeader(
  kind: WebToolKind,
  theme: Theme,
  context: RendererContext<WebCodexRenderState, unknown>,
) {
  const failed = context.isError || context.state.failed || hasError(context.state.details?.error);
  const stats = webStats(kind, context.state.details);
  return renderActivityHeader(
    context.state,
    context.state.callComponent ?? context.lastComponent,
    {
      status: failed ? "error" : context.isPartial ? "active" : "success",
      label: webLabel(kind),
      subject: theme.fg("accent", webSubject(kind, context.args)),
      suffix: stats ? theme.fg("muted", stats) : "",
    },
    theme,
  );
}

function partialWebOutput(result: AgentToolResult<unknown>, details?: WebToolDetails): string {
  const text = getTextOutput(result);
  if (text) return text;
  const phase = compact(details?.phase) || "working";
  const progress = asNumber(details?.progress);
  return progress === undefined ? phase : `${phase} (${Math.round(progress * 100)}%)`;
}

export function createWebToolRenderers(toolName: string, label?: string) {
  const kind = webToolKind(toolName, label);
  if (!kind) return undefined;

  return {
    renderShell: "self" as const,

    renderCall(
      _args: unknown,
      theme: Theme,
      context: RendererContext<WebCodexRenderState, unknown>,
    ) {
      return renderWebHeader(kind, theme, context);
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RendererContext<WebCodexRenderState, unknown>,
    ) {
      const details = result.details as WebToolDetails | undefined;
      context.state.details = details;
      const failed = context.isError || resultFailed(kind, result, options.isPartial);
      context.state.failed = Boolean(failed);
      renderWebHeader(kind, theme, { ...context, isPartial: options.isPartial });
      const raw = options.isPartial
        ? partialWebOutput(result, details)
        : getTextOutput(result);
      const text = options.expanded ? raw || (typeof details?.error === "string" ? details.error : "")
        : failed ? failurePreview(kind, raw, details)
        : options.isPartial ? raw
        : webPreview(kind, raw, details) ?? raw;
      return renderTreeOutput(context.lastComponent, {
        text,
        expanded: options.expanded,
        direction: "head",
        previewRows: 3,
        tone: failed ? "error" : "output",
        theme,
      });
    },
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function webNotification(
  title: string,
  content: unknown,
  expanded: boolean,
  theme: Theme,
  error = false,
) {
  const raw = messageText(content);
  const fetched = /^Content fetched for (\d+)\/(\d+) URLs\b/.exec(raw);
  const incomplete = fetched && Number(fetched[1]) < Number(fetched[2]);
  error ||= Boolean(incomplete);
  if (incomplete) title = "Web content fetch incomplete";
  const ready = /^Content fetched for \d+\/\d+ URLs(?: \[[^\]\r\n]+\])?\. Full page content now available\.$/.test(raw);
  const text = !expanded && error ? failurePreview("fetch", raw)
    : !expanded && ready && fetched ? `Content fetched for ${fetched[1]}/${fetched[2]} URLs`
    : raw;
  const container = new Container();
  container.addChild(
    new Text(
      `${activityMarker(error ? "error" : "success", theme)} ${theme.fg(error ? "error" : "toolTitle", theme.bold(title))}`,
      0,
      0,
    ),
  );
  container.addChild(
    renderTreeOutput(undefined, {
      text,
      expanded,
      direction: "head",
      previewRows: 3,
      tone: error ? "error" : "output",
      theme,
    }),
  );
  return container;
}

export function registerWebMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    "web-search-content-ready",
    (message, { expanded }, theme) =>
      webNotification("Fetched web content", message.content, expanded, theme),
  );
  pi.registerMessageRenderer(
    "web-search-error",
    (message, { expanded }, theme) =>
      webNotification("Web content fetch failed", message.content, expanded, theme, true),
  );
}

