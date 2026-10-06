import path from "node:path";
import { homedir } from "node:os";
import {
  InteractiveMode,
  keyText,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { displayPath, inlineText } from "./components.ts";

export const READ_GROUP = Symbol.for("pi.codex-tool-renderer.read-group");
const PATCH = Symbol.for("pi.codex-tool-renderer.read-groups.patch");
const CONTROLLER = Symbol.for("pi.codex-tool-renderer.read-groups.controller");
const GENERATION = Symbol.for("pi.codex-tool-renderer.read-groups.generation");

type Method = (this: any, ...args: any[]) => any;
interface CallPosition { segment: object; index: number }
interface MemberPatch {
  original: Method;
  own?: PropertyDescriptor;
  wrapper: Method;
  group?: ReadGroupHeader;
}

function isRead(child: any): boolean {
  return child instanceof ToolExecutionComponent && child.toolName === "read" &&
    typeof child.toolCallId === "string" && typeof child.render === "function" &&
    typeof child.setExpanded === "function" && typeof child.isPartial === "boolean" &&
    child.args !== null && typeof child.args === "object" &&
    typeof child.args.path === "string" && child.args.path.trim().length > 0;
}

/** A decoration only: members always remain direct children of Pi's container. */
export class ReadGroupHeader {
  readonly [READ_GROUP]: ReadGroupingController;
  expanded: boolean;

  constructor(
    readonly controller: ReadGroupingController,
    public members: any[],
    expanded: boolean,
  ) {
    this[READ_GROUP] = controller;
    this.expanded = expanded;
  }

  setExpanded(expanded: boolean): void { this.expanded = expanded; }
  invalidate(): void {}

  handleMouse(event: any): { handled: boolean } | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 1) return;
    this.expanded = !this.expanded;
    this.controller.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    try {
      const paths = new Set(this.members.map((member) => {
        const raw = member.args.path;
        const expanded = raw === "~" ? homedir() : raw.startsWith("~/")
          ? path.join(homedir(), raw.slice(2)) : raw;
        return typeof member.cwd === "string"
          ? path.resolve(member.cwd, expanded) : path.normalize(expanded);
      }));
      const failed = this.members.filter((member) => member.result?.isError);
      const pending = this.members.filter((member) => member.isPartial || !member.result).length;
      const count = paths.size;
      let text = `${this.expanded ? "▾" : "▸"} ${pending ? "Reading" : "Read"} ${count} file${count === 1 ? "" : "s"}`;
      if (count !== this.members.length) text += ` (${this.members.length} calls)`;
      if (pending) text += ` · ${pending} pending`;
      if (failed.length) text += ` · ${failed.length} failed`;
      if (!this.expanded && failed.length) {
        const first = failed[0];
        const error = first.result?.content?.find((part: any) => part?.type === "text");
        text += ` · ${displayPath(first.args.path, first.cwd ?? "")}: ${inlineText(error?.text) || "Read failed"}`;
      }
      const shortcut = keyText("app.tools.expand");
      if (shortcut) text += ` (${shortcut} to ${this.expanded ? "collapse" : "expand"} all)`;
      const theme = this.controller.getTheme();
      text = truncateToWidth(text, Math.max(0, width), "…");
      return ["", theme ? theme.fg(failed.length ? "error" : pending ? "warning" : "muted", text) : text];
    } catch {
      // Only decoration failures are contained; member/host render errors escape.
      this.controller.detach();
      return [];
    }
  }
}

export class ReadGroupingController {
  private positions = new Map<string, CallPosition>();
  private patches = new Map<any, MemberPatch>();
  private groups: ReadGroupHeader[] = [];
  private lastChildren: any[] = [];
  private metadataVersion = 0;
  private reconciledVersion = -1;
  private container: any;
  private hooks: { name: string; original: Method; own?: PropertyDescriptor; wrapper: Method }[] = [];
  private disabled = false;

  constructor(private readonly mode: any, readonly getTheme: () => Theme | undefined = () => undefined) {}

  requestRender(): void { this.mode.ui?.requestRender?.(); }

  attach(): boolean {
    if (this.disabled) return false;
    if (this.container && this.container === this.mode.chatContainer) return true;
    if (this.container) this.detach();
    this.disabled = false;
    const container = this.mode.chatContainer;
    if (!container || !Array.isArray(container.children) ||
      typeof container.addChild !== "function" || typeof container.render !== "function") return false;
    this.container = container;
    try {
      for (const name of ["addChild", "render"]) {
        const original = container[name] as Method;
        const controller = this;
        const wrapper: Method = function (...args) {
          if (name === "render") controller.reconcile();
          // Deliberately outside a catch: preserve host return values and errors.
          const result = original.apply(this, args);
          if (name === "addChild") controller.reconcile();
          return result;
        };
        this.hooks.push({ name, original, own: Object.getOwnPropertyDescriptor(container, name), wrapper });
        container[name] = wrapper;
      }
      this.reconcile();
      return !this.disabled;
    } catch {
      this.detach();
      return false;
    }
  }

  /** Call before host processing, while content still describes the call order. */
  recordMessage(message: any): void {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    this.metadataVersion++;
    let segment: object | undefined;
    let index = 0;
    for (const part of message.content) {
      if (part?.type !== "toolCall" || part.name !== "read" || typeof part.id !== "string") {
        segment = undefined;
        if (typeof part?.id === "string") this.positions.delete(part.id);
        continue;
      }
      if (!segment) { segment = {}; index = 0; }
      this.positions.set(part.id, { segment, index: index++ });
    }
  }

