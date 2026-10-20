import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getMarkdownTheme, initTheme, InteractiveMode, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, VStack, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { installStickyPrompt, StickyPromptController, summarizeUserPrompt } from "../sticky-prompt.ts";
import { installCompactUserMessages } from "../user-messages.ts";
import { AdaptiveWheelHook } from "../../adaptive-scroll/wheel-hook.ts";

beforeAll(async () => { await initTheme("light", false); installCompactUserMessages(); });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(scrollbar: "hidden" | "always" = "hidden", theme?: any) {
  const chat = new Container();
  chat.addChild(new UserMessageComponent("Earlier prompt"));
  chat.addChild(new Text("earlier reply\n".repeat(10).trimEnd(), 0, 0));
  const user = new UserMessageComponent("Latest prompt with enough content to truncate on a narrow screen");
  chat.addChild(user);
  chat.addChild(new Text("latest reply\n".repeat(25).trimEnd(), 0, 0));
  const document = new Container();
  document.addChild(new Text("session header", 0, 0));
  document.addChild(chat);
  const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar });
  const dock = new Text("EDITOR\nFOOTER", 0, 0);
  const root = new VStack([
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: dock, shrink: 0 },
  ]);
  const mode: any = { chatContainer: chat, documentContainer: document,
    transcriptScrollView: scroll, fullscreenLayoutRoot: root, renderer: { mode: "fullscreen" },
    sessionManager: {}, pendingTools: new Map(), settingsManager: { getShowCacheMissNotices: () => false },
    ui: { requestRender() {} } };
  const controller = new StickyPromptController(mode, () => theme);
  expect(controller.attach()).toBe(true);
  cleanups.push(() => controller.detach());
  const frame = (width = 40, height = 10) => renderLayoutFrame(root, width, height, () => {});
  const lines = (width = 40, height = 10) => frame(width, height).lines.map(stripTerminalSequences);
  return { mode, user, chat, document, scroll, dock, root, controller, frame, lines };
}

function mouse(type: "press" | "click" | "release", extra = {}) {
  return { type, button: "left", x: 1, y: 0, screenX: 1, screenY: 0, width: 40, height: 1,
    shift: false, alt: false, ctrl: false, ...extra } as any;
}

