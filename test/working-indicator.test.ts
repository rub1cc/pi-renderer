import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  initTheme,
  InteractiveMode,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatWorkingDuration,
  installWorkingIndicator,
  WorkingIndicatorComponent,
  WorkingIndicatorController,
  WorkedDurationComponent,
  WORKING_FRAMES,
  WORKING_FRAME_MS,
} from "../working-indicator.ts";
import { installReadGrouping, ReadGroupingController } from "../read-groups.ts";
import { readRenderers } from "../renderers.ts";

beforeAll(async () => { await initTheme("dark", false); });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function install() {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
  } as unknown as ExtensionAPI;
  installWorkingIndicator(pi);
  const emit = (name: string, context = {}, details = {}) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...details }, context);
  };
  cleanups.push(() => emit("session_shutdown"));
  return { pi, emit };
}

function host() {
  const mode: any = {};
  const editor = {
    embedWorkingStatus: true,
    indicator: undefined as any,
    setWorkingStatusIndicator(value: any) { this.indicator = value; },
  };
  Object.assign(mode, {
    isInitialized: true,
    chatContainer: new Container(),
    statusContainer: new Container(),
    editor,
    defaultEditor: editor,
    sessionManager: {},
    session: { thinkingLevel: "off", isStreaming: true },
    settingsManager: { getShowTerminalProgress: () => false },
    programStatus: { handleEvent() {} },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    workingVisible: true,
    defaultWorkingMessage: "Working",
    ui: { requestRender() {}, getClearOnShrink: () => false },
    options: { tuiMode: "fullscreen" },
    checkShutdownRequested() {},
  });
  Object.setPrototypeOf(mode, InteractiveMode.prototype);
  cleanups.push(() => mode.clearStatusIndicator());
  return mode;
}

function rows(mode: any, width = 80) {
  return mode.chatContainer.render(width).map(stripTerminalSequences);
}

function currentTheme() {
  return (InteractiveMode.prototype as any).createExtensionUIContext.call({}).theme;
}