  recordItems(items: any[]): void {
    if (!Array.isArray(items)) return;
    // Current Pi passes context messages directly; tolerate session-entry wrappers.
    for (const item of items) this.recordMessage(item?.type === "message" ? item.message : item);
  }

  reconcile(): void {
    if (this.disabled || !this.container) return;
    try {
      const current = this.container.children;
      if (this.reconciledVersion === this.metadataVersion &&
        current.length === this.lastChildren.length &&
        current.every((child: any, index: number) => child === this.lastChildren[index])) return;
      const children = this.container.children.filter((child: any) => child?.[READ_GROUP] !== this);
      const previousGroups = new Map(this.groups.map((group) => [group.members[0], group]));
      const next: any[] = [];
      const groups: ReadGroupHeader[] = [];
      const active = new Set<any>();
      for (let i = 0; i < children.length;) {
        const first = children[i];
        const position = isRead(first) ? this.positions.get(first.toolCallId) : undefined;
        const members = [first];
        if (position) {
          for (let j = i + 1; j < children.length; j++) {
            const child = children[j];
            const candidate = isRead(child) ? this.positions.get(child.toolCallId) : undefined;
            if (!candidate || candidate.segment !== position.segment ||
              candidate.index !== position.index + members.length) break;
            members.push(child);
          }
        }
        if (members.length >= 2) {
          const group = previousGroups.get(first) ??
            new ReadGroupHeader(this, members, this.mode.toolOutputExpanded === true);
          group.members = members;
          groups.push(group);
          next.push(group);
          for (const member of members) {
            active.add(member);
            let patch = this.patches.get(member);
            if (!patch) {
              const original = member.render;
              patch = { original, own: Object.getOwnPropertyDescriptor(member, "render"), wrapper: undefined! };
              const state = patch;
              patch.wrapper = function (...args: any[]) {
                return state.group && !state.group.expanded ? [] : original.apply(this, args);
              };
              this.patches.set(member, patch);
              member.render = patch.wrapper;
            }
            patch.group = group;
          }
        }
        next.push(...members);
        i += members.length;
      }
      for (const [member, patch] of this.patches) {
        if (!active.has(member)) {
          this.restore(member, "render", patch);
          patch.group = undefined;
          this.patches.delete(member);
        }
      }
      this.groups = groups;
      // Avoid changing array identity while the host iterates over its children.
      this.container.children.splice(0, this.container.children.length, ...next);
      this.lastChildren = [...next];
      this.reconciledVersion = this.metadataVersion;
    } catch {
      this.detach();
    }
  }

  private restore(target: any, name: string, patch: { wrapper: Method; own?: PropertyDescriptor }): void {
    if (target[name] !== patch.wrapper) return;
    if (patch.own) Object.defineProperty(target, name, patch.own);
    else delete target[name];
  }

  /** Fail open permanently for this controller after an unsupported integration. */
  detach(): void {
    this.disabled = true;
    for (const [member, patch] of this.patches) {
      patch.group = undefined;
      try { this.restore(member, "render", patch); } catch { /* wrapper now passes through */ }
    }
    this.patches.clear();
    if (this.container) {
      try {
        this.container.children = this.container.children.filter((child: any) => child?.[READ_GROUP] !== this);
      } catch { /* unsupported host container */ }
      for (const hook of this.hooks) {
        try { this.restore(this.container, hook.name, hook); } catch { /* disabled pass-through */ }
      }
    }
    this.groups = [];
    this.lastChildren = [];
    this.hooks = [];
    this.container = undefined;
  }
}

interface PatchState {
  factory: (mode: any) => ReadGroupingController;
  getTheme?: () => Theme | undefined;
  generation: number;
}

/** Private, version-sensitive hooks: never patch Container.prototype. */
export function installReadGrouping(pi: ExtensionAPI): void {
  const prototype = InteractiveMode.prototype as any;
  let state = prototype[PATCH] as PatchState | undefined;
  if (!state) {
    state = { factory: undefined!, generation: 0 };
    Object.defineProperty(prototype, PATCH, { value: state });
    const shared = state;
    for (const name of ["handleEvent", "renderSessionItems"]) {
      const original = prototype[name];
      if (typeof original !== "function") continue;
      prototype[name] = function (...args: any[]) {
        let controller: ReadGroupingController | undefined;
        try {
          // /reload keeps the mode but replaces the extension runtime. Restore
          // old visibility wrappers before the new controller rebuilds groups.
          if (!this[CONTROLLER] || this[GENERATION] !== shared.generation) {
            this[CONTROLLER]?.detach();
            this[CONTROLLER] = shared.factory(this);
            this[GENERATION] = shared.generation;
          }
          controller = this[CONTROLLER] as ReadGroupingController;
          if (controller.attach()) {
            if (name === "renderSessionItems") controller.recordItems(args[0]);
            else if (["message_start", "message_update", "message_end"].includes(args[0]?.type))
              controller.recordMessage(args[0].message);
          }
        } catch { controller?.detach(); }
        return original.apply(this, args);
      };
    }
  }
  const shared = state;
  state.generation = (state.generation ?? 0) + 1;
  state.factory = (mode) => new ReadGroupingController(mode, () => shared.getTheme?.());
  pi.on("session_start", (_event, context) => { shared.getTheme = () => context.ui.theme; });
}