describe("sticky contextual prompt", () => {
  test("appears as exactly one fixed row while scrolled up, hiding at the bottom", () => {
    const { controller, scroll, frame, lines } = setup();
    const bottom = frame();
    expect(bottom.primaryScrollView).toBe(scroll);
    expect(lines()[0]).not.toContain("❯");
    const normalHeight = scroll.viewportHeight;
    scroll.scrollBy(-5);
    const up = lines();
    expect(up[0]).toStartWith("❯ Latest prompt");
    expect(up[0]).toContain("…");
    expect(up.filter(line => line.includes("❯ Latest prompt"))).toHaveLength(1);
    expect(scroll.viewportHeight).toBe(normalHeight - 1);
    expect(up.slice(-2).map(line => line.trim())).toEqual(["EDITOR", "FOOTER"]);
    expect(controller.header.render(40)).toHaveLength(1);
    scroll.scrollToEnd();
    expect(lines()[0]).not.toContain("❯");
    expect(scroll.viewportHeight).toBe(normalHeight);
  });

  test("clicking jumps to the original prompt, not to the end", () => {
    const { controller, scroll, document, chat, user, lines } = setup();
    lines();
    scroll.scrollBy(-4);
    lines();
    let expected = 0;
    for (const component of document.children) {
      if (component === chat) break;
      expected += component.render(40).length;
    }
    for (const component of chat.children) {
      if (component === user) break;
      expected += component.render(40).length;
    }
    expect(controller.header.handleMouse(mouse("press"))?.handled).toBe(true);
    expect(controller.header.handleMouse(mouse("click"))?.handled).toBe(true);
    expect(scroll.scrollTop).toBe(expected);
    expect(scroll.isFollowingEnd).toBe(false);
    const jumped = lines();
    expect(jumped[0]).toStartWith("❯ Latest prompt");
    expect(jumped.filter(line => line.startsWith("❯ Latest prompt"))).toHaveLength(1);
    expect(controller.header.render(40)).toEqual([]);
    expect(controller.header.handleMouse(mouse("click", { button: "right" }))).toBeUndefined();
  });

  test("measures click targets using resized content width and the native scrollbar gutter", () => {
    const { controller, scroll, lines } = setup("always");
    for (const width of [15, 60, 15]) {
      lines(width);
      scroll.scrollToEnd();
      lines(width);
      scroll.scrollBy(-3);
      lines(width);
      expect(controller.header.handleMouse(mouse("click"))?.handled).toBe(true);
      expect(lines(width)[0]).toStartWith("❯ Latest");
      expect(scroll.isFollowingEnd).toBe(false);
    }
  });

  test("new inputs do not replace the prompt for the older section being viewed", () => {
    const { controller, scroll, chat, lines } = setup();
    lines();
    scroll.scrollBy(-5);
    lines();
    chat.addChild(new UserMessageComponent("Newer input"));
    chat.addChild(new Text("new output\n".repeat(20), 0, 0));
    expect(lines()[0]).toStartWith("❯ Latest prompt");
    scroll.scrollToEnd();
    lines();
    scroll.scrollBy(-5);
    expect(lines()[0]).toStartWith("❯ Newer input");
    chat.clear();
    expect(controller.header.handleMouse(mouse("click"))).toBeUndefined();
    expect(lines().join("\n")).not.toContain("Newer input");
  });

  test("flattens visible Markdown and respects prompt transformations", () => {
    const user = new UserMessageComponent("First paragraph\n\nSecond paragraph\n\nHidden secret", getMarkdownTheme(), 1,
      [text => text.replace("Hidden secret", "")]);
    const summary = summarizeUserPrompt(user, 60);
    expect(summary).toBe("First paragraph Second paragraph");
    expect(summary).not.toContain("Hidden secret");
    expect(summary).not.toContain("❯");
  });

  test("a transformed-away prompt does not expose raw text or reserve an empty header row", () => {
    const { chat, scroll, lines } = setup();
    chat.addChild(new UserMessageComponent("Hidden secret", getMarkdownTheme(), 1, [() => ""]));
    chat.addChild(new Text("reply for hidden prompt\n".repeat(20), 0, 0));
    lines();
    const normalHeight = scroll.viewportHeight;
    scroll.scrollBy(-5);
    expect(lines()[0]).not.toContain("Hidden secret");
    expect(scroll.viewportHeight).toBe(normalHeight);
  });

  test("changes prompts at the respective user row while scrolling between turns", () => {
    const { controller, scroll, lines } = setup();
    lines();
    scroll.scrollTo(3, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
    expect(controller.header.handleMouse(mouse("click"))?.handled).toBe(true);
    expect(scroll.scrollTop).toBe(1); // After the session header, before the first reply.
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
    expect(controller.header.render(40)).toEqual([]);
    scroll.scrollTo(11, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
    scroll.scrollTo(12, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Latest prompt");
    expect(controller.header.render(40)).toEqual([]);
    scroll.scrollTo(20, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Latest prompt");
    scroll.scrollTo(4, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
  });

  test("pins only after the original prompt scrolls above the viewport", () => {
    const { controller, scroll, lines } = setup();
    lines();
    for (const offset of [12, 13, 12]) {
      scroll.scrollTo(offset, { disableFollow: true });
      const output = lines();
      expect(output.filter(line => line.startsWith("❯ Latest prompt"))).toHaveLength(1);
      expect(controller.header.render(40)).toHaveLength(offset === 12 ? 0 : 1);
    }
  });

  test("does not pin a future prompt above the first user message", () => {
    const { controller, scroll, lines } = setup();
    lines();
    scroll.scrollToStart();
    expect(lines()[0].trim()).toBe("session header");
    expect(controller.header.handleMouse(mouse("click"))).toBeUndefined();
  });

  test("context selection reuses native child measurements without rendering history again", () => {
    const { controller, document, scroll, lines } = setup();
    lines();
    scroll.scrollTo(3, { disableFollow: true });
    const original = document.render;
    let renders = 0;
    document.render = function (width) { renders++; return original.call(this, width); };
    expect(controller.currentUser(40)).toBeDefined();
    expect(controller.currentUser(40)).toBe(controller.currentUser(40));
    expect(renders).toBe(0);
    controller.currentUser(20);
    expect(renders).toBe(1); // A changed width needs fresh native measurements.
  });

  test("changed native row heights refresh the prompt owning the visible section", () => {
    const { chat, root, scroll, lines } = setup();
    lines();
    scroll.scrollTo(20, { disableFollow: true });
    expect(lines()[0]).toStartWith("❯ Latest prompt");
    (chat.children[1] as Text).setText("expanded earlier reply\n".repeat(40));
    let redraws = 0;
    renderLayoutFrame(root, 40, 10, () => { redraws++; });
    expect(redraws).toBeGreaterThan(0);
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
  });

  test("resize-induced return to the bottom schedules removal of the sticky row", () => {
    const { root, scroll, lines } = setup();
    lines();
    scroll.scrollBy(-5);
    expect(lines()[0]).toStartWith("❯ Latest prompt");
    let redraws = 0;
    renderLayoutFrame(root, 40, 100, () => { redraws++; });
    expect(scroll.isFollowingEnd).toBe(true);
    expect(redraws).toBeGreaterThan(0);
    expect(lines(40, 100)[0]).not.toContain("❯ Latest prompt");
  });

  test("keeps theme colors, one-line height and narrow-width safety", async () => {
    const theme = (InteractiveMode.prototype as any).createExtensionUIContext.call({}).theme;
    const { controller, scroll, lines } = setup("hidden", theme);
    lines();
    scroll.scrollBy(-5);
    for (const width of [1, 2, 3, 10, 40]) {
      const rows = controller.header.render(width);
      expect(rows).toHaveLength(1);
      expect(visibleWidth(rows[0])).toBe(width);
      expect(rows[0]).toContain(theme.getBgAnsi("userMessageBg"));
      expect(rows[0]).toContain(theme.getFgAnsi("muted"));
      expect(rows[0]).toContain("\x1b[3m");
    }
    const before = controller.header.render(40)[0];
    await initTheme("dark", false);
    expect(controller.header.render(40)[0]).not.toBe(before);
    expect(controller.header.render(0)).toEqual([]);
  });

  test("regular mode and tiny screens do not gain a sticky row", () => {
    const { mode, scroll, lines } = setup();
    lines();
    scroll.scrollBy(-5);
    mode.renderer.mode = "regular";
    expect(lines()[0]).not.toContain("❯ Latest prompt");
    mode.renderer.mode = "fullscreen";
    expect(lines(40, 2)[0]).not.toContain("❯ Latest prompt");
  });

  test("attachment is idempotent and cleanup removes only its own layout entry", () => {
    const { mode, controller, root, scroll, dock } = setup();
    const other = new Text("OTHER", 0, 0);
    root.addChild(other);
    expect(controller.attach()).toBe(true);
    expect((root as any).entries.filter((entry: any) => entry.component === controller.header)).toHaveLength(1);
    controller.detach();
    expect(root.children).toEqual([scroll, dock, other]);
    expect((root as any).entries.map((entry: any) => entry.component)).toEqual(root.children);
    expect(new StickyPromptController({ ...mode, fullscreenLayoutRoot: {} }, () => undefined).attach()).toBe(false);
  });

  test("native fullscreen mouse routing clicks the header and wheel acceleration remains independent", () => {
    const { controller, root, scroll, lines } = setup();
    const terminal = { rows: 10, columns: 40, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} } as any;
    const tui: any = new TuiAltScreen(terminal);
    tui.requestRender = () => {};
    tui.setLayoutRoot(root);
    const hook = new AdaptiveWheelHook();
    cleanups.push(() => hook.dispose());
    expect(hook.sync(tui)).toBe(true);
    const acceleration = tui.wheelScroll.next;
    tui.currentLayout = renderLayoutFrame(root, 40, 10, () => {});
    scroll.scrollBy(-5);
    tui.currentLayout = renderLayoutFrame(root, 40, 10, () => {});
    const before = scroll.scrollTop;
    tui.handleMouseEvent({ x: 1, y: 0, button: 0, release: false });
    tui.handleMouseEvent({ x: 1, y: 0, button: 0, release: true });
    expect(scroll.scrollTop).not.toBe(before);
    expect(tui.wheelScroll.next).toBe(acceleration);
    expect(controller.header.handleMouse({ ...mouse("click"), type: "wheel", button: "none", wheelDelta: -1 })).toBeUndefined();
    const top = scroll.scrollTop;
    tui.routeWheel({ x: 1, y: 0 }, -1);
    expect(scroll.scrollTop).toBe(top - 1);
    expect(lines()[0]).toStartWith("❯ Earlier prompt");
  });
});

describe("sticky prompt host hooks", () => {
  function install(mode?: any) {
    const handlers = new Map<string, Function[]>();
    installStickyPrompt({ on(name: string, callback: Function) {
      handlers.set(name, [...handlers.get(name) ?? [], callback]);
    } } as unknown as ExtensionAPI);
    const emit = (name: string, context = {}) => {
      for (const handler of handlers.get(name) ?? []) handler({ type: name }, context);
    };
    const shutdown = () => emit("session_shutdown");
    cleanups.push(shutdown);
    if (mode) emit("session_start", { mode: "tui", sessionManager: mode.sessionManager,
      ui: { theme: (InteractiveMode.prototype as any).createExtensionUIContext.call({}).theme } });
    return { emit, shutdown };
  }

  function mount(mode: any) {
    const mounted: any[] = [];
    const tui = { addChild() {}, setLayoutRoot(value: any) { mounted.push(value); },
      [Symbol.for("@earendil-works/pi-tui/viewport")]: true };
    (InteractiveMode.prototype as any).mountInteractiveTui.call(mode, tui, []);
    return mounted;
  }

  test("child loading, headless starts, and cleanup preserve the parent header and theme", () => {
    const { mode, controller, root, scroll, lines } = setup();
    controller.detach();
    install(mode);
    mount(mode);
    lines();
    scroll.scrollBy(-5);
    const before = renderLayoutFrame(root, 40, 10, () => {}).lines;
    const header = root.children[0];
    const updateLayout = scroll.updateLayout;
    const children = [install(), install()];
    expect(root.children[0]).toBe(header);
    for (const [index, child] of children.entries()) {
      child.emit("session_start", {
        mode: ["sdk", "rpc"][index], sessionManager: {},
        get ui() { throw new Error("headless UI must not be read"); },
      });
      child.shutdown();
      expect(root.children).toHaveLength(3);
      expect(root.children[0]).toBe(header);
      expect(scroll.updateLayout).toBe(updateLayout);
      expect(renderLayoutFrame(root, 40, 10, () => {}).lines).toEqual(before);
    }
    mount(mode);
    expect(root.children[0]).toBe(header);
  });

  test("only the owning TUI shutdown removes its header", () => {
    const first = setup();
    const second = setup();
    first.controller.detach();
    second.controller.detach();
    const firstRuntime = install(first.mode);
    const secondRuntime = install(second.mode);
    mount(first.mode);
    mount(second.mode);
    firstRuntime.shutdown();
    expect(first.root.children).toHaveLength(2);
    expect(second.root.children).toHaveLength(3);
    secondRuntime.shutdown();
    expect(second.root.children).toHaveLength(2);
  });

  test("a stale runtime cannot remove the replacement owner's header", () => {
    const { mode, controller, root } = setup();
    controller.detach();
    const previous = install(mode);
    mount(mode);
    install(mode);
    mount(mode);
    const header = root.children[0];
    previous.shutdown();
    expect(root.children).toHaveLength(3);
    expect(root.children[0]).toBe(header);
    mount(mode);
    expect(root.children[0]).toBe(header);
  });

  test("initial mount before session binding stays native until TUI history renders", () => {
    const { mode, controller, root } = setup();
    controller.detach();
    const runtime = install();
    mount(mode);
    expect(root.children).toHaveLength(2);
    runtime.emit("session_start", { mode: "sdk", sessionManager: mode.sessionManager, ui: {} });
    mount(mode);
    expect(root.children).toHaveLength(2);
    runtime.emit("session_start", { mode: "tui", sessionManager: mode.sessionManager, ui: {} });
    expect(root.children).toHaveLength(3);
    (InteractiveMode.prototype as any).renderSessionItems.call(mode, []);
    expect(root.children).toHaveLength(3);
  });

  test("reload and session replacement restore an idle header after history renders before binding", () => {
    for (const replaceSession of [false, true]) {
      const { mode, controller, root, scroll, lines } = setup();
      controller.detach();
      const old = install(mode);
      mount(mode);
      old.shutdown();
      expect(root.children).toHaveLength(2);
      if (replaceSession) mode.sessionManager = {};
      const next = install();
      // Pi rebuilds history in beforeSessionStart; it does not remount afterward.
      (InteractiveMode.prototype as any).renderSessionItems.call(mode, []);
      expect(root.children).toHaveLength(2);
      next.emit("session_start", { mode: "tui", sessionManager: mode.sessionManager, ui: {} });
      expect(root.children).toHaveLength(3);
      old.shutdown();
      lines();
      scroll.scrollBy(-5);
      expect(lines()[0]).toStartWith("❯ Latest prompt");
      expect(root.children).toHaveLength(3);
    }
  });

  test("mounting uses the same root/viewport and reload never stacks headers", () => {
    const { mode, controller, root, scroll } = setup();
    controller.detach();
    const { shutdown } = install(mode);
    const hook = (InteractiveMode.prototype as any).mountInteractiveTui;
    expect(mount(mode)).toEqual([root]);
    expect(root.children).toHaveLength(3);
    expect(mode.transcriptScrollView).toBe(scroll);
    mount(mode);
    expect(root.children).toHaveLength(3);
    shutdown();
    expect(root.children).toHaveLength(2);
    install(mode);
    expect((InteractiveMode.prototype as any).mountInteractiveTui).toBe(hook);
    mount(mode);
    expect(root.children).toHaveLength(3);
  });
});
