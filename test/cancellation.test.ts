import { describe, expect, test } from "bun:test";
import { SilentAbortRecovery } from "../cancellation.ts";

function createHarness(previousLeafId: string | null = "parent") {
  let leafId = previousLeafId;
  const entries = new Set(previousLeafId ? [previousLeafId] : []);
  const branches: string[] = [];
  const appended: string[] = [];
  const removed: unknown[] = [];
  const forwarded: string[] = [];
  let refreshed = 0;
  let rebuilt = 0;
  let rendered = 0;
  let invalidated = 0;
  let editorText = "draft already in editor";

  const streamingComponent = { id: "assistant" };
  const pendingTool = { id: "pending-tool" };
  const manager = {
    getLeafId: () => leafId,
    getEntry: (id: string) => entries.has(id) ? { id } : undefined,
    branch(id: string) {
      branches.push(id);
      leafId = id;
    },
    resetLeaf() {
      leafId = null;
    },
    appendCustomEntry(customType: string) {
      appended.push(customType);
      leafId = "cancel-marker";
      entries.add(leafId);
      return leafId;
    },
  };
  const mode = {
    sessionManager: manager,
    session: { refreshContext: () => refreshed++ },
    editor: {
      getText: () => editorText,
      setText: (text: string) => {
        editorText = text;
      },
    },
    chatContainer: { removeChild: (component: unknown) => removed.push(component) },
    streamingComponent,
    streamingMessage: { role: "assistant" },
    pendingTools: new Map([["tool-1", pendingTool]]),
    footer: { invalidate: () => invalidated++ },
    ui: { requestRender: () => rendered++ },
    rebuildChatFromMessages: () => rebuilt++,
  };
  const next = (_event: { type: string }) => {
    forwarded.push(_event.type);
  };

  return {
    manager,
    mode,
    next,
    setLeaf(id: string) {
      leafId = id;
      entries.add(id);
    },
    values: {
      appended,
      branches,
      forwarded,
      removed,
      get editorText() {
        return editorText;
      },
      get invalidated() {
        return invalidated;
      },
      get rebuilt() {
        return rebuilt;
      },
      get refreshed() {
        return refreshed;
      },
      get rendered() {
        return rendered;
      },
    },
  };
}

describe("silent abort recovery", () => {
  test("removes a no-action abort and restores the submitted prompt", () => {
    const recovery = new SilentAbortRecovery();
    const harness = createHarness();
    recovery.rememberInput(harness.manager, "please inspect this");

    recovery.handleEvent(
      harness.mode as any,
      { type: "message_start", message: { role: "user", content: [] } },
      harness.next as any,
    );
    harness.setLeaf("assistant");
    recovery.handleEvent(
      harness.mode as any,
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      },
      harness.next as any,
    );

    expect(harness.values.forwarded).toEqual(["message_start"]);
    expect(harness.values.removed).toHaveLength(2);
    expect(harness.mode.pendingTools.size).toBe(0);
    expect(harness.mode.streamingComponent).toBeUndefined();

    recovery.handleEvent(
      harness.mode as any,
      { type: "agent_settled" },
      harness.next as any,
    );

    expect(harness.values.branches).toEqual(["parent"]);
    expect(harness.values.appended).toEqual([
      "codex-renderer:no-action-abort",
    ]);
    expect(harness.values.refreshed).toBe(1);
    expect(harness.values.rebuilt).toBe(1);
    expect(harness.values.editorText).toBe(
      "please inspect this\n\ndraft already in editor",
    );
    expect(harness.values.forwarded).toEqual([
      "message_start",
      "agent_settled",
    ]);
  });

  test("keeps the normal aborted turn after a tool starts", () => {
    const recovery = new SilentAbortRecovery();
    const harness = createHarness();
    recovery.rememberInput(harness.manager, "change the file");

    recovery.handleEvent(
      harness.mode as any,
      { type: "message_start", message: { role: "user", content: [] } },
      harness.next as any,
    );
    recovery.handleEvent(
      harness.mode as any,
      { type: "tool_execution_start" },
      harness.next as any,
    );
    recovery.handleEvent(
      harness.mode as any,
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      },
      harness.next as any,
    );
    recovery.handleEvent(
      harness.mode as any,
      { type: "agent_settled" },
      harness.next as any,
    );

    expect(harness.values.forwarded).toEqual([
      "message_start",
      "tool_execution_start",
      "message_end",
      "agent_settled",
    ]);
    expect(harness.values.branches).toEqual([]);
    expect(harness.values.appended).toEqual([]);
    expect(harness.values.rebuilt).toBe(0);
    expect(harness.values.editorText).toBe("draft already in editor");
  });

  test("persists a root cancellation on a hidden marker branch", () => {
    const recovery = new SilentAbortRecovery();
    const harness = createHarness(null);
    harness.mode.editor.setText("");
    recovery.rememberInput(harness.manager, "first prompt");

    recovery.handleEvent(
      harness.mode as any,
      { type: "message_start", message: { role: "user", content: [] } },
      harness.next as any,
    );
    recovery.handleEvent(
      harness.mode as any,
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      },
      harness.next as any,
    );
    recovery.handleEvent(
      harness.mode as any,
      { type: "agent_settled" },
      harness.next as any,
    );

    expect(harness.values.branches).toEqual([]);
    expect(harness.values.appended).toHaveLength(1);
    expect(harness.values.editorText).toBe("first prompt");
  });
});
