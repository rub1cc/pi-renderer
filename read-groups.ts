import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  AssistantMessageComponent,
  InteractiveMode,
  keyText,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  activityMarker,
  displayPath,
  inlineText,
  sanitizeTerminalText,
  treeOutputPrefix,
} from "./components.ts";

export const READ_GROUP = Symbol.for("pi.codex-tool-renderer.read-group");
const PATCH = Symbol.for("pi.codex-tool-renderer.read-groups.patch");
const CONTROLLER = Symbol.for("pi.codex-tool-renderer.read-groups.controller");
const GENERATION = Symbol.for("pi.codex-tool-renderer.read-groups.generation");
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

type Method = (this: any, ...args: any[]) => any;
interface Segment { length: number; startsMessage: boolean; endsMessage: boolean }
interface Position { segment: Segment; index: number }
interface CallPosition { visible: Position; hidden: Position }
interface MethodPatch {
  original: Method;
  own?: PropertyDescriptor;
  wrapper: Method;
}
interface MemberPatch extends MethodPatch {
  group?: ReadGroupHeader;
}

function isExploration(child: any): boolean {
  if (!(child instanceof ToolExecutionComponent) || !EXPLORATION_TOOLS.has(child.toolName) ||
    typeof child.toolCallId !== "string" || typeof child.render !== "function" ||
    typeof child.setExpanded !== "function" || typeof child.isPartial !== "boolean" ||
    child.args === null || typeof child.args !== "object" || Array.isArray(child.args)) return false;
  const args = child.args;
  if (child.toolName === "read") return typeof args.path === "string" && args.path.trim().length > 0;
  if (args.path !== undefined && typeof args.path !== "string") return false;
  return child.toolName === "ls" || typeof args.pattern === "string";
}

function isAssistant(child: any): boolean {
  return child instanceof AssistantMessageComponent &&
    typeof child.updateContent === "function" && typeof child.hideThinkingBlock === "boolean" &&
    "lastMessage" in child;
}

function isExplorationCall(part: any): boolean {
  return part?.type === "toolCall" && EXPLORATION_TOOLS.has(part.name) && typeof part.id === "string";
}

function normalizedPath(member: any): string {
  // Match Pi's lexical tool-path aliases without doing filesystem I/O.
  let raw = (member.args.path || ".").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (process.platform === "win32" && !raw.startsWith("//") && !raw.includes("\\")) {
    const drive = raw.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) raw = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  let expanded = raw;
  if (raw === "~") expanded = homedir();
  else if (raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"))) {
    expanded = path.join(homedir(), raw.slice(2));
  }
  if (expanded.startsWith("file://")) {
    try { expanded = fileURLToPath(expanded); } catch { /* retain invalid paths for failed-call summaries */ }
  }
  return typeof member.cwd === "string"
    ? path.resolve(member.cwd, expanded) : path.normalize(expanded);
}

function explorationSummary(members: any[], pending: boolean): string {
  const searches = members.filter((member) => member.toolName === "grep" || member.toolName === "find").length;
  const files = new Set(members.filter((member) => member.toolName === "read").map(normalizedPath)).size;
  const directories = new Set(members.filter((member) => member.toolName === "ls").map(normalizedPath)).size;
  const parts: string[] = [];
  if (searches) parts.push(`${pending ? "searching for" : "searched for"} ${searches} pattern${searches === 1 ? "" : "s"}`);
  if (files) parts.push(`${pending ? "reading" : "read"} ${files} file${files === 1 ? "" : "s"}`);
  if (directories) parts.push(`${pending ? "listing" : "listed"} ${directories} director${directories === 1 ? "y" : "ies"}`);
  const text = parts.join(", ");
  const calls = searches + files + directories !== members.length ? ` (${members.length} calls)` : "";
  return text.charAt(0).toUpperCase() + text.slice(1) + calls;
}

function isInterrupted(message: any): boolean {
  return ["aborted", "error", "length"].includes(message?.stopReason);
}

function canJoin(left: Position, right: Position, hidden: boolean): boolean {
  if (left.segment === right.segment) return right.index === left.index + 1;
  return hidden && left.segment.endsMessage && right.segment.startsMessage &&
    left.index === left.segment.length - 1 && right.index === 0;
}

