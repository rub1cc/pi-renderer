import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TreeOutputComponent } from "../components.ts";
import {
  createWebToolRenderers,
  registerWebMessageRenderers,
  webResultFailed,
} from "../web.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;

type Result = AgentToolResult<unknown> & { isError?: boolean };

function result(text: string, details?: unknown, isError?: boolean): Result {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError } : {}) };
}

function setup(name: string, overrides = {}) {
  const renderers = createWebToolRenderers(name)!;
  const ctx = {
    args: {}, toolCallId: "web-test", invalidate() {}, lastComponent: undefined,
    state: {}, cwd: "/repo", executionStarted: true, argsComplete: true,
    isPartial: false, expanded: false, showImages: false, isError: false,
    ...overrides,
  } as any;
  const call = renderers.renderCall(ctx.args, theme, ctx);
  return {
    ctx, call,
    output(value: Result, expanded = false, isPartial = false) {
      return renderers.renderResult(value, { expanded, isPartial }, theme, ctx);
    },
  };
}

function lines(component: { render(width: number): string[] }, width = 100) {
  return component.render(width).map(stripTerminalSequences);
}

function text(component: { render(width: number): string[] }, width = 100) {
  return lines(component, width).join("\n");
}

describe("collapsed successful web previews", () => {
  test("skips blank Markdown headings and uses only the native page title/counts", () => {
    const view = setup("fetch_content");
    const output = view.output(result("#\n\n# \n\nVerbose page body", {
      title: "Actual page title", urlCount: 1, successful: 1, totalChars: 42,
    }));
    expect(text(output)).toContain("1 page");
    expect(text(output)).toContain("42 chars");
    expect(text(output)).toContain("Actual page title");
    expect(text(output)).not.toContain("#");
    expect(text(output)).not.toContain("Verbose page body");
    expect(lines(output)).toHaveLength(2);
    expect(text(view.call)).toStartWith("• WebFetch(");
  });

  test("keeps a blank native title blank instead of inventing a document title", () => {
    const output = setup("fetch_content").output(result("#\n\n# \n\nBody", {
      title: "", urlCount: 1, successful: 1, totalChars: 15,
    }));
    expect(lines(output)).toEqual(["  ⎿ 1 page · 15 chars"]);
  });

  test("summarizes native multi-page fetch headings without showing Markdown scaffolding", () => {
    const raw = "## Fetched URLs\n\n- First page (30 chars)\n- Second page (70 chars)\n\n---\nUse get_search_content to read more.";
    const output = setup("fetch_content").output(result(raw, {
      urlCount: 2, successful: 2, totalChars: 100,
    }));
    expect(text(output)).toContain("2 pages · 100 chars");
    expect(text(output)).toContain("First page; Second page");
    expect(text(output)).not.toContain("Fetched URLs");
    expect(text(output)).not.toContain("get_search_content");
    expect(lines(output)).toHaveLength(2);
  });

  test("can use a known multi-fetch format without inventing missing counts", () => {
    const output = setup("fetch_content").output(result("## Fetched URLs\n\n- Page A (12 chars)\n- Page B (42 chars)\n"));
    expect(lines(output)).toEqual(["  ⎿ Page A; Page B"]);
  });

  test("uses search counts and URL-backed source titles, not answer headings", () => {
    const view = setup("web_search");
    const output = view.output(result("**Provider:** brave\n\n## An answer heading\n\n1. One source\n   https://one.test\n\n2. Another source\n   https://two.test\n", {
      queryCount: 1, successfulQueries: 1, totalResults: 2,
    }));
    expect(text(output)).toContain("2 sources · 1 query");
    expect(text(output)).toContain("One source; Another source");
    expect(text(output)).not.toContain("Provider");
    expect(text(output)).not.toContain("answer heading");
    expect(text(view.call)).toContain("1/1 queries · 2 sources");
  });

  test("uses source-check evidence counts without claiming verification", () => {
    const output = setup("source_check").output(result("{\n  \"claims\": [\"unclear\"]\n}", {
      sourceCount: 3, passageCount: 4, searchCount: 2,
      artifact: { errors: [], sources: [] },
    }));
    expect(lines(output)).toEqual(["  ⎿ 3 sources · 4 passages"]);
    expect(text(output)).not.toMatch(/verified|supported|confirmed/i);
  });

  test("distinguishes returned stored-content matches and characters from totals", () => {
    const details = { title: "Stored page", matchCount: 12, returnedMatches: 3, returnedChars: 120, contentLength: 800 };
    const output = setup("get_search_content").output(result("# Stored page\n\nMany excerpts", details));
    expect(text(output)).toContain("12 matches · 3 returned · 120 chars returned");
    expect(text(output)).toContain("Stored page");
    expect(webResultFailed("get_search_content", { details })).toBe(false);
  });

  test("zero results is a successful search, not a fabricated source", () => {
    const value = result("No results found.", { queryCount: 1, successfulQueries: 1, totalResults: 0 });
    expect(text(setup("web_search").output(value))).toContain("0 sources");
    expect(webResultFailed("web_search", value)).toBe(false);
  });

  test("unknown result shapes fail open to the original raw preview", () => {
    for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
      const raw = "## Unknown shape\n\nNo trustworthy metadata\nOther output\nLast line";
      for (const details of [undefined, null, {}, { pages: ["not a native field"] }]) {
        const output = setup(name).output(result(raw, details));
        const original = new TreeOutputComponent({ text: raw, expanded: false, theme });
        expect(lines(output)).toEqual(lines(original));
        expect(webResultFailed(name, { details })).toBe(false);
      }
    }
  });

  test("missing success counts are not promoted to all-success ratios", () => {
    const view = setup("fetch_content");
    view.output(result("Body", { urlCount: 2 }));
    expect(text(view.call)).toContain("2 URLs");
    expect(text(view.call)).not.toContain("2/2");
  });
});

