import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const PATCH_KEY = Symbol.for(
  "pi.codex-tool-renderer.silent-no-action-abort",
);
const CANCELLATION_ENTRY_TYPE = "codex-renderer:no-action-abort";

interface MessageContent {
  type: string;
  text?: string;
}

interface ModeEvent {
  type: string;
  message?: {
    role?: string;
    content?: MessageContent[];
    stopReason?: string;
  };
}

interface SessionManagerLike {
  getLeafId(): string | null;
  getEntry(id: string): unknown;
  branch(id: string): void;
  resetLeaf(): void;
  appendCustomEntry(customType: string, data?: unknown): string;
}

interface EditorLike {
  getText(): string;
  getExpandedText?(): string;
  setText(text: string): void;
}

interface InteractiveModeLike {
  sessionManager: SessionManagerLike;
  session: { refreshContext(): void };
  editor: EditorLike;
  chatContainer: {
    removeChild(component: unknown): void;
  };
  streamingComponent?: unknown;
  streamingMessage?: unknown;
  pendingTools: Map<string, unknown>;
  footer: { invalidate(): void };
  ui: { requestRender(): void };
  rebuildChatFromMessages(): void;
}

type EventHandler = (
  this: InteractiveModeLike,
  event: ModeEvent,
) => Promise<void> | void;

interface ActiveRun {
  prompt: string;
  previousLeafId: string | null;
  actionStarted: boolean;
  shouldRestore: boolean;
}

interface SessionState {
  pendingInput?: string;
  activeRun?: ActiveRun;
}

interface PatchedInteractiveModePrototype {
  handleEvent: EventHandler;
  [PATCH_KEY]?: {
    controller: SilentAbortRecovery;
    original: EventHandler;
    wrapper: EventHandler;
  };
}

function userMessageText(message: ModeEvent["message"]): string {
  if (!message?.content) return "";
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function combinedEditorText(prompt: string, currentText: string): string {
  if (!currentText.trim()) return prompt;
  if (
    currentText === prompt ||
    currentText.startsWith(`${prompt}\n\n`)
  ) {
    return currentText;
  }
  return `${prompt}\n\n${currentText}`;
}

/**
 * Tracks one interactive prompt and rolls its append-only branch back when the
 * user aborts before any tool starts executing.
 */
export class SilentAbortRecovery {
  private readonly sessions = new WeakMap<object, SessionState>();

  rememberInput(sessionManager: object, text: string): void {
    const state = this.getState(sessionManager);
    state.pendingInput = text;
  }

  handleEvent(
    mode: InteractiveModeLike,
    event: ModeEvent,
    next: EventHandler,
  ): Promise<void> | void {
    const manager = mode.sessionManager;
    const state = this.getState(manager);

    if (
      event.type === "message_start" &&
      event.message?.role === "user" &&
      !state.activeRun &&
      state.pendingInput !== undefined
    ) {
      state.activeRun = {
        prompt: state.pendingInput || userMessageText(event.message),
        previousLeafId: manager.getLeafId(),
        actionStarted: false,
        shouldRestore: false,
      };
      state.pendingInput = undefined;
    }

    if (event.type === "tool_execution_start" && state.activeRun) {
      state.activeRun.actionStarted = true;
    }

    if (
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      event.message.stopReason === "aborted" &&
      state.activeRun &&
      !state.activeRun.actionStarted
    ) {
      state.activeRun.shouldRestore = true;
      this.removeCancelledOutput(mode);
      return;
    }

    if (event.type === "agent_settled") {
      const activeRun = state.activeRun;
      state.activeRun = undefined;
      if (activeRun?.shouldRestore) {
        this.restorePrompt(mode, activeRun);
      }
    }

    return next.call(mode, event);
  }

  private getState(sessionManager: object): SessionState {
    let state = this.sessions.get(sessionManager);
    if (!state) {
      state = {};
      this.sessions.set(sessionManager, state);
    }
    return state;
  }

  private removeCancelledOutput(mode: InteractiveModeLike): void {
    if (mode.streamingComponent) {
      mode.chatContainer.removeChild(mode.streamingComponent);
    }
    for (const component of mode.pendingTools.values()) {
      mode.chatContainer.removeChild(component);
    }
    mode.pendingTools.clear();
    mode.streamingComponent = undefined;
    mode.streamingMessage = undefined;
    mode.footer.invalidate();
    mode.ui.requestRender();
  }

  private restorePrompt(mode: InteractiveModeLike, run: ActiveRun): void {
    const manager = mode.sessionManager;
    if (run.previousLeafId === null) {
      manager.resetLeaf();
    } else if (manager.getEntry(run.previousLeafId)) {
      manager.branch(run.previousLeafId);
    } else {
      return;
    }

    // Persist the selected branch even if Pi exits before the restored prompt is
    // resubmitted. Custom entries are hidden and excluded from model context.
    manager.appendCustomEntry(CANCELLATION_ENTRY_TYPE);
    mode.session.refreshContext();
    mode.rebuildChatFromMessages();

    const currentText = mode.editor.getExpandedText?.() ?? mode.editor.getText();
    mode.editor.setText(combinedEditorText(run.prompt, currentText));
    mode.footer.invalidate();
    mode.ui.requestRender();
  }
}

/** Install Claude Code-style cancellation for aborts before any tool executes. */
export function installSilentAbortRecovery(pi: ExtensionAPI): void {
  const prototype = InteractiveMode.prototype as unknown as PatchedInteractiveModePrototype;
  let patch = prototype[PATCH_KEY];

  if (!patch) {
    const controller = new SilentAbortRecovery();
    const original = prototype.handleEvent;
    const wrapper: EventHandler = function (event) {
      return controller.handleEvent(this, event, original);
    };
    patch = { controller, original, wrapper };
    Object.defineProperty(prototype, PATCH_KEY, {
      configurable: false,
      enumerable: false,
      value: patch,
      writable: false,
    });
    prototype.handleEvent = wrapper;
  }

  pi.on("input", (event, context) => {
    if (
      event.source === "interactive" &&
      event.streamingBehavior === undefined
    ) {
      patch.controller.rememberInput(
        context.sessionManager as object,
        event.text,
      );
    }
  });
}