describe("working indicator view", () => {
  test("formats seconds, minutes, hours, days, and intermediate zero units", () => {
    for (const [milliseconds, text] of [
      [0, "0s"], [999, "0s"], [1000, "1s"], [59000, "59s"], [60000, "1m 0s"],
      [61500, "1m 1s"], [3600000, "1h 0m 0s"], [86400000, "1d 0h 0m 0s"],
      [93795000, "1d 2h 3m 15s"], [-1000, "0s"], [NaN, "0s"], [Infinity, "0s"],
    ] as const) expect(formatWorkingDuration(milliseconds)).toBe(text);
  });

  test("cycles the exact seven requested symbols and advances duration", () => {
    let now = 500;
    const view = new WorkingIndicatorComponent(500, () => undefined, undefined, () => now);
    for (let index = 0; index <= WORKING_FRAMES.length; index++) {
      now = 500 + index * WORKING_FRAME_MS;
      expect(view.render(80)[1]).toBe(` ${WORKING_FRAMES[index % WORKING_FRAMES.length]} Working (${formatWorkingDuration(now - 500)})`);
    }
    now = 500 + 93795000;
    expect(view.render(80)[1]).toEndWith("Working (1d 2h 3m 15s)");
    expect(view.render(0)).toEqual([]);
  });

  test("shimmers with the current theme, keeping plain text stable", async () => {
    const theme = currentTheme();
    let now = 0;
    const view = new WorkingIndicatorComponent(0, () => theme, undefined, () => now);
    const first = view.render(80)[1];
    now = 50;
    const next = view.render(80)[1];
    expect(first).not.toBe(next);
    expect(stripTerminalSequences(first)).toBe(stripTerminalSequences(next));
    await initTheme("light", false);
    expect(view.render(80)[1]).not.toBe(next);
  });

  test("reduced motion freezes the symbol and shimmer but not the clock", async () => {
    const theme = currentTheme();
    let now = 0;
    const view = new WorkingIndicatorComponent(0, () => theme, undefined, () => now, true);
    const first = view.render(80)[1];
    now = 50;
    expect(view.render(80)[1]).toBe(first);
    now = 2300;
    expect(stripTerminalSequences(view.render(80)[1])).toBe(" ✽ Working (2s)");
  });

  test("sanitizes custom labels and stays within narrow widths", async () => {
    const theme = currentTheme();
    const view = new WorkingIndicatorComponent(0, () => theme, () => "\x1b[31m解析\nWorking\x07", () => 0);
    for (const width of [1, 2, 3, 5, 10, 20, 80]) {
      for (const row of view.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
    expect(stripTerminalSequences(view.render(80)[1])).toBe(" ✽ 解析 Working (0s)");
  });
});

describe("completed duration receipt", () => {
  function setup() {
    const mode = host();
    const reply = new Text("assistant reply", 0, 0);
    mode.chatContainer.addChild(reply);
    let now = 0;
    const controller = new WorkingIndicatorController(mode, () => undefined, () => now);
    cleanups.push(() => controller.detach());
    controller.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    expect(controller.adopt(mode.activeStatusIndicator)).toBe(true);
    const end = (duration: number, stopReason = "stop", aborted = false) => {
      now = duration;
      mode.clearStatusIndicator();
      controller.recordEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason }] });
      controller.recordEvent({ type: "agent_settled", aborted });
    };
    return { mode, reply, controller, end, setNow: (value: number) => { now = value; } };
  }

  test("freezes a single receipt at settlement without adding transcript children", () => {
    const { mode, reply, controller, end, setNow } = setup();
    end(93795000);
    expect(rows(mode).at(-1)).toBe(" ✽ Worked for 1d 2h 3m 15s");
    expect(rows(mode).join("\n")).not.toContain("Working (");
    expect(mode.chatContainer.children).toEqual([reply]);
    setNow(93799000);
    expect(rows(mode).at(-1)).toBe(" ✽ Worked for 1d 2h 3m 15s");
    controller.recordEvent({ type: "agent_settled", aborted: false });
    expect(rows(mode).filter((line: string) => line.includes("Worked for"))).toHaveLength(1);
  });

  test("shows a receipt at exactly ten seconds but not for shorter turns", () => {
    for (const duration of [0, 5000, 9999, 10000]) {
      const { mode, end } = setup();
      end(duration);
      expect(rows(mode).some((line: string) => line.includes("Worked for"))).toBe(duration >= 10000);
    }
  });

  test("the next run clears the receipt and starts a fresh clock", () => {
    const { mode, controller, end, setNow } = setup();
    end(15000);
    expect(rows(mode).at(-1)).toContain("Worked for 15s");
    setNow(20000);
    controller.recordEvent({ type: "agent_start" });
    expect(rows(mode).join("\n")).not.toContain("Worked for");
    mode.showWorkingStatusIndicator();
    controller.adopt(mode.activeStatusIndicator);
    expect(rows(mode).at(-1)).toContain("Working (0s)");
    end(25000);
    expect(rows(mode).join("\n")).not.toContain("Worked for");
  });

  test("aborted, errored, and truncated runs leave no completion receipt", () => {
    for (const [stopReason, aborted] of [["stop", true], ["aborted", false], ["error", false], ["length", false]] as const) {
      const { mode, end } = setup();
      end(15000, stopReason, aborted);
      expect(rows(mode).join("\n")).not.toContain("Worked for");
    }
  });

  test("automatic recovery produces one receipt for the whole successful run", () => {
    const { mode, controller, end, setNow } = setup();
    setNow(10000);
    mode.clearStatusIndicator();
    controller.recordEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] });
    expect(rows(mode).join("\n")).not.toContain("Worked for");
    setNow(14000);
    controller.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    controller.adopt(mode.activeStatusIndicator);
    end(20000);
    expect(rows(mode).at(-1)).toBe(" ✽ Worked for 20s");
    expect(rows(mode).filter((line: string) => line.includes("Worked for"))).toHaveLength(1);
  });

  test("message-end errors are respected even when agent_end has no messages", () => {
    const { mode, controller, setNow } = setup();
    setNow(15000);
    controller.recordEvent({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
    mode.clearStatusIndicator();
    controller.recordEvent({ type: "agent_end" });
    controller.recordEvent({ type: "agent_settled", aborted: false });
    expect(rows(mode).join("\n")).not.toContain("Worked for");
  });

  test("transcript rebuilds, later notices, and detach remove stale receipts", () => {
    for (const change of [
      (mode: any) => mode.chatContainer.clear(),
      (mode: any) => mode.chatContainer.addChild(new Text("new notice", 0, 0)),
      (_mode: any, controller: WorkingIndicatorController) => controller.detach(),
    ]) {
      const { mode, controller, end } = setup();
      end(15000);
      expect(rows(mode).at(-1)).toContain("Worked for 15s");
      change(mode, controller);
      expect(rows(mode).join("\n")).not.toContain("Worked for");
    }
  });

  test("receipts are muted, width-safe, and have a static symbol without shimmer", () => {
    const colors: string[] = [];
    const theme = {
      fg(color: string, text: string) { colors.push(color); return text; },
    } as any;
    const view = new WorkedDurationComponent(61500, () => theme);
    expect(view.render(80)).toEqual(["", " ✽ Worked for 1m 1s"]);
    expect(view.render(80)).toEqual(view.render(80));
    expect(colors.every(color => color === "muted")).toBe(true);
    expect(view.render(0)).toEqual([]);
    for (const width of [1, 2, 5, 10, 80]) {
      for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("native working indicator lifecycle", () => {
  test("renders only at the transcript tail, without adding children or persisting messages", async () => {
    install();
    const mode = host();
    const transcript = new Text("user prompt", 0, 0);
    mode.chatContainer.addChild(transcript);
    await mode.handleEvent({ type: "agent_start" });
    await mode.handleEvent({ type: "turn_start" });
    const native = mode.activeStatusIndicator;
    expect(native.kind).toBe("working");
    expect(native.intervalId).toBeNull();
    expect(native.renderInBorder(80)).toBe("");
    expect(native.renderSpinnerInBorder(80)).toBe("");
    expect(native.render(80)).toEqual([]);
    expect(rows(mode).join("\n")).toContain("✽ Working (0s)");
    expect(mode.chatContainer.children).toEqual([transcript]);
    mode.chatContainer.addChild(new Text("assistant update", 0, 0));
    expect(rows(mode).at(-1)).toContain("Working (0s)");
    expect(rows(mode).filter((line: string) => line.includes("Working"))).toHaveLength(1);
    expect(mode.statusContainer.render(80)).toEqual([]);
    expect(transcript.render(80).map((line: string) => line.trimEnd())).toEqual(["user prompt"]);
  });

  test("removes the row on completion, abort cleanup, visibility changes, and non-working statuses", async () => {
    install();
    const mode = host();
    for (const action of [
      () => mode.handleEvent({ type: "agent_end" }),
      () => mode.clearStatusIndicator(),
      () => mode.setWorkingVisible(false),
      () => mode.showStatusIndicator({ kind: "retry", dispose() {}, render: () => ["Retrying"], renderInBorder: () => "Retrying" }),
    ]) {
      mode.workingVisible = true;
      mode.showWorkingStatusIndicator();
      const native = mode.activeStatusIndicator;
      expect(rows(mode).join("\n")).toContain("Working");
      await action();
      expect(rows(mode).join("\n")).not.toContain("Working");
      expect(native.intervalId).toBeNull();
      expect(Object.hasOwn(native, "dispose")).toBe(false);
      expect(Object.hasOwn(native, "renderInBorder")).toBe(false);
    }
    expect(mode.editor.indicator.kind).toBe("retry");
    expect(mode.editor.indicator.renderInBorder(80)).toBe("Retrying");
  });

  test("one run clock spans tool rounds and recovery, then resets on settlement", () => {
    // Exercise a deterministic controller with the real native status instances.
    const mode = host();
    let now = 0;
    const controller = new WorkingIndicatorController(mode, () => undefined, () => now);
    cleanups.push(() => controller.detach());
    controller.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    expect(controller.adopt(mode.activeStatusIndicator)).toBe(true);
    now = 61000;
    expect(rows(mode).at(-1)).toContain("Working (1m 1s)");
    controller.recordEvent({ type: "turn_start" });
    expect(rows(mode).at(-1)).toContain("Working (1m 1s)");
    mode.clearStatusIndicator();
    controller.recordEvent({ type: "agent_end" });
    now = 65000;
    controller.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    controller.adopt(mode.activeStatusIndicator);
    expect(rows(mode).at(-1)).toContain("Working (1m 5s)");
    mode.clearStatusIndicator();
    controller.recordEvent({ type: "agent_settled" });
    now = 70000;
    controller.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    controller.adopt(mode.activeStatusIndicator);
    expect(rows(mode).at(-1)).toContain("Working (0s)");
  });

  test("editor changes cannot reintroduce the border or fallback row", () => {
    install();
    const mode = host();
    mode.showWorkingStatusIndicator();
    const native = mode.activeStatusIndicator;
    mode.editor = { embedWorkingStatus: false };
    // Same native reattachment path used when replacing the editor component.
    mode.statusContainer.clear();
    mode.activeWorkingIndicatorEmbedded = mode.setEditorWorkingStatusIndicator(native);
    if (!mode.activeWorkingIndicatorEmbedded) mode.statusContainer.addChild(native);
    expect(mode.statusContainer.render(80)).toEqual([]);
    expect(rows(mode).filter((line: string) => line.includes("Working"))).toHaveLength(1);
    mode.clearStatusIndicator();
    expect(rows(mode)).toEqual([]);
  });

  test("native frame changes cannot restart a second animation timer", () => {
    const extension = install();
    const mode = host();
    mode.showWorkingStatusIndicator();
    const native = mode.activeStatusIndicator;
    mode.setWorkingIndicator({ frames: ["a", "b"], intervalMs: 10 });
    expect(native.intervalId).toBeNull();
    expect(rows(mode).at(-1)).toContain("✽ Working (0s)");
    native.setMessage("Planning next steps");
    expect(rows(mode).at(-1)).toContain("Planning next steps (0s)");
    extension.emit("session_shutdown", {}, { reason: "reload" });
    expect(Object.hasOwn(native, "start")).toBe(false);
    expect(native.intervalId).not.toBeNull();
    expect(native.renderInBorder(80)).toContain("Planning next steps");
  });

  test("shutdown and reload restore native rendering and timers without stacking wrappers", () => {
    const first = install();
    const mode = host();
    const render = mode.chatContainer.render;
    mode.showWorkingStatusIndicator();
    const native = mode.activeStatusIndicator;
    const showStatus = mode.showStatusIndicator;
    first.emit("session_shutdown", {}, { reason: "reload" });
    expect(mode.chatContainer.render).toBe(render);
    expect(native.renderInBorder(80)).toContain("Working");
    expect(native.intervalId).not.toBeNull();
    install();
    expect(mode.showStatusIndicator).toBe(showStatus);
    mode.showWorkingStatusIndicator();
    expect(rows(mode).filter((line: string) => line.includes("Working"))).toHaveLength(1);
    mode.clearStatusIndicator();
    expect(rows(mode)).toEqual([]);
  });

  test("quit and session replacement do not restart a native animation timer", () => {
    for (const reason of ["quit", "new", "resume", "fork"]) {
      const extension = install();
      const mode = host();
      mode.showWorkingStatusIndicator();
      const native = mode.activeStatusIndicator;
      extension.emit("session_shutdown", {}, { reason });
      expect(native.intervalId).toBeNull();
      expect(Object.hasOwn(native, "dispose")).toBe(false);
      expect(rows(mode)).toEqual([]);
    }
  });

  test("later extension wrappers survive detach and retained hooks pass through", () => {
    const extension = install();
    const mode = host();
    mode.showWorkingStatusIndicator();
    const native = mode.activeStatusIndicator;
    const border = native.renderInBorder;
    const start = native.start;
    const laterBorder = function (this: any, width: number) { return border.call(this, width); };
    const laterStart = function (this: any) { return start.call(this); };
    native.renderInBorder = laterBorder;
    native.start = laterStart;
    extension.emit("session_shutdown", {}, { reason: "reload" });
    expect(native.renderInBorder).toBe(laterBorder);
    expect(native.start).toBe(laterStart);
    expect(native.renderInBorder(80)).toContain("Working");
    expect(native.intervalId).not.toBeNull();
  });

  test("redraw ticks stop after native disposal", async () => {
    install();
    const mode = host();
    let renders = 0;
    mode.ui.requestRender = () => { renders++; };
    mode.showWorkingStatusIndicator();
    const initial = renders;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(renders).toBeGreaterThan(initial);
    mode.clearStatusIndicator();
    const cleared = renders;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(renders).toBe(cleared);
  });

  test("unsupported indicators stay native and host errors still propagate", () => {
    const mode = host();
    const controller = new WorkingIndicatorController(mode, () => undefined);
    cleanups.push(() => controller.detach());
    const render = mode.chatContainer.render;
    const unsupported = { kind: "working", render: () => ["native"] };
    mode.activeStatusIndicator = unsupported;
    expect(controller.adopt(unsupported)).toBe(false);
    expect(mode.chatContainer.render).toBe(render);
    expect(unsupported.render()).toEqual(["native"]);
    mode.activeStatusIndicator = undefined;
    mode.chatContainer.render = () => { throw new Error("native render error"); };
    mode.showWorkingStatusIndicator();
    controller.adopt(mode.activeStatusIndicator);
    expect(() => rows(mode)).toThrow("native render error");
  });

  test("a shimmer failure falls back to the native loader", () => {
    const mode = host();
    const controller = new WorkingIndicatorController(mode, () => { throw new Error("theme unavailable"); });
    cleanups.push(() => controller.detach());
    mode.showWorkingStatusIndicator();
    const native = mode.activeStatusIndicator;
    controller.adopt(native);
    expect(rows(mode)).toEqual([]);
    expect(native.renderInBorder(80)).toContain("Working");
    expect(native.intervalId).not.toBeNull();
  });

  test("the inline tail neither closes the live preview nor splits consecutive calls", () => {
    const { pi } = install();
    installReadGrouping(pi);
    const mode = host();
    mode.hideThinkingBlock = true;
    mode.toolOutputExpanded = false;
    const grouping = new ReadGroupingController(mode);
    expect(grouping.attach()).toBe(true);
    cleanups.push(() => grouping.detach());
    grouping.recordEvent({ type: "agent_start" });
    mode.showWorkingStatusIndicator();
    for (const id of ["a", "b"]) {
      const args = { path: `${id}.txt` };
      const message = { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }] };
      grouping.recordMessage(message);
      grouping.recordEvent({ type: "message_update", message });
      const tool = new ToolExecutionComponent("read", id, args, { showImages: false }, readRenderers, mode.ui, "/repo");
      tool.updateResult({ content: [{ type: "text", text: id }], details: undefined });
      mode.chatContainer.addChild(tool);
    }
    expect(rows(mode).join("\n")).toContain("Reading b.txt");
    expect(rows(mode).join("\n")).not.toContain("Read 2 files");
    expect(rows(mode).at(-1)).toContain("Working");
    mode.clearStatusIndicator();
    expect(rows(mode).join("\n")).toContain("Reading b.txt");
    expect(rows(mode).join("\n")).not.toContain("Working");
  });
});
