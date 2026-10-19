import { InteractiveMode, UserMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, type Component, type TuiMouseEvent, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { inlineText } from "./components.ts";
import { USER_MESSAGE_MARKER } from "./user-messages.ts";

const PATCH = Symbol.for("pi.codex-tool-renderer.sticky-prompt");
type Method = (this: any, ...args: any[]) => any;

/** Use visible, transformed text rather than exposing hidden raw prompt content. */
export function summarizeUserPrompt(user: UserMessageComponent, width: number): string {
  const parts: string[] = [];
  let length = 0;
  for (const line of user.render(Math.max(1, width))) {
    if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) continue;
    const text = inlineText(line);
    if (!text) continue;
    parts.push(text);
    length += text.length;
    // A single-line preview only needs enough text to fill the available cells.
    if (length > width * 2) break;
  }
  const summary = parts.join(" ");
  return summary.startsWith(`${USER_MESSAGE_MARKER} `) ? summary.slice(2) : summary;
}

export class StickyPromptHeader implements Component {
  private displayedUser?: UserMessageComponent;
  private width = 0;

  constructor(private readonly controller: StickyPromptController, private readonly getTheme: () => Theme | undefined) {}

  invalidate(): void {}

  hasContent(width: number): boolean {
    this.width = width;
    this.displayedUser = this.controller.currentUser(width);
    return !!this.displayedUser && !!summarizeUserPrompt(this.displayedUser, this.controller.contentWidth(width));
  }

  needsRefresh(): boolean {
    return this.width > 0 && this.displayedUser !== this.controller.currentUser(this.width);
  }

  render(width: number): string[] {
    this.width = width;
    this.displayedUser = this.controller.currentUser(width);
    if (width < 1 || !this.displayedUser) return [];
    const summary = summarizeUserPrompt(this.displayedUser, this.controller.contentWidth(width));
    if (!summary) return [];
    const text = width >= 3 ? `${USER_MESSAGE_MARKER} ${summary}` : summary;
    const padding = width >= 2 ? 1 : 0;
    const truncated = stripTerminalSequences(truncateToWidth(text, width - padding, "…"));
    const line = truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
    const theme = this.getTheme();
    return [theme ? theme.style(line, { fg: "muted", bg: "userMessageBg", italic: true }) : line];
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.button !== "left" || event.y !== 0 || !this.displayedUser) return;
    if (event.type === "click") {
      return this.controller.jumpTo(this.displayedUser, this.width) ? { handled: true } : undefined;
    }
    // Claim the press so Pi dispatches a click on release rather than starting a
    // transcript selection. Wheel events still use the native primary viewport.
    if (["press", "release", "drag"].includes(event.type)) return { handled: true };
  }
}

export class StickyPromptController {
  readonly header: StickyPromptHeader;
  private root?: any;
  private entry?: any;
  private scroll?: ScrollView;
  private layoutPatch?: { own?: PropertyDescriptor; original: Method; wrapper: Method };
  private active = true;

  constructor(private readonly mode: any, getTheme: () => Theme | undefined) {
    this.header = new StickyPromptHeader(this, getTheme);
  }

  currentUser(width: number): UserMessageComponent | undefined {
    if (!this.active || !this.scroll || width < 1) return;
    const positions = this.promptPositions(width);
    for (let index = positions.length - 1; index >= 0; index--) {
      const position = positions[index];
      if (position.offset <= this.scroll.scrollTop) {
        // The original first row is visible at this boundary. Do not duplicate
        // it, or fall back to the preceding turn's prompt.
        return position.offset < this.scroll.scrollTop ? position.user : undefined;
      }
    }
  }

  private promptPositions(width: number): Array<{ user: UserMessageComponent; offset: number }> {
    const document = this.mode.documentContainer;
    const chat = this.mode.chatContainer;
    if (!Array.isArray(document?.children) || !Array.isArray(chat?.children) ||
      typeof document.render !== "function" || !document.children.includes(chat)) return [];
    const contentWidth = this.contentWidth(width);
    // Native Container records child heights for mouse routing. Reuse those
    // measurements instead of re-rendering the whole history on every scroll.
    const measured = (container: any) => container.mouseLayout?.width === contentWidth &&
      Array.isArray(container.mouseLayout.children) &&
      container.mouseLayout.children.length === container.children.length &&
      container.mouseLayout.children.every((entry: any, index: number) => entry.component === container.children[index]);
    if (!measured(document) || !measured(chat)) document.render(contentWidth);
    if (!measured(document) || !measured(chat)) return [];
    let offset = 0;
    for (const entry of document.mouseLayout.children) {
      if (entry.component === chat) break;
      offset += entry.height;
    }
    const positions: Array<{ user: UserMessageComponent; offset: number }> = [];
    for (const entry of chat.mouseLayout.children) {
      if (entry.component instanceof UserMessageComponent) positions.push({ user: entry.component, offset });
      offset += entry.height;
    }
    return positions;
  }

  contentWidth(width: number): number {
    return this.scroll?.getContentWidth(width) ?? width;
  }

