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
} from "./components.ts";

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
}

interface WebCodexRenderState extends CodexRenderState {
  details?: WebToolDetails;
}

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

function webSubject(kind: WebToolKind, args: unknown): string {
  if (kind === "search") {
    const queries = stringList(args, "queries", "query");
    if (queries.length === 1) return `“${compact(queries[0])}”`;
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

function webVerbs(kind: WebToolKind): { active: string; success: string } {
  if (kind === "search") return { active: "Searching", success: "Searched" };
  if (kind === "source-check") return { active: "Checking", success: "Checked" };
  if (kind === "fetch") return { active: "Fetching", success: "Fetched" };
  return { active: "Reading", success: "Read" };
}

function webStats(kind: WebToolKind, details: WebToolDetails | undefined): string {
  if (!details) return "";
  const parts: string[] = [];

  if (kind === "search") {
    if (details.queryCount !== undefined) {
      const successful = details.successfulQueries ?? details.queryCount;
      parts.push(`${successful}/${details.queryCount} queries`);
    }
    if (details.totalResults !== undefined) {
      parts.push(`${details.totalResults} sources`);
    }
    if (details.fetchUrls?.length) {
      parts.push(`fetching ${details.fetchUrls.length} URLs`);
    }
  } else if (kind === "fetch") {
    if (details.urlCount !== undefined) {
      const successful = details.successful ?? details.urlCount;
      parts.push(`${successful}/${details.urlCount} URLs`);
    }
    if (details.totalChars !== undefined) parts.push(`${details.totalChars} chars`);
  } else if (kind === "stored-content") {
    if (details.matchCount !== undefined) {
      parts.push(`${details.matchCount} matches`);
    } else if (details.resultCount !== undefined) {
      parts.push(`${details.resultCount} results`);
    } else if (details.contentLength !== undefined) {
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
  const verbs = webVerbs(kind);
  const failed = context.isError || Boolean(context.state.details?.error);
  const stats = webStats(kind, context.state.details);
  return renderActivityHeader(
    context.state,
    context.state.callComponent ?? context.lastComponent,
    {
      status: failed ? "error" : context.isPartial ? "active" : "success",
      activeVerb: verbs.active,
      successVerb: verbs.success,
      errorVerb: "Failed",
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
      renderWebHeader(kind, theme, context);
      const text = options.isPartial
        ? partialWebOutput(result, details)
        : getTextOutput(result);
      return renderTreeOutput(context.lastComponent, {
        text,
        expanded: options.expanded,
        direction: "head",
        previewRows: 3,
        tone: context.isError || Boolean(details?.error) ? "error" : "output",
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
  const container = new Container();
  const marker = activityMarker(error ? "error" : "success", theme);
  container.addChild(
    new Text(
      `${marker} ${theme.fg(error ? "error" : "toolTitle", theme.bold(title))}`,
      0,
      0,
    ),
  );
  container.addChild(
    renderTreeOutput(undefined, {
      text: messageText(content),
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

