import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type Component, type TuiMouseEvent,
  sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const ASSISTANT_REPLY_MARKER = "⏺";

interface ReplyFrame {
  active: boolean;
  marked: boolean;
  getTheme: () => Theme | undefined;
}

function isGraphicsRow(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/** Prefix prose only; reasoning regions and status notices keep native behavior. */
class ReplyProse implements Component {
  constructor(readonly child: Markdown, readonly frame: ReplyFrame, private readonly padding: number) {}

  render(width: number): string[] {
    if (width < 1) return [];
    const markerWidth = visibleWidth(ASSISTANT_REPLY_MARKER);
    const textColumn = Math.max(this.padding, markerWidth + 1);
    if (!this.frame.active) return this.child.render(width);
    if (width <= textColumn) {
      // Prefer readable content to an orphan marker when the gutter cannot fit.
      return this.child.render(width + this.padding * 2).map(line => isGraphicsRow(line) ? line
        : truncateToWidth(sliceByColumn(line, this.padding, width, true), width, "…"));
    }

    // Reuse the native left margin rather than adding a second gap after it.
    const extraWidth = textColumn - this.padding;
    const bodyWidth = width - extraWidth;
    const lines = this.child.render(bodyWidth);
    const firstText = lines.findIndex(line => !isGraphicsRow(line) && visibleWidth(stripTerminalSequences(line).trim()) > 0);
    const mark = firstText >= 0 && !this.frame.marked;
    if (mark) this.frame.marked = true;
    const theme = this.frame.getTheme();
    const marker = theme ? theme.fg("accent", ASSISTANT_REPLY_MARKER) : ASSISTANT_REPLY_MARKER;
    return lines.map((line, index) => {
      if (isGraphicsRow(line)) return line;
      const prefix = mark && index === firstText
        ? marker + " ".repeat(textColumn - markerWidth) : " ".repeat(textColumn);
      const body = sliceByColumn(line, this.padding, width - textColumn, true);
      return truncateToWidth(prefix + body, width, "…");
    });
  }

  invalidate(): void { this.child.invalidate(); }
}

/** Keep the real content container, its mouse layout and OSC zones owned by Pi. */
export class AssistantReplyDecoration implements Component {
  private readonly frame: ReplyFrame;

  constructor(private readonly assistant: any, private readonly content: Container, getTheme: () => Theme | undefined) {
    this.frame = { active: true, marked: false, getTheme };
  }

  refresh(): void {
    if (!this.frame.active) return;
    const padding = typeof this.assistant.outputPad === "number" && Number.isFinite(this.assistant.outputPad)
      ? Math.max(0, Math.floor(this.assistant.outputPad)) : 1;
    this.content.children = this.content.children.map(child => child instanceof Markdown
      ? new ReplyProse(child, this.frame, padding) : child);
  }

  render(width: number): string[] {
    this.frame.marked = false;
    return width < 1 ? [] : this.content.render(width);
  }

  handleMouse(event: TuiMouseEvent) {
    this.frame.marked = false;
    return this.content.handleMouse(event);
  }

  invalidate(): void { this.content.invalidate(); }

  restore(): void {
    this.frame.active = false;
    const index = this.assistant.children.indexOf(this);
    if (index >= 0) this.assistant.children[index] = this.content;
    this.content.children = this.content.children.map(child => child instanceof ReplyProse && child.frame === this.frame
      ? child.child : child);
  }
}

/** Guarded instance-only adapter; unsupported host shapes retain native output. */
export function decorateAssistantReply(assistant: any, getTheme: () => Theme | undefined): AssistantReplyDecoration | undefined {
  const content = assistant.contentContainer;
  if (!(content instanceof Container) || !Array.isArray(content.children) || !Array.isArray(assistant.children)) return;
  const index = assistant.children.indexOf(content);
  if (index < 0) return;
  const decoration = new AssistantReplyDecoration(assistant, content, getTheme);
  try {
    assistant.children[index] = decoration;
    decoration.refresh();
    return decoration;
  } catch {
    try { decoration.restore(); } catch { /* unsupported host shape; adapter is disabled */ }
    return undefined;
  }
}
