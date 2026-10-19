import { afterEach } from "bun:test";
import { installReadGrouping } from "../read-groups.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export function installReadGroupingForTest(host?: any) {
  const handlers = new Map<string, (event: any, context: any) => void>();
  installReadGrouping({
    on(name: string, handler: (event: any, context: any) => void) {
      handlers.set(name, handler);
      return () => {};
    },
  } as any);
  const runtime = {
    start(context: any) { handlers.get("session_start")?.({ type: "session_start" }, context); },
    shutdown(reason = "quit") { handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, {}); },
  };
  cleanups.push(() => runtime.shutdown());
  if (host) runtime.start({ mode: "tui", sessionManager: host.sessionManager, ui: { theme: undefined } });
  return runtime;
}