describe("web errors and partial output", () => {
  test("native, context and details errors stay visible and mark the header failed", () => {
    for (const mode of ["native", "context", "details"] as const) {
      const view = setup("fetch_content", { isError: mode === "context" });
      const value = result("Error: rate limited", {
        title: "Must not hide the error", urlCount: 1, successful: 1,
        ...(mode === "details" ? { error: "rate limited" } : {}),
      }, mode === "native");
      expect(text(view.output(value))).toContain("rate limited");
      expect(text(view.call)).toContain("Failed");
      if (mode !== "context") expect(webResultFailed("fetch_content", value)).toBe(true);
    }
  });

  test("details-only errors have a visible preview even when text is empty", () => {
    const view = setup("web_search");
    expect(text(view.output(result("", { error: "Provider unavailable" })))).toContain("Provider unavailable");
    expect(text(view.call)).toContain("Failed");
  });

  test("partial query and URL failures do not render as successful summaries", () => {
    for (const [name, details, diagnostic] of [
      ["web_search", { queryCount: 2, successfulQueries: 1, totalResults: 5 }, "Error: second query timed out"],
      ["fetch_content", { urlCount: 2, successful: 1, totalChars: 20 }, "- https://bad.test: Error - denied"],
    ] as const) {
      const view = setup(name);
      const raw = `## Heading\n\nSuccessful first page\n\nMore success\n${diagnostic}`;
      const value = result(raw, details);
      expect(webResultFailed(name, value)).toBe(true);
      const output = text(view.output(value));
      expect(output).toContain("1/2");
      expect(output).toContain("partial failure");
      expect(output).toContain(diagnostic);
      expect(text(view.call)).toContain("Failed");
    }
  });

  test("source-check query and fetch errors in native artifacts are failures", () => {
    for (const artifact of [
      { errors: [{ query: "second", error: "Search unavailable" }] },
      { sources: [{ title: "Page", fetch_error: "Page denied" }] },
    ]) {
      const value = result("{\n  \"sources\": []\n}", { sourceCount: 2, passageCount: 1, artifact });
      const view = setup("source_check");
      expect(webResultFailed("source_check", value)).toBe(true);
      expect(text(view.output(value))).toMatch(/Search unavailable|Page denied/);
      expect(text(view.call)).toContain("Failed");
    }
  });

  test("failure helper ignores unknown counts, malformed counts and bounded retrieval", () => {
    expect(webResultFailed("web_search", undefined)).toBe(false);
    for (const details of [
      { queryCount: 2 }, { successfulQueries: 0 }, { queryCount: "2", successfulQueries: 0 },
      { queryCount: -1, successfulQueries: -2 }, { queryCount: NaN, successfulQueries: 0 },
      { successful: 1, total: 2 }, { error: null }, { error: false },
    ]) expect(webResultFailed("web_search", { details })).toBe(false);
    expect(webResultFailed("unknown_native_tool", { details: { urlCount: 2, successful: 1 } })).toBe(false);
    expect(webResultFailed("get_search_content", { details: { matchCount: 10, returnedMatches: 2, truncated: true } })).toBe(false);
  });

  test("streaming text is not compacted, and metadata progress stays useful", () => {
    const view = setup("web_search", { isPartial: true });
    const output = view.output(result("Searching second query", {
      queryCount: 2, successfulQueries: 1, totalResults: 5,
    }), false, true);
    expect(text(output)).toContain("Searching second query");
    expect(text(view.call)).toContain("running");
    expect(text(view.call)).not.toContain("Failed");
    expect(text(view.output(result("", { phase: "fetch", progress: 0.5 }), false, true))).toContain("fetch (50%)");
  });
});

