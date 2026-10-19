import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("reload retires legacy prototype hooks before binding session-owned controllers", () => {
  // A separate process starts with the legacy global state, not the new hooks
  // installed by the other integration tests.
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { AssistantMessageComponent, getMarkdownTheme, initTheme, InteractiveMode }
      from "@earendil-works/pi-coding-agent";
    import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
    import { installReadGrouping, ReadGroupingController } from "./read-groups.ts";

    await initTheme("light", false);
    const prototype = InteractiveMode.prototype;
    const controllerKey = Symbol.for("pi.codex-tool-renderer.read-groups.controller");
    const generationKey = Symbol.for("pi.codex-tool-renderer.read-groups.generation");
    const legacy = {
      generation: 1,
      getTheme: () => { throw new Error("stale legacy context"); },
      factory: host => new ReadGroupingController(host, () => legacy.getTheme?.()),
    };
    Object.defineProperty(prototype, Symbol.for("pi.codex-tool-renderer.read-groups.patch"), { value: legacy });
    const original = prototype.handleEvent;
    prototype.handleEvent = function (...args) {
      if (!this[controllerKey] || this[generationKey] !== legacy.generation) {
        this[controllerKey]?.detach();
        this[controllerKey] = legacy.factory(this);
        this[generationKey] = legacy.generation;
      }
      this[controllerKey].attach();
      return original.apply(this, args);
    };
    const host = {
      isInitialized: true, sessionManager: {}, chatContainer: new Container(),
      hideThinkingBlock: false, toolOutputExpanded: false,
      footer: { invalidate() {} }, programStatus: { handleEvent() {} },
      ui: { requestRender() {} },
    };
    const emit = () => prototype.handleEvent.call(host, { type: "repro" });
    await emit();
    host.chatContainer.addChild(new AssistantMessageComponent({
      role: "assistant", content: [{ type: "text", text: "Upgrade reply." }],
      stopReason: "stop", timestamp: 1,
    }, false, getMarkdownTheme()));
    const render = () => host.chatContainer.render(80).map(stripTerminalSequences).join("\\n");
    assert.throws(render, /stale legacy context/);
    const handlers = new Map();
    const pi = { on(name, handler) { handlers.set(name, handler); return () => {}; } };
    installReadGrouping(pi);
    assert.doesNotThrow(render);
    handlers.get("session_start")({}, { mode: "tui", sessionManager: host.sessionManager, ui: { theme: undefined } });
    await emit();
    assert.equal(render().split("\\u23fa").length - 1, 1);
    assert.ok(render().includes("Upgrade reply."));
    const wrapper = host.chatContainer.render;
    const generation = legacy.generation;
    installReadGrouping({ on() { return () => {}; } });
    await emit();
    assert.equal(legacy.generation, generation);
    assert.equal(host.chatContainer.render, wrapper);
    handlers.get("session_shutdown")({ reason: "reload" }, {});
    await emit();
    assert.ok(!render().includes("\\u23fa"));
    assert.ok(render().includes("Upgrade reply."));
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