function isPending(member: any): boolean {
  return member.isPartial || !member.result;
}

function liveTarget(member: any): string {
  const root = displayPath(member.args.path || ".", member.cwd ?? "");
  if (member.toolName === "read") return `Reading ${root}`;
  if (member.toolName === "ls") return `Listing ${root}`;
  const pattern = sanitizeTerminalText(member.args.pattern)
    .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return member.toolName === "grep"
    ? `Searching /${pattern}/ in ${root}`
    : `Searching ${JSON.stringify(pattern)} in ${root}`;
}

function detailRows(text: string, width: number, theme: Theme | undefined, tone: "error" | "muted", limit = 1): string[] {
  const prefix = treeOutputPrefix(width);
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const plain = inlineText(text);
  const full = limit === 1 ? [truncateToWidth(plain, contentWidth, "…")]
    : wrapTextWithAnsi(plain, contentWidth);
  const selected = full.slice(0, limit);
  if (full.length > limit) {
    selected[limit - 1] = truncateToWidth(selected[limit - 1], Math.max(0, contentWidth - 1), "") + "…";
  }
  return selected.map((line, index) => {
    const gutter = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
    const row = theme ? theme.fg("muted", gutter) + theme.fg(tone, line) : gutter + line;
    return truncateToWidth(row, width, "…");
  });
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
      if (width < 1) return [];
      const theme = this.controller.getTheme();
      const style = (color: "error" | "toolTitle" | "muted", text: string) => theme ? theme.fg(color, text) : text;
      const failed = this.members.filter((member) => member.result?.isError);
      const pending = this.members.some(isPending);
      const running = this.members.filter((member) => member.executionStarted === true && isPending(member) && !member.result?.isError);
      // Keep the failure count visible even when a long mixed summary is clipped.
      const failureStatus = failed.length ? style("error", `${failed.length} failed`) + style("muted", " · ") : "";
      const marker = activityMarker(failed.length ? "error" : pending ? "active" : "success", theme);
      let text = `${marker} ${failureStatus}${style("toolTitle", explorationSummary(this.members, pending))}`;
      if (pending) text += style("muted", "…");
      const shortcut = keyText("app.tools.expand");
      if (shortcut) text += style("muted", ` (${shortcut} to ${this.expanded ? "collapse" : "expand"} all)`);
      const rows = ["", truncateToWidth(text, width, "…")];
      if (!this.expanded && failed.length) {
        const first = failed[0];
        const error = first.result?.content?.find((part: any) => part?.type === "text");
        const root = displayPath(first.args.path || ".", first.cwd ?? "");
        const subject = first.toolName === "grep" || first.toolName === "find"
          ? `${first.toolName} ${inlineText(first.args.pattern)} in ${root}` : root;
        const target = truncateToWidth(subject, Math.max(8, Math.floor(width / 2)), "…");
        rows.push(...detailRows(`${target}: ${inlineText(error?.text) || "Tool failed"}`, width, theme, "error", 3));
      }
      if (!this.expanded && running.length) {
        const parallel = running.length > 1 ? ` · +${running.length - 1} running` : "";
        rows.push(...detailRows(liveTarget(running[0]) + parallel, width, theme, "muted"));
      }
      return rows;
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
  private assistantPatches = new Map<any, MethodPatch>();
  private groups: ReadGroupHeader[] = [];
  private lastChildren: any[] = [];
  private metadataVersion = 0;
  private reconciledVersion = -1;
  private lastHideThinking = false;
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
    const positions = (skipThinking: boolean): Map<string, Position> => {
      const result = new Map<string, Position>();
      let segment: Segment | undefined;
      let startsMessage = !isInterrupted(message);
      for (const part of message.content) {
        if (skipThinking && part?.type === "thinking") continue;
        if (!isExplorationCall(part)) {
          segment = undefined;
          startsMessage = false;
          continue;
        }
        if (!segment) segment = { length: 0, startsMessage, endsMessage: false };
        result.set(part.id, { segment, index: segment.length++ });
      }
      if (segment) segment.endsMessage = !isInterrupted(message);
      return result;
    };
    const visible = positions(false);
    const hidden = positions(true);
    for (const part of message.content) {
      if (isExplorationCall(part)) {
        this.positions.set(part.id, { visible: visible.get(part.id)!, hidden: hidden.get(part.id)! });
      } else if (typeof part?.id === "string") this.positions.delete(part.id);
    }
  }

  recordItems(items: any[]): void {
    if (!Array.isArray(items)) return;
    // Pi also appends replay batches during compaction; only discard calls
    // removed from the transcript, not metadata for an earlier retained batch.
    const retained = new Set((this.container?.children ?? [])
      .filter((child: any) => child instanceof ToolExecutionComponent)
      .map((child: any) => child.toolCallId));
    for (const id of this.positions.keys()) {
      if (!retained.has(id)) this.positions.delete(id);
    }
    this.metadataVersion++;
    // Current Pi passes context messages directly; tolerate session-entry wrappers.
    for (const item of items) this.recordMessage(item?.type === "message" ? item.message : item);
  }

  private patchAssistant(child: any): void {
    if (!isAssistant(child) || this.assistantPatches.has(child)) return;
    const original = child.updateContent;
    const controller = this;
    const wrapper: Method = function (message, ...args) {
      if (controller.disabled || !controller.assistantPatches.has(this)) {
        return original.call(this, message, ...args);
      }
      // Project only the UI input; retain the real message for toggles and replay.
      const projected = this.hideThinkingBlock && Array.isArray(message?.content)
        ? { ...message, content: message.content.filter((part: any) => part?.type !== "thinking") }
        : message;
      try {
        return original.call(this, projected, ...args);
      } finally {
        this.lastMessage = message;
        controller.metadataVersion++;
      }
    };
    this.assistantPatches.set(child, {
      original, own: Object.getOwnPropertyDescriptor(child, "updateContent"), wrapper,
    });
    child.updateContent = wrapper;
    if (child.lastMessage) child.updateContent(child.lastMessage);
  }

  private isHiddenAssistant(child: any): boolean {
    const message = child?.lastMessage;
    return this.assistantPatches.has(child) && child.hideThinkingBlock === true &&
      message?.role === "assistant" && Array.isArray(message.content) && !isInterrupted(message) &&
      message.content.every((part: any) => part?.type === "thinking" || isExplorationCall(part));
  }

  reconcile(): void {
    if (this.disabled || !this.container) return;
    try {
      const current = this.container.children;
      const hidden = this.mode.hideThinkingBlock === true;
      if (this.reconciledVersion === this.metadataVersion &&
        this.lastHideThinking === hidden &&
        current.length === this.lastChildren.length &&
        current.every((child: any, index: number) => child === this.lastChildren[index])) return;
      const children = this.container.children.filter((child: any) => child?.[READ_GROUP] !== this);
      const present = new Set(children);
      for (const [child, patch] of this.assistantPatches) {
        if (!present.has(child)) {
          this.restore(child, "updateContent", patch);
          this.assistantPatches.delete(child);
        }
      }
      for (const child of children) this.patchAssistant(child);
      const previousGroups = new Map(this.groups.map((group) => [group.members[0], group]));
      const next: any[] = [];
      const groups: ReadGroupHeader[] = [];
      const active = new Set<any>();
      const positionOf = (child: any) => isExploration(child)
        ? this.positions.get(child.toolCallId)?.[hidden ? "hidden" : "visible"] : undefined;
      for (let i = 0; i < children.length;) {
        const first = children[i];
        let position = positionOf(first);
        const members = [first];
        let end = i + 1;
        if (position) {
          for (let j = i + 1; j < children.length; j++) {
            const child = children[j];
            if (hidden && this.isHiddenAssistant(child)) continue;
            const candidate = positionOf(child);
            if (!candidate || !canJoin(position, candidate, hidden)) break;
            members.push(child);
            position = candidate;
            end = j + 1;
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
        next.push(...children.slice(i, end));
        i = end;
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
      this.lastHideThinking = hidden;
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
    for (const [child, patch] of this.assistantPatches) {
      try {
        this.restore(child, "updateContent", patch);
        if (child.lastMessage) child.updateContent(child.lastMessage);
      } catch { /* unsupported assistant component */ }
    }
    this.assistantPatches.clear();
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
