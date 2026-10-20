import { beforeAll, describe, expect, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getOsc8LinkAtColumn, Markdown, MouseRegion, Text,
  stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ASSISTANT_REPLY_MARKER, decorateAssistantReply } from "../assistant-replies.ts";
import { ReadGroupingController } from "../read-groups.ts";

beforeAll(async () => { await initTheme("light", false); });

function message(content: any[], extra = {}) {
  return { role: "assistant", content, stopReason: "stop", timestamp: 1, ...extra } as any;
}
const prose = (text: string) => ({ type: "text", text });
const thinking = (text: string) => ({ type: "thinking", thinking: text });
function setup(content: any[], hidden = true, padding = 1, getTheme = () => undefined as Theme | undefined) {
  const host: any = { chatContainer: new Container(), hideThinkingBlock: hidden,
    ui: { requestRender() {} }, toolOutputExpanded: false };
  const controller = new ReadGroupingController(host, getTheme);
  controller.attach();
  const saved = message(content);
  const component = new AssistantMessageComponent(saved, hidden, getMarkdownTheme(), "Thinking...", padding);
  host.chatContainer.addChild(component);
  return { host, component, controller, saved };
}
function rows(component: { render(width: number): string[] }, width = 80): string[] {
  return component.render(width).map(stripTerminalSequences);
}
function markers(component: { render(width: number): string[] }, width = 80): number {
  return rows(component, width).filter(line => line.startsWith(ASSISTANT_REPLY_MARKER)).length;
}