describe("raw expansion and presentation safety", () => {
  test("expansion restores the complete wrapped raw output for all four tools", () => {
    for (const [name, details] of [
      ["web_search", { queryCount: 1, successfulQueries: 1, totalResults: 3 }],
      ["source_check", { sourceCount: 2, passageCount: 3 }],
      ["fetch_content", { title: "Native title", urlCount: 1, successful: 1 }],
      ["get_search_content", { title: "Stored title", contentLength: 100 }],
    ] as const) {
      const view = setup(name);
      const raw = "#\n\n# Original heading\n\nA very long content line that must be wrapped completely.\n\nLast line";
      const value = result(raw, details);
      const component = view.output(value);
      view.ctx.lastComponent = component;
      const expanded = view.output(value, true);
      expect(expanded).toBe(component);
      expect(lines(expanded, 24)).toEqual(lines(new TreeOutputComponent({ text: raw, expanded: true, theme }), 24));
      expect(text(expanded)).toContain("Last line");
      expect(text(view.output(value))).not.toContain("Last line");
    }
  });

  test("failure expansion also preserves the entire raw output unchanged", () => {
    const view = setup("fetch_content");
    const raw = "## Fetched URLs\n\n- Good page (20 chars)\n- bad: Error - timeout\n";
    const expanded = view.output(result(raw, { urlCount: 2, successful: 1 }), true);
    expect(lines(expanded)).toEqual(lines(new TreeOutputComponent({ text: raw, expanded: true, theme })));
  });

  test("sanitizes native titles and keeps previews within even very narrow widths", () => {
    const title = "\u001b[31mRed\u001b[0m\u0000\npage\tname with a deliberately long title";
    const value = result("Raw body", { title, urlCount: 1, successful: 1, totalChars: 100 });
    const view = setup("fetch_content");
    const component = view.output(value);
    expect(text(component)).toContain("Red page name");
    for (const width of [1, 2, 3, 5, 6, 12, 24]) {
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines(component, width).join("")).not.toMatch(/[\u0000\u001b]/);
    }
  });

  test("does not mutate arguments, content, details, artifacts or image payloads", () => {
    const artifact = Object.freeze({ sources: Object.freeze([]), errors: Object.freeze([]) });
    const details = Object.freeze({ sourceCount: 2, passageCount: 3, artifact });
    const value = Object.freeze({
      content: Object.freeze([
        Object.freeze({ type: "text", text: "# Raw\n\nBody" }),
        Object.freeze({ type: "image", data: "image bytes", mimeType: "image/png" }),
      ]), details,
    }) as unknown as Result;
    const args = Object.freeze({ claim: "Original claim" });
    const before = JSON.stringify({ args, value });
    const view = setup("source_check", { args });
    webResultFailed("source_check", value);
    view.output(value);
    view.output(value, true);
    expect(JSON.stringify({ args, value })).toBe(before);
    expect(value.details).toBe(details);
  });
});

describe("async content notifications", () => {
  const registered = new Map<string, Function>();
  registerWebMessageRenderers({
    registerMessageRenderer(name: string, renderer: Function) { registered.set(name, renderer); },
  } as any);

  test("compacts only known successful ready announcements and preserves expansion", () => {
    const ready = registered.get("web-search-content-ready")!;
    const raw = "Content fetched for 2/2 URLs [fetch-id]. Full page content now available.";
    expect(text(ready({ content: raw }, { expanded: false }, theme))).toContain("Content fetched for 2/2 URLs");
    expect(text(ready({ content: raw }, { expanded: false }, theme))).not.toContain("Full page content");
    expect(text(ready({ content: raw }, { expanded: true }, theme))).toContain(raw);
    const unknown = "A different announcement. Keep these diagnostics.";
    expect(text(ready({ content: unknown }, { expanded: false }, theme))).toContain(unknown);
  });

  test("partial content-ready and error notifications retain diagnostics", () => {
    const ready = registered.get("web-search-content-ready")!;
    const partial = "Content fetched for 1/2 URLs [fetch-id]. Partial page content now available.";
    const output = text(ready({ content: partial }, { expanded: false }, theme));
    expect(output).toContain("Web content fetch incomplete");
    expect(output).toContain(partial);
    const failed = registered.get("web-search-error")!;
    const diagnostic = "Content fetch failed: DNS unavailable";
    expect(text(failed({ content: diagnostic }, { expanded: false }, theme))).toContain(diagnostic);
  });
});