  attach(): boolean {
    if (!this.active) return false;
    const root = this.mode.fullscreenLayoutRoot;
    const scroll = this.mode.transcriptScrollView;
    if (this.root === root && this.scroll === scroll && root?.entries?.includes(this.entry)) return true;
    if (!(scroll instanceof ScrollView) || !Array.isArray(root?.entries) || !Array.isArray(root?.children) ||
      !Array.isArray(this.mode.documentContainer?.children) ||
      !this.mode.documentContainer.children.includes(this.mode.chatContainer)) return false;
    const entryIndex = root.entries.findIndex((entry: any) => entry.component === scroll);
    const childIndex = root.children.indexOf(scroll);
    if (entryIndex < 0 || childIndex < 0) return false;
    this.removeEntry();
    this.root = root;
    this.scroll = scroll;
    this.entry = {
      component: this.header, basis: 1, minSize: 1, maxSize: 1, shrink: 0,
      visible: (viewport: { width: number; height: number }) => this.active &&
        this.mode.renderer?.mode === "fullscreen" && viewport.height >= 3 &&
        !scroll.isFollowingEnd && this.header.hasContent(viewport.width),
    };
    try {
      root.entries.splice(entryIndex, 0, this.entry);
      root.children.splice(childIndex, 0, this.header);
      const controller = this;
      const original = scroll.updateLayout;
      const wrapper: Method = function (...args) {
        const following = this.isFollowingEnd;
        const result = original.apply(this, args as [number, number, () => void]);
        // Layout can change the scroll position or the owning prompt after the
        // header was evaluated. Settle its visibility/context next frame.
        if (controller.active && controller.scroll === this &&
          (following !== this.isFollowingEnd || (!this.isFollowingEnd && controller.header.needsRefresh()))) args[2]?.();
        return result;
      };
      this.layoutPatch = { own: Object.getOwnPropertyDescriptor(scroll, "updateLayout"), original, wrapper };
      scroll.updateLayout = wrapper;
      this.mode.ui?.requestRender?.();
      return true;
    } catch {
      this.detach();
      return false;
    }
  }

  jumpTo(user: UserMessageComponent, width: number): boolean {
    if (!this.active || !this.scroll || this.mode.renderer?.mode !== "fullscreen") return false;
    const document = this.mode.documentContainer;
    const chat = this.mode.chatContainer;
    if (!document?.children?.includes(chat) || !chat?.children?.includes(user)) return false;
    const contentWidth = this.contentWidth(width);
    // Reconcile grouping and current wrapping before measuring the native rows.
    // Clicks force a fresh pass; ordinary scrolling reuses native measurements.
    document.render(contentWidth);
    const position = this.promptPositions(width).find(position => position.user === user);
    if (!position) return false;
    this.scroll.scrollTo(position.offset, { disableFollow: true });
    this.mode.ui?.requestRender?.();
    return true;
  }

  private removeEntry(): void {
    if (this.scroll && this.layoutPatch && this.scroll.updateLayout === this.layoutPatch.wrapper) {
      if (this.layoutPatch.own) Object.defineProperty(this.scroll, "updateLayout", this.layoutPatch.own);
      else delete (this.scroll as any).updateLayout;
    }
    this.layoutPatch = undefined;
    if (this.root) {
      const index = this.root.entries.indexOf(this.entry);
      if (index >= 0) this.root.entries.splice(index, 1);
      const childIndex = this.root.children.indexOf(this.header);
      if (childIndex >= 0) this.root.children.splice(childIndex, 1);
    }
    this.root = undefined;
    this.scroll = undefined;
    this.entry = undefined;
  }

  detach(): void {
    this.active = false;
    try { this.removeEntry(); } catch { /* A retained entry's visibility predicate is now false. */ }
    this.mode.ui?.requestRender?.();
  }
}

interface PatchState {
  enabled: boolean;
  controllers: Map<any, StickyPromptController>;
  factory: (mode: any) => StickyPromptController;
  getTheme?: () => Theme | undefined;
}

/** Keep Pi's primary ScrollView, dock and input routing; add one layout sibling. */
export function installStickyPrompt(pi: ExtensionAPI): void {
  const prototype = InteractiveMode.prototype as any;
  let state = prototype[PATCH] as PatchState | undefined;
  if (!state) {
    state = { enabled: false, controllers: new Map(), factory: undefined! };
    Object.defineProperty(prototype, PATCH, { value: state });
    const shared = state;
    for (const name of ["mountInteractiveTui", "handleEvent", "renderSessionItems"]) {
      const original = prototype[name] as Method;
      if (typeof original !== "function") continue;
      prototype[name] = function (...args: any[]) {
        if (shared.enabled) {
          try {
            let controller = shared.controllers.get(this);
            if (!controller) {
              controller = shared.factory(this);
              shared.controllers.set(this, controller);
            }
            controller.attach();
          } catch { shared.controllers.get(this)?.detach(); }
        }
        return original.apply(this, args);
      };
    }
  }
  const shared = state;
  for (const controller of shared.controllers.values()) controller.detach();
  shared.controllers.clear();
  shared.enabled = true;
  shared.factory = mode => new StickyPromptController(mode, () => shared.getTheme?.());
  pi.on("session_start", (_event, context) => { shared.getTheme = () => context.ui.theme; });
  pi.on("session_shutdown", () => {
    shared.enabled = false;
    for (const controller of shared.controllers.values()) controller.detach();
    shared.controllers.clear();
    shared.getTheme = undefined;
  });
}
