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
  getTextOutput,
  inlineText,
  sanitizeTerminalText,
  treeOutputPrefix,
} from "./components.ts";
import {
  activityFailed,
  activityFailureText,
  activityGroupKind,
  activityGroupSummary,
  activityTarget,
  FILE_EXPLORATION_TOOLS,
  TASK_TOOLS,
  preparingActivityKind,
  type ActivityGroupKind,
} from "./group-model.ts";
import { decorateAssistantReply, type AssistantReplyDecoration } from "./assistant-replies.ts";

export const READ_GROUP = Symbol.for("pi.codex-tool-renderer.read-group");
const PATCH = Symbol.for("pi.codex-tool-renderer.read-groups.patch.v2");
const LEGACY_PATCH = Symbol.for("pi.codex-tool-renderer.read-groups.patch");
const LEGACY_CONTROLLER = Symbol.for("pi.codex-tool-renderer.read-groups.controller");

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
interface AssistantPatch extends MethodPatch {
  reply?: AssistantReplyDecoration;
}

function isTaskPart(part: any): boolean {
  return part?.type === "toolCall" && TASK_TOOLS.has(part.name);
}

function isTaskComponent(child: any): boolean {
  return child instanceof ToolExecutionComponent && TASK_TOOLS.has((child as any).toolName);
}

function hiddenTask(child: any): boolean {
  return isTaskComponent(child) && !activityFailed(child) &&
    !child.result?.content?.some((part: any) => part?.type === "image");
}

function memberKind(child: any): ActivityGroupKind | undefined {
  if (!(child instanceof ToolExecutionComponent)) return;
  if (isTaskComponent(child)) return;
  const member: any = child;
  if (typeof member.toolCallId !== "string" || typeof member.render !== "function" ||
    typeof member.setExpanded !== "function" || typeof member.isPartial !== "boolean") return;
  const kind = activityGroupKind(member.toolName, member.args);
  // File images expand with their original read component; other image-producing
  // tools stay standalone so screenshots and web artifacts remain visible.
  if (member.toolName !== "read" && member.result?.content?.some((part: any) => part?.type === "image")) return;
  return kind;
}

function isAssistant(child: any): boolean {
  const candidate: any = child;
  return child instanceof AssistantMessageComponent &&
    typeof child.updateContent === "function" && typeof candidate.hideThinkingBlock === "boolean" &&
    "lastMessage" in child;
}

function isGroupableCall(part: any): boolean {
  return part?.type === "toolCall" && typeof part.id === "string" &&
    (preparingActivityKind(part.name) !== undefined || activityGroupKind(part.name, part.arguments) !== undefined);
}

function isEmptyText(part: any): boolean {
  return part?.type === "text" && typeof part.text === "string" && !part.text.trim();
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
  const commands = members.filter((member) => member.toolName === "bash").length;
  const parts: string[] = [];
  if (searches) parts.push(`${pending ? "searching for" : "searched for"} ${searches} pattern${searches === 1 ? "" : "s"}`);
  if (files) parts.push(`${pending ? "reading" : "read"} ${files} file${files === 1 ? "" : "s"}`);
  if (directories) parts.push(`${pending ? "listing" : "listed"} ${directories} director${directories === 1 ? "y" : "ies"}`);
  if (commands) parts.push(`${pending ? "running" : "ran"} ${commands} shell command${commands === 1 ? "" : "s"}`);
  const text = parts.join(", ");
  const calls = searches + files + directories + commands !== members.length ? ` (${members.length} calls)` : "";
  return text.charAt(0).toUpperCase() + text.slice(1) + calls;
}

function isInterrupted(message: any): boolean {
  return ["aborted", "error", "length"].includes(message?.stopReason);
}

function canJoin(left: Position, right: Position): boolean {
  if (left.segment === right.segment) return right.index === left.index + 1;
  return left.segment.endsMessage && right.segment.startsMessage &&
    left.index === left.segment.length - 1 && right.index === 0;
}

function isPending(member: any): boolean {
  return member.isPartial || !member.result;
}

function liveTarget(member: any): string {
  if (member.toolName === "bash") return `$ ${inlineText(member.args.command)}`;
  if (!FILE_EXPLORATION_TOOLS.has(member.toolName)) return activityTarget(member);
  const root = displayPath(member.args.path || ".", member.cwd ?? "");
  if (member.toolName === "read") return `Reading ${root}`;
  if (member.toolName === "ls") return `Listing ${root}`;
  const pattern = sanitizeTerminalText(member.args.pattern)
    .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return member.toolName === "grep"
    ? `Searching /${pattern}/ in ${root}`
    : `Searching ${JSON.stringify(pattern)} in ${root}`;
}

