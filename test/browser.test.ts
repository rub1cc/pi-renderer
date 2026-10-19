import { beforeAll, expect, test } from "bun:test";
import { initTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createBrowserToolRenderers } from "../generic.ts";
import type { CodexRenderState } from "../components.ts";

beforeAll(async () => { await initTheme("light", false); });
const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
function ctx(args: unknown, state: CodexRenderState = {}) {
  return { args, state, toolCallId: "browser-1", invalidate() {},
    lastComponent: undefined, cwd: "/repo", executionStarted: true,
    argsComplete: true, isPartial: false, isError: false, expanded: false };
}
function rows(component: { render(width: number): string[] }, width = 80) {
  return component.render(width).map(stripTerminalSequences);
}
function result(text: string, details: unknown = undefined): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

test("browser snapshot/click/eval use compact reusable activity headers", () => {
  const adapter = createBrowserToolRenderers();
  for (const argv of [["snapshot", "-i"], ["click", "@e3"], ["eval", "JSON.stringify(document.body)"]]) {
    const args = { args: argv };
    const context = ctx(args);
    const call = adapter.renderCall(args, theme, { ...context, isPartial: true });
    expect(rows(call).join("\n")).toContain(`Browser(${argv[0]}`);
    expect(adapter.renderCall(args, theme, { ...context, lastComponent: call })).toBe(call);
    expect(rows(call).join("\n")).toContain(`Browser(${argv[0]}`);
    expect(rows(call).join("\n")).not.toContain("JSON.stringify");
    if (argv[0] !== "eval") expect(rows(call).join("\n")).toContain(argv.join(" "));
  }
});

test("all browser family headers avoid sensitive argument values", () => {
  for (const name of ["agent_browser", "agent_browser_code", "agent_browser_action", "agent_browser_qa",
    "agent_browser_electron", "agent_browser_source", "agent_browser_network_source", "agent_browser_tools"]) {
    const adapter = createBrowserToolRenderers(name);
    const args = { args: ["fill", "@e9", "PRIVATE_SECRET"], action: "fill",
      value: "PRIVATE_SECRET", code: "PRIVATE_SECRET", stdin: "PRIVATE_SECRET", url: "PRIVATE_SECRET" };
    expect(rows(adapter.renderCall(args, theme, ctx(args))).join("\n")).not.toContain("PRIVATE_SECRET");
  }
});

test("browser output previews are bounded and expand without clipping or mutation", () => {
  const adapter = createBrowserToolRenderers();
  const context = ctx({ args: ["snapshot", "-i"] });
  const output = result(Array.from({ length: 60 }, (_, i) => `browser row ${i}`).join("\n") +
    `\n${"x".repeat(300)}TAIL_MARKER`);
  const original = JSON.stringify(output);
  const collapsed = adapter.renderResult(output, { expanded: false, isPartial: false }, theme, context);
  expect(rows(collapsed).join("\n")).toContain("browser row 0");
  expect(rows(collapsed).join("\n")).not.toContain("browser row 59");
  const expanded = adapter.renderResult(output, { expanded: true, isPartial: false }, theme,
    { ...context, lastComponent: collapsed });
  expect(expanded).toBe(collapsed);
  const full = rows(expanded, 30);
  expect(full.every((row) => visibleWidth(row) <= 30)).toBe(true);
  expect(full.join("\n")).toContain("browser row 59");
  expect(full.join("").replace(/\s|└|│/gu, "")).toContain("x".repeat(300) + "TAIL_MARKER");
  expect(JSON.stringify(output)).toBe(original);
  const restored = adapter.renderResult(output, { expanded: false, isPartial: false }, theme,
    { ...context, lastComponent: expanded });
  expect(rows(restored).join("\n")).not.toContain("browser row 59");
});

test("native failure categories update the header and sanitized result", () => {
  const adapter = createBrowserToolRenderers();
  const context = ctx({ args: ["click", "@e3"] });
  const call = adapter.renderCall(context.args, theme, context);
  const output = adapter.renderResult(result("\u001b[31mfailed\u001b[0m", { resultCategory: "failure" }),
    { expanded: false, isPartial: false }, theme, context);
  expect(rows(call).join("\n")).toContain("Browser(click @e3) · Failed");
  expect(rows(output).join("\n")).toContain("failed");
});

test("summary-only image results leave image payloads untouched", () => {
  const adapter = createBrowserToolRenderers();
  const output: AgentToolResult<unknown> = {
    content: [{ type: "image", data: "IMAGE_PAYLOAD", mimeType: "image/png" }],
    details: { summary: "Screenshot captured" },
  };
  const rendered = adapter.renderResult(output, { expanded: false, isPartial: false }, theme, ctx({}));
  expect(rows(rendered).join("\n")).toContain("Screenshot captured");
  expect(rows(rendered).join("\n")).not.toContain("IMAGE_PAYLOAD");
  expect(output.content).toHaveLength(1);
});
