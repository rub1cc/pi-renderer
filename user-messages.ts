import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export const USER_MESSAGE_MARKER = "❯";
const PATCH = Symbol.for("pi.codex-tool-renderer.user-messages");
const SOURCE = Symbol.for("pi.codex-tool-renderer.user-messages.source");
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Render = (this: any, width: number) => string[];

function isGraphicsRow(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/** Keep the native Markdown styles/transforms; reserve a gutter before wrapping. */
class CompactUserBody implements Component {
  readonly [SOURCE]: Markdown;
  private body: Markdown;
  private text: string;

  constructor(source: Markdown) {
    this[SOURCE] = source;
    const native = source as any;
    this.text = native.text;
    this.body = new Markdown(native.text, 0, 0, native.theme, native.defaultTextStyle, native.options);
  }

  invalidate(): void {
    this[SOURCE].invalidate();
    this.body.invalidate();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const source = this[SOURCE] as any;
    if (source.text !== this.text) {
      this.text = source.text;
      this.body.setText(this.text);
    }
    const rightPadding = width >= 2 ? 1 : 0;
    const gutter = width - rightPadding >= 3 ? 2 : 0;
    const contentWidth = Math.max(1, width - rightPadding - gutter);
    const lines = this.body.render(contentWidth);
    if (!lines.length) return [];
    const first = lines.findIndex(line => !isGraphicsRow(line) && stripTerminalSequences(line).trim());
    const { bgColor, color } = source.defaultTextStyle;
    const margin = " ".repeat(rightPadding);
    const content = lines.map((line, index) => {
      // Never splice gutters or ANSI background resets into image protocols.
      if (isGraphicsRow(line)) return line;
      const marker = gutter && index === first ? `${USER_MESSAGE_MARKER} ` : " ".repeat(gutter);
      return truncateToWidth(bgColor(color(marker)) + line + bgColor(margin), width, "");
    });
    return content;
  }
}

class UserMessageRenderer {
  private readonly views = new WeakMap<object, CompactUserBody>();

  render(component: any, width: number, fallback: Render): string[] {
    if (width < 1) return [];
    const children = component.children;
    if (!Array.isArray(children) || children.length !== 1) return fallback.call(component, width);
    const source = children[0]?.[SOURCE] ?? children[0];
    if (!(source instanceof Markdown)) return fallback.call(component, width);
    const native = source as any;
    if (typeof native.text !== "string" || !native.theme ||
      typeof native.defaultTextStyle?.bgColor !== "function" ||
      typeof native.defaultTextStyle?.color !== "function") return fallback.call(component, width);
    let view = this.views.get(component);
    if (!view || view[SOURCE] !== source) {
      view = new CompactUserBody(source);
      this.views.set(component, view);
    }
    try { children[0] = view; }
    catch { return fallback.call(component, width); }
    // Native zone placement assumes separate padding rows. Without them, keep
    // the start before the first content cell and the end after the last one.
    const lines = fallback.call(component, width);
    if (lines.length === 1 && lines[0].startsWith(ZONE_END + ZONE_START)) {
      lines[0] = ZONE_START + lines[0].slice(ZONE_END.length + ZONE_START.length) + ZONE_END;
    } else if (lines[0]?.startsWith(ZONE_START) && lines.at(-1)?.startsWith(ZONE_END)) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(ZONE_END.length) + ZONE_END;
    }
    return lines;
  }
}

interface UserMessagePatch {
  renderer: UserMessageRenderer;
  original: Render;
  wrapper: Render;
}

/** Private Pi 1.3 component adapter, shared across live rendering and replay. */
export function installCompactUserMessages(): void {
  const prototype = UserMessageComponent.prototype as any;
  let patch = prototype[PATCH] as UserMessagePatch | undefined;
  if (!patch) {
    if (typeof prototype.render !== "function") return;
    patch = {
      renderer: new UserMessageRenderer(),
      original: prototype.render,
      wrapper: function (width) { return patch!.renderer.render(this, width, patch!.original); },
    };
    Object.defineProperty(prototype, PATCH, { value: patch });
  } else {
    // Existing message instances may still contain a body from the old runtime.
    // SOURCE lets a fresh renderer reuse the native Markdown without nesting.
    patch.renderer = new UserMessageRenderer();
  }
  prototype.render = patch.wrapper;
}
