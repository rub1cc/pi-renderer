import { beforeAll, describe, expect, test } from "bun:test";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  InteractiveMode,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  getOsc8LinkAtColumn,
  Markdown,
  MouseRegion,
  setCapabilities,
  stripTerminalSequences,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { installCompactUserMessages } from "../user-messages.ts";
import { decorateAssistantReply } from "../assistant-replies.ts";

beforeAll(async () => { await initTheme("light", false); installCompactUserMessages(); });
const rows = (component: { render(width: number): string[] }, width = 40) =>
  component.render(width).map(stripTerminalSequences);

describe("compact user messages", () => {
  test("uses the same marker and text columns as the unchanged assistant renderer", () => {
    const user = new UserMessageComponent("Prompt");
    const assistant = new AssistantMessageComponent({ role: "assistant",
      content: [{ type: "text", text: "Reply" }], stopReason: "stop", timestamp: 1 } as any,
    true, getMarkdownTheme());
    decorateAssistantReply(assistant, () => undefined);
    const input = rows(user).find(line => line.includes("Prompt"))!;
    const reply = rows(assistant).find(line => line.includes("Reply"))!;
    expect(input.indexOf("❯")).toBe(reply.indexOf("⏺"));
    expect(input.indexOf("Prompt")).toBe(reply.indexOf("Reply"));
  });

  test("aligns its marker and text with no vertical padding and one cell of right padding", () => {
    const user = new UserMessageComponent("user prompt", getMarkdownTheme(), 8);
    const output = rows(user, 20);
    expect(output).toEqual(["❯ user prompt       "]);
    expect((user as any).text).toBe("user prompt");
    user.setOutputPad(5);
    expect(rows(user, 20)).toEqual(output);
    expect(rows(user, 20).filter(line => line.startsWith("❯ "))).toHaveLength(1);
  });

  test("retains native background and foreground colors without padding rows", () => {
    const user = new UserMessageComponent("prompt");
    const theme = (InteractiveMode.prototype as any).createExtensionUIContext.call({}).theme;
    const output = user.render(30);
    for (const line of output) expect(line).toContain(theme.getBgAnsi("userMessageBg"));
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(theme.getFgAnsi("userMessageText"));
    expect(output[0]).toContain("❯ ");
    expect(stripTerminalSequences(output[0])).toBe("❯ prompt" + " ".repeat(22));
  });

  test("wraps continuation lines under prompt text and handles narrow terminal widths", () => {
    const user = new UserMessageComponent("A long user prompt with 文件 and emoji 👋 that wraps onto several lines.");
    for (const width of [1, 2, 3, 4, 5, 8, 20, 80]) {
      const output = rows(user, width);
      expect(output.every(line => visibleWidth(line) <= width)).toBe(true);
      const text = output.filter(line => line.trim());
      if (width >= 4) {
        expect(text[0]).toStartWith("❯ ");
        expect(text.slice(1).every(line => line.startsWith("  "))).toBe(true);
      } else expect(text.every(line => !line.includes("❯"))).toBe(true);
    }
    expect(user.render(0)).toEqual([]);
    expect(rows(user, 80).join("\n")).toContain("文件");
    expect(rows(user, 80).join("\n")).toContain("👋");
  });

  test("preserves multiline Markdown, code, lists, and blank paragraph boundaries", () => {
    const text = "First paragraph\n\nSecond paragraph\n\n1. One\n2. Two\n\n```ts\nconst value = 1;\n```";
    const user = new UserMessageComponent(text);
    const output = rows(user, 60);
    expect(output.filter(line => line.startsWith("❯ "))).toHaveLength(1);
    for (const expected of ["First paragraph", "Second paragraph", "1. One", "2. Two", "const value = 1;"]) {
      expect(output.join("\n")).toContain(expected);
    }
    expect((user as any).text).toBe(text);
    const first = output.findIndex(line => line.includes("First paragraph"));
    const second = output.findIndex(line => line.includes("Second paragraph"));
    expect(second).toBeGreaterThan(first + 1);
  });

  test("keeps native transforms and passes the actual available content width", () => {
    const contexts: any[] = [];
    const user = new UserMessageComponent("original", getMarkdownTheme(), 1, [(text, context) => {
      contexts.push(context);
      return text.replace("original", "transformed");
    }]);
    expect(rows(user, 30)[0]).toStartWith("❯ transformed");
    expect(contexts.at(-1)).toEqual({ messageType: "user", isStreaming: false, availableWidth: 27 });
    expect((user as any).text).toBe("original");
    const hidden = new UserMessageComponent("hidden", getMarkdownTheme(), 1, [() => ""]);
    expect(rows(hidden)).toEqual([]);
    expect(rows(new UserMessageComponent("  \n "))).toEqual([]);
  });

  test("retains terminal prompt zones exactly once", () => {
    const user = new UserMessageComponent("A prompt that wraps at narrow widths");
    for (const width of [12, 60, 12]) {
      const output = user.render(width);
      const raw = output.join("\n");
      for (const zone of ["\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07"]) {
        expect(raw.split(zone)).toHaveLength(2);
      }
      expect(output[0]).toStartWith("\x1b]133;A\x07");
      expect(output.at(-1)).toEndWith("\x1b]133;B\x07\x1b]133;C\x07");
      expect(raw.indexOf("\x1b]133;A\x07")).toBeLessThan(raw.indexOf("\x1b]133;B\x07"));
    }
  });

  test("reload and newly replayed messages never accumulate gutters or padding", () => {
    const user = new UserMessageComponent("prompt");
    const expected = rows(user);
    const render = UserMessageComponent.prototype.render;
    for (let reload = 0; reload < 3; reload++) {
      installCompactUserMessages();
      expect(UserMessageComponent.prototype.render).toBe(render);
      user.invalidate();
      expect(rows(user)).toEqual(expected);
      expect(rows(new UserMessageComponent("prompt"))).toEqual(expected);
    }
  });

  test("native Markdown source updates and theme changes remain visible", async () => {
    const user = new UserMessageComponent("original");
    const source = (user as any).children[0] as Markdown;
    rows(user);
    source.setText("changed");
    expect(rows(user)[0]).toStartWith("❯ changed");
    const before = user.render(40).join("\n");
    await initTheme("dark", false);
    user.invalidate();
    expect(user.render(40).join("\n")).not.toBe(before);
    expect(rows(user)[0]).toStartWith("❯ changed");
  });

  test("click targets below the compact prompt retain their row positions", () => {
    const container = new Container();
    container.addChild(new UserMessageComponent("A prompt long enough to wrap."));
    let clicks = 0;
    container.addChild(new MouseRegion(new Text("NEXT", 0, 0), () => { clicks++; return { handled: true }; }));
    for (const width of [12, 60, 12]) {
      const output = rows(container, width);
      const y = output.findIndex(line => line.includes("NEXT"));
      expect(container.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y,
        width, height: output.length, shift: false, alt: false, ctrl: false })?.handled).toBe(true);
    }
    expect(clicks).toBe(3);
  });

  test("OSC 8 links move with the content, not the marker", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const user = new UserMessageComponent("[Link](https://example.test)");
      const line = user.render(30)[0];
      expect(stripTerminalSequences(line)).toStartWith("❯ Link");
      expect(getOsc8LinkAtColumn(line, 2)).toBe("https://example.test");
      expect(getOsc8LinkAtColumn(line, 0)).toBeUndefined();
    } finally { setCapabilities(capabilities); }
  });

  test("terminal graphics rows are never prefixed or truncated", () => {
    const graphics = "\x1b_Ga=T,f=100;image-payload\x1b\\";
    const user = new UserMessageComponent(graphics);
    const source = (user as any).children[0];
    const native = source.render(27).find((line: string) => line.includes("\x1b_G"));
    expect(native).toBeDefined();
    const rendered = user.render(30).find(line => line.includes("\x1b_G"))!;
    expect(rendered.replace(/\x1b\]133;[ABC]\x07/g, "")).toBe(native);
  });

  test("unsupported or frozen child structures retain native rendering", () => {
    const extra = new UserMessageComponent("prompt");
    extra.addChild(new Text("extra content", 0, 0));
    expect(rows(extra).join("\n")).not.toContain("❯");
    expect(rows(extra).join("\n")).toContain("extra content");
    const frozen = new UserMessageComponent("prompt");
    Object.freeze((frozen as any).children);
    expect(rows(frozen).join("\n")).toContain("prompt");
    expect(rows(frozen).join("\n")).not.toContain("❯");
  });
});