describe("assistant reply markers", () => {
  test("marks each prose message once, not each paragraph or text block", () => {
    const { component, saved } = setup([prose("First paragraph.\n\nSecond paragraph."), prose("Third paragraph.")]);
    const before = JSON.stringify(saved);
    const output = rows(component);
    expect(markers(component)).toBe(1);
    expect(output.find(line => line.includes("First paragraph"))).toStartWith("⏺ First paragraph");
    expect(output.find(line => line.includes("Second paragraph"))).toStartWith("  Second paragraph");
    expect(output.find(line => line.includes("Third paragraph"))).toStartWith("  Third paragraph");
    expect(JSON.stringify(saved)).toBe(before);
    expect((component as any).lastMessage).toBe(saved);
  });

  test("stream updates never accumulate markers and whitespace does not create a placeholder", () => {
    const { component } = setup([prose(" ")]);
    expect(markers(component)).toBe(0);
    for (const text of ["I", "I am checking", "I am checking.\n\nAll done."]) {
      component.updateContent(message([prose(text)]), true);
      expect(markers(component)).toBe(1);
      component.invalidate();
      expect(markers(component)).toBe(1);
    }
    component.updateContent(message([prose("Finished.")]), false);
    expect(markers(component)).toBe(1);
  });

  test("thinking-only and tool-only messages have no reply marker", () => {
    const call = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } };
    for (const hidden of [false, true]) {
      for (const content of [[thinking("Reasoning")], [call], [thinking("Reasoning"), call]]) {
        const { component } = setup(content, hidden);
        expect(markers(component)).toBe(0);
        expect(rows(component).join("\n").includes("Reasoning")).toBe(!hidden && content.some(part => part.type === "thinking"));
      }
    }
  });

  test("mixed progress/tool messages mark prose while reasoning toggles retain their native presentation", () => {
    const content = [thinking("Reasoning"), prose("Checking files."),
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } }];
    const { component, saved } = setup(content, false);
    expect(markers(component)).toBe(1);
    expect(rows(component).find(line => line.includes("Reasoning"))).not.toContain("⏺");
    component.setHideThinkingBlock(true);
    expect(rows(component).join("\n")).not.toContain("Reasoning");
    expect(markers(component)).toBe(1);
    component.setHideThinkingBlock(false);
    expect(rows(component).join("\n")).toContain("Reasoning");
    expect((component as any).lastMessage).toBe(saved);
  });

  test("wrapped lines align with prose and stay within narrow widths and changed padding", () => {
    const text = "Several words of assistant text that wrap across multiple lines. 文件 and emoji 👋 stay intact.";
    for (const padding of [0, 1, 3]) {
      const { component } = setup([prose(text)], true, padding);
      for (const width of [1, 2, 3, 4, 8, 24, 80]) {
        const output = rows(component, width);
        expect(output.every(line => visibleWidth(line) <= width)).toBe(true);
        if (width > Math.max(padding, visibleWidth(ASSISTANT_REPLY_MARKER) + 1)) {
          expect(markers(component, width)).toBe(1);
          const indentation = " ".repeat(Math.max(padding, visibleWidth(ASSISTANT_REPLY_MARKER) + 1));
          expect(output.filter(line => line.trim() && !line.startsWith(ASSISTANT_REPLY_MARKER)).every(line => line.startsWith(indentation))).toBe(true);
        } else expect(markers(component, width)).toBe(0);
      }
      component.setOutputPad(4);
      expect(rows(component).find(line => line.includes("Several words"))).toStartWith("⏺   Several words");
    }
  });

  test("native Markdown lists, tables and code blocks retain their content", () => {
    const { component } = setup([prose("## Heading\n\n- First item\n- Second item\n\n```ts\nconst value = 1;\n```\n\n| Key | Value |\n| --- | --- |\n| one | two |")]);
    const output = rows(component).join("\n");
    expect(markers(component)).toBe(1);
    for (const value of ["Heading", "First item", "Second item", "const value = 1;", "Key", "two"]) expect(output).toContain(value);
    expect(component.render(30).every(line => visibleWidth(line) <= 30)).toBe(true);
  });

  test("terminal prompt zones and error-only notices stay native", () => {
    const { component } = setup([prose("Completed.")]);
    const raw = component.render(80).join("\n");
    for (const zone of ["\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07"]) expect(raw).toContain(zone);
    component.updateContent(message([], { stopReason: "error", errorMessage: "Provider unavailable" }));
    expect(markers(component)).toBe(0);
    expect(rows(component).join("\n")).toContain("Provider unavailable");
  });

  test("mouse targets below wrapped prose and visible reasoning remain correct", () => {
    const { host, component } = setup([thinking("Reasoning"), prose("A reply long enough to wrap over multiple terminal lines.")], false);
    let clicks = 0;
    host.chatContainer.addChild(new MouseRegion(new Text("NEXT", 0, 0), event => {
      if (event.type === "click") { clicks++; return { handled: true }; }
    }));
    const click = (needle: string, width: number) => {
      const output = rows(host.chatContainer, width);
      const y = output.findIndex(line => line.includes(needle));
      expect(y).toBeGreaterThanOrEqual(0);
      return host.chatContainer.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
        width, height: output.length, shift: false, alt: false, ctrl: false });
    };
    for (const width of [24, 80, 24]) {
      expect(click("NEXT", width)?.handled).toBe(true);
      expect(click("Reasoning", width)?.handled).toBe(true);
      expect(rows(component, width).join("\n")).toContain("Thinking...");
      expect(markers(component, width)).toBe(1);
      expect(click("Thinking...", width)?.handled).toBe(true);
      expect(rows(component, width).join("\n")).toContain("Reasoning");
    }
    expect(clicks).toBe(3);
  });

  test("detach and reattach restore native children and never double-prefix replies", () => {
    const { host, component, controller } = setup([prose("Reply")]);
    expect(markers(component)).toBe(1);
    controller.detach();
    expect(markers(component)).toBe(0);
    const replacement = new ReadGroupingController(host);
    replacement.attach();
    expect(markers(component)).toBe(1);
    component.updateContent(message([prose("Updated reply")]));
    expect(markers(component)).toBe(1);
  });

  test("marker uses the current theme accent at render time", () => {
    let color = 31;
    const theme = { fg: (token: string, value: string) => {
      expect(token).toBe("accent");
      return `\x1b[${color}m${value}\x1b[39m`;
    } } as Theme;
    const { component } = setup([prose("Reply")], true, 1, () => theme);
    expect(component.render(80).join("\n")).toContain("\x1b[31m⏺\x1b[39m");
    color = 32;
    expect(component.render(80).join("\n")).toContain("\x1b[32m⏺\x1b[39m");
    expect(component.render(80).join("\n")).not.toContain("\x1b[31m⏺");
  });

  test("transformed-away blocks and terminal graphics never consume the prose marker", () => {
    const graphics = "\x1b_Ga=T,f=100;image-payload\x1b\\";
    class GraphicsMarkdown extends Markdown { render() { return [graphics]; } }
    const content = new Container();
    content.addChild(new Markdown("Hidden control text", 1, 0, getMarkdownTheme(), undefined, { transform: () => "" }));
    content.addChild(new GraphicsMarkdown("", 0, 0, getMarkdownTheme()));
    content.addChild(new Markdown("Visible reply", 1, 0, getMarkdownTheme()));
    const assistant = { children: [content], contentContainer: content, outputPad: 1 };
    const decoration = decorateAssistantReply(assistant, () => undefined)!;
    const raw = decoration.render(80);
    expect(raw[0]).toBe(graphics);
    expect(rows(decoration).join("\n")).toContain("⏺ Visible reply");
    expect(markers(decoration)).toBe(1);
  });

  test("OSC 8 links keep their URL and move with the displayed text, not the gutter", () => {
    class LinkMarkdown extends Markdown {
      render() { return [" \x1b]8;;https://example.test\x07Link\x1b]8;;\x07 "]; }
    }
    const content = new Container(); content.addChild(new LinkMarkdown("", 1, 0, getMarkdownTheme()));
    const assistant = { children: [content], contentContainer: content, outputPad: 1 };
    const decoration = decorateAssistantReply(assistant, () => undefined)!;
    const line = decoration.render(80)[0];
    expect(stripTerminalSequences(line)).toStartWith("⏺ Link");
    expect(getOsc8LinkAtColumn(line, 2)).toBe("https://example.test");
    expect(getOsc8LinkAtColumn(line, 0)).toBeUndefined();
  });

  test("unsupported host shapes are not changed", () => {
    for (const assistant of [{}, { children: [] }, { contentContainer: {}, children: [] }]) {
      const saved = JSON.stringify(assistant);
      expect(decorateAssistantReply(assistant, () => undefined)).toBeUndefined();
      expect(JSON.stringify(assistant)).toBe(saved);
    }
    const content = new Container();
    const frozen = { contentContainer: content, children: Object.freeze([content]) };
    expect(decorateAssistantReply(frozen, () => undefined)).toBeUndefined();
    expect(frozen.children[0]).toBe(content);
  });
});