function groupSummary(members: any[], pending: boolean): string {
  const kinds = [...new Set(members.map(member => activityGroupKind(member.toolName, member.args)).filter(Boolean))];
  return kinds.map(kind => {
    const category = members.filter(member => activityGroupKind(member.toolName, member.args) === kind);
    return kind === "files" ? explorationSummary(category, pending) : activityGroupSummary(kind!, category);
  }).join(" · ");
}

function previewTitle(member: any): string {
  if (member.toolName === "read") return `Reading ${inlineText(path.basename(normalizedPath(member))) || "file"}`;
  if (member.toolName === "bash") return `Running ${inlineText(member.args.command)}`;
  return liveTarget(member);
}

function previewDetail(member: any, width: number, theme?: Theme): string[] {
  if (member.toolName === "read") return detailRows(normalizedPath(member), width, theme, "muted");
  const output = member.result ? getTextOutput(member.result) : "";
  if (!output.trim()) {
    const fallback = member.toolName === "ls" || member.toolName === "grep" || member.toolName === "find"
      ? normalizedPath(member) : "No output";
    return detailRows(fallback, width, theme, "muted");
  }
  const prefix = treeOutputPrefix(width);
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const lines = sanitizeTerminalText(output).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").trimEnd().split("\n");
  const visual = lines.flatMap(line => wrapTextWithAnsi(line, contentWidth));
  const selected = member.toolName === "bash" ? visual.slice(-3) : visual.slice(0, 3);
  return selected.map((line, index) => {
    const gutter = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
    const row = theme ? theme.fg("muted", gutter) + theme.fg(activityFailed(member) ? "error" : "muted", line) : gutter + line;
    return truncateToWidth(row, width, "…");
  });
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
    readonly kind: ActivityGroupKind,
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
      const style = (color: "error" | "accent" | "toolTitle" | "muted", text: string) => theme ? theme.fg(color, text) : text;
      const failed = this.members.filter(activityFailed);
      const live = this.controller.isLiveGroup(this.members);
      const pending = this.members.some(isPending);
      const running = this.members.filter((member) => member.executionStarted === true && isPending(member) && !activityFailed(member));
      // Keep the failure count visible even when a long mixed summary is clipped.
      const failureStatus = failed.length ? style("error", `${failed.length} failed`) + style("muted", " · ") : "";
      const marker = activityMarker(failed.length ? "error" : pending ? "active" : "success", theme);
      const preview = live ? this.controller.previewMember(this.members) : undefined;
      // Do not replace the last useful preview with an incomplete call header.
      if (live && !preview) return [];
      const summary = live ? "" : groupSummary(this.members, pending);
      let text = live ? `  ${style("toolTitle", previewTitle(preview))}` : pending || failed.length
        ? `${marker} ${failureStatus}${style(pending ? "accent" : "muted", summary)}`
        : `  ${style("muted", summary)}`;
      if (!live && pending) text += style("muted", "…");
      const shortcut = keyText("app.tools.expand");
      if (shortcut && (this.expanded || failed.length)) {
        text += style("muted", ` (${shortcut} to ${this.expanded ? "collapse" : "expand"} all)`);
      }
      const rows = ["", truncateToWidth(text, width, "…")];
      if (live && !this.expanded) rows.push(...previewDetail(preview, width, theme));
      if (!this.expanded && failed.length) {
        if (live) rows.push(...detailRows(`${failed.length} failed`, width, theme, "error"));
        const first = failed[0];
        const root = displayPath(first.args.path || ".", first.cwd ?? "");
        const subject = first.toolName === "bash" ? liveTarget(first) : activityGroupKind(first.toolName, first.args) !== "files" ? activityTarget(first) :
          first.toolName === "grep" || first.toolName === "find"
            ? `${first.toolName} ${inlineText(first.args.pattern)} in ${root}` : root;
        const target = truncateToWidth(subject, Math.max(8, Math.floor(width / 2)), "…");
        rows.push(...detailRows(`${target}: ${inlineText(activityFailureText(first)) || "Tool failed"}`, width, theme, "error", 3));
      }
      if (!live && !this.expanded && running.length) {
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
  private assistantPatches = new Map<any, AssistantPatch>();
  private groups: ReadGroupHeader[] = [];
  private lastChildren: any[] = [];
  private lastKinds: Array<ActivityGroupKind | "hidden-task" | undefined> = [];
  private metadataVersion = 0;
  private reconciledVersion = -1;
  private lastHideThinking = false;
  private container: any;
  private hooks: { name: string; original: Method; own?: PropertyDescriptor; wrapper: Method }[] = [];
  private disabled = false;
  private runActive = false;
  private openCallId?: string;
  private liveCalls = new Set<string>();
  private starts = new Map<string, number>();
  private startSequence = 0;
  private renderedCallIds = new Set<string>();

  constructor(private readonly mode: any, readonly getTheme: () => Theme | undefined = () => undefined) {}

  requestRender(): void { this.mode.ui?.requestRender?.(); }

  isLiveGroup(members: any[]): boolean {
    if (!members.some(member => member.toolCallId === this.openCallId)) return false;
    const children = this.container?.children ?? [];
    const last = children.indexOf(members[members.length - 1]);
    const kind = this.kindOf(members[0]);
    if (last < 0 || !kind) return false;
    // Entry renderers decide visibility inside the host, after event delivery.
    // Observe their actual components rather than guessing from entry metadata.
    return children.slice(last + 1).every((child: any) =>
      child?.[READ_GROUP] === this || hiddenTask(child) || this.isHiddenAssistant(child));
  }

  previewMember(members: any[]): any | undefined {
    const usable = members.filter(member => activityGroupKind(member.toolName, member.args) &&
      (member.argsComplete || member.executionStarted || member.result));
    const started = usable.filter(member => member.executionStarted || member.result);
    return started.length ? started.reduce((last, member) =>
      (this.starts.get(member.toolCallId) ?? 0) >= (this.starts.get(last.toolCallId) ?? 0) ? member : last)
      : usable[0];
  }

  private kindOf(child: any): ActivityGroupKind | undefined {
    if (isTaskComponent(child)) return;
    const kind = memberKind(child);
    if (kind || !(child instanceof ToolExecutionComponent)) return kind;
    const member: any = child;
    if (this.runActive && this.liveCalls.has(member.toolCallId) && !member.argsComplete && !member.result) {
      return preparingActivityKind(member.toolName);
    }
  }

  private signatureOf(child: any): ActivityGroupKind | "hidden-task" | undefined {
    return hiddenTask(child) ? "hidden-task" : this.kindOf(child);
  }

  private patchMember(member: any): MemberPatch {
    let patch = this.patches.get(member);
    if (patch) return patch;
    const original = member.render;
    patch = { original, own: Object.getOwnPropertyDescriptor(member, "render"), wrapper: undefined! };
    const state = patch;
    const controller = this;
    patch.wrapper = function (...args: any[]) {
      if (controller.disabled || !controller.patches.has(this)) return original.apply(this, args);
      if (hiddenTask(this) || (state.group && !state.group.expanded)) return [];
      const rows = original.apply(this, args);
      if (isTaskComponent(this) && activityFailed(this) && !getTextOutput(this.result).trim() && args[0] > 0) {
        return [...rows, ...detailRows(activityFailureText(this), args[0], controller.getTheme(), "error",
          this.expanded ? Number.MAX_SAFE_INTEGER : 3)];
      }
      return rows;
    };
    this.patches.set(member, patch);
    member.render = patch.wrapper;
    return patch;
  }

  /** Run state is deliberately separate from persisted message/order metadata. */
  recordEvent(event: any): void {
    if (event.type === "agent_start") {
      this.runActive = true;
      this.openCallId = undefined;
      this.liveCalls.clear();
      this.starts.clear();
      this.startSequence = 0;
      this.metadataVersion++;
      return;
    }
    if (event.type === "agent_end") {
      this.runActive = false;
      this.liveCalls.clear();
      this.metadataVersion++;
      return;
    }
    if (!this.runActive) return;
    const previousOpen = this.openCallId;
    const previousCalls = this.liveCalls.size;
    if (["message_start", "message_update", "message_end"].includes(event.type)) {
      const message = event.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isTaskPart(part)) continue;
          if (isEmptyText(part) || (part?.type === "thinking" && this.mode.hideThinkingBlock === true)) continue;
          if (isGroupableCall(part)) {
            this.liveCalls.add(part.id);
            this.openCallId = part.id;
          } else this.openCallId = undefined;
        }
        if (isInterrupted(message)) this.openCallId = undefined;
      } else if (message?.role === "user" || (message?.role === "custom" && message.display === true)) {
        this.openCallId = undefined;
      }
    } else if (event.type === "tool_execution_start" && !event.parentToolCallId) {
      this.starts.set(event.toolCallId, ++this.startSequence);
    } else if (event.type === "entry_appended" && event.entry?.type === "custom_message" && event.entry.display) {
      this.openCallId = undefined;
    }
    if (previousOpen !== this.openCallId || previousCalls !== this.liveCalls.size) this.metadataVersion++;
  }

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
        if (isTaskPart(part)) continue;
        if (isEmptyText(part)) continue;
        if (skipThinking && part?.type === "thinking") continue;
        if (!isGroupableCall(part)) {
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
      if (isTaskPart(part)) {
        this.positions.delete(part.id);
        continue;
      }
      if (isGroupableCall(part)) {
        this.positions.set(part.id, { visible: visible.get(part.id)!, hidden: hidden.get(part.id)! });
      } else if (typeof part?.id === "string") this.positions.delete(part.id);
    }
  }

  recordItems(items: any[]): void {
    if (!Array.isArray(items)) return;
    this.openCallId = undefined;
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
    const reply = decorateAssistantReply(child, () => controller.getTheme());
    const wrapper: Method = function (message, ...args) {
      if (controller.disabled || !controller.assistantPatches.has(this)) {
        return original.call(this, message, ...args);
      }
      // Project only the UI input; retain the real message for toggles and replay.
      const projected = this.hideThinkingBlock && Array.isArray(message?.content)
        ? { ...message, content: message.content.filter((part: any) => part?.type !== "thinking") }
        : message;
      try {
        const result = original.call(this, projected, ...args);
        reply?.refresh();
        return result;
      } finally {
        this.lastMessage = message;
        controller.metadataVersion++;
      }
    };
    this.assistantPatches.set(child, {
      original, own: Object.getOwnPropertyDescriptor(child, "updateContent"), wrapper, reply,
    });
    child.updateContent = wrapper;
    if (child.lastMessage) child.updateContent(child.lastMessage);
  }

  private isHiddenAssistant(child: any): boolean {
    const message = child?.lastMessage;
    const hidden = this.assistantPatches.has(child) &&
      message?.role === "assistant" && Array.isArray(message.content) && !isInterrupted(message) &&
      message.content.every((part: any) =>
        isTaskPart(part) || isEmptyText(part) || (part?.type === "thinking" && child.hideThinkingBlock === true) || isGroupableCall(part));
    if (!hidden) return false;
    // Missing calls still form boundaries; hidden messages cannot erase them.
    return message.content.every((part: any) => isTaskPart(part) || part?.type !== "toolCall" || this.renderedCallIds.has(part.id));
  }

  reconcile(): void {
    if (this.disabled || !this.container) return;
    try {
      const current = this.container.children;
      const hidden = this.mode.hideThinkingBlock === true;
      if (this.reconciledVersion === this.metadataVersion &&
        this.lastHideThinking === hidden &&
        current.length === this.lastChildren.length &&
        current.every((child: any, index: number) => child === this.lastChildren[index] && this.signatureOf(child) === this.lastKinds[index])) return;
      const children = this.container.children.filter((child: any) => child?.[READ_GROUP] !== this);
      this.renderedCallIds = new Set(children.filter((child: any) => child instanceof ToolExecutionComponent)
        .map((child: any) => child.toolCallId));
      const present = new Set(children);
      for (const [child, patch] of this.assistantPatches) {
        if (!present.has(child)) {
          patch.reply?.restore();
          this.restore(child, "updateContent", patch);
          this.assistantPatches.delete(child);
        }
      }
      for (const child of children) this.patchAssistant(child);
      const previousGroups = new Map(this.groups.map((group) => [group.members[0], group]));
      const next: any[] = [];
      const groups: ReadGroupHeader[] = [];
      const active = new Set<any>();
      for (const child of children) {
        if (isTaskComponent(child)) {
          active.add(child);
          this.patchMember(child).group = undefined;
        }
      }
      const positionOf = (child: any) => this.kindOf(child)
        ? this.positions.get(child.toolCallId)?.[hidden ? "hidden" : "visible"] : undefined;
      for (let i = 0; i < children.length;) {
        const first = children[i];
        const kind = this.kindOf(first);
        let position = positionOf(first);
        const members = [first];
        let end = i + 1;
        if (position) {
          for (let j = i + 1; j < children.length; j++) {
            const child = children[j];
            if (hiddenTask(child)) continue;
            if (this.isHiddenAssistant(child)) continue;
            if (!this.kindOf(child)) break;
            const candidate = positionOf(child);
            if (!candidate || !canJoin(position, candidate)) break;
            members.push(child);
            position = candidate;
            end = j + 1;
          }
        }
        if (position) {
          const previous = previousGroups.get(first);
          const group = previous?.kind === kind ? previous :
            new ReadGroupHeader(this, members, this.mode.toolOutputExpanded === true, kind!);
          group.members = members;
          groups.push(group);
          next.push(group);
          for (const member of members) {
            active.add(member);
            this.patchMember(member).group = group;
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
      this.lastKinds = next.map(child => this.signatureOf(child));
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
        patch.reply?.restore();
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
    this.runActive = false;
    this.openCallId = undefined;
    this.liveCalls.clear();
    this.starts.clear();
    this.renderedCallIds.clear();
    this.lastChildren = [];
    this.lastKinds = [];
    this.hooks = [];
    this.container = undefined;
  }
}

interface SessionOwner {
  sessionManager: object;
  controllers: Map<any, ReadGroupingController>;
  factory: (mode: any) => ReadGroupingController;
}

interface PatchState {
  owners: Map<object, SessionOwner>;
  modes: WeakMap<object, WeakRef<any>>;
}

function attachController(owner: SessionOwner, mode: any): ReadGroupingController | undefined {
  let controller = owner.controllers.get(mode);
  try {
    if (!controller) {
      controller = owner.factory(mode);
      owner.controllers.set(mode, controller);
      // Startup and reload can replay history before session_start binds the UI.
      controller.recordItems((mode.chatContainer?.children ?? []).map((child: any) => child.lastMessage));
    }
    if (controller.attach()) return controller;
  } catch { controller?.detach(); }
}

/** Private, version-sensitive hooks: never patch Container.prototype. */
export function installReadGrouping(pi: ExtensionAPI): void {
  const prototype = InteractiveMode.prototype as any;
  const legacy = prototype[LEGACY_PATCH];
  if (legacy && !legacy.retired) {
    // /reload retains old prototype wrappers. Make them inert before replacing
    // their controllers; even a redraw during reload must not read the old ctx.
    legacy.getTheme = undefined;
    legacy.factory = (mode: any) => {
      const controller = new ReadGroupingController(mode);
      controller.detach();
      return controller;
    };
    legacy.generation++;
    legacy.retired = true;
  }
  let state = prototype[PATCH] as PatchState | undefined;
  if (!state) {
    state = { owners: new Map(), modes: new WeakMap() };
    Object.defineProperty(prototype, PATCH, { value: state });
    const shared = state;
    for (const name of ["handleEvent", "renderSessionItems"]) {
      const original = prototype[name];
      if (typeof original !== "function") continue;
      prototype[name] = function (...args: any[]) {
        let controller: ReadGroupingController | undefined;
        try {
          this[LEGACY_CONTROLLER]?.detach();
          const sessionManager = this.sessionManager;
          if (sessionManager && typeof sessionManager === "object") {
            if (shared.modes.get(sessionManager)?.deref() !== this) shared.modes.set(sessionManager, new WeakRef(this));
            const owner = shared.owners.get(sessionManager);
            if (owner) controller = attachController(owner, this);
          }
          if (controller) {
            if (name === "renderSessionItems") controller.recordItems(args[0]);
            else {
              controller.recordEvent(args[0]);
              if (["message_start", "message_update", "message_end"].includes(args[0]?.type)) {
                controller.recordMessage(args[0].message);
              }
            }
          }
        } catch { controller?.detach(); }
        return original.apply(this, args);
      };
    }
  }
  const shared = state;
  let owner: SessionOwner | undefined;
  const release = (previous: SessionOwner) => {
    if (shared.owners.get(previous.sessionManager) === previous) shared.owners.delete(previous.sessionManager);
    for (const controller of previous.controllers.values()) controller.detach();
    previous.controllers.clear();
  };
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    if (owner) release(owner);
    const sessionManager = context.sessionManager;
    const previous = shared.owners.get(sessionManager);
    if (previous) release(previous);
    // Keep the live UI theme getter, not a context invalidated by replacement.
    const ui = context.ui;
    owner = {
      sessionManager,
      controllers: new Map(),
      factory: mode => new ReadGroupingController(mode, () => ui.theme),
    };
    shared.owners.set(sessionManager, owner);
    const mode = shared.modes.get(sessionManager)?.deref();
    if (mode) attachController(owner, mode);
  });
  pi.on("session_shutdown", () => {
    if (owner) release(owner);
    owner = undefined;
  });
}
