import {
  InteractiveMode,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { inlineText } from "./components.ts";

const PATCH = Symbol.for("pi.codex-tool-renderer.working-indicator");
export const WORKING_FRAMES = ["✽", "✻", "✢", "∙", "✢", "✻", "✽"] as const;
export const WORKING_FRAME_MS = 150;
const SHIMMER_MS = 2000;
const REFRESH_MS = 80;
const RECEIPT_THRESHOLD_MS = 10000;

type Method = (this: any, ...args: any[]) => any;
interface MethodPatch {
  target: any;
  name: string;
  original: Method;
  own?: PropertyDescriptor;
  wrapper: Method;
}

export function formatWorkingDuration(milliseconds: number): string {
  let seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const units = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const;
  const parts: string[] = [];
  for (const [size, suffix] of units) {
    const value = Math.floor(seconds / size);
    seconds %= size;
    if (value || parts.length || suffix === "s") parts.push(`${value}${suffix}`);
  }
  return parts.join(" ");
}

/** A terminal-only view; time is monotonic and never enters session messages. */
export class WorkingIndicatorComponent implements Component {
  constructor(
    private readonly startedAt: number,
    private readonly getTheme: () => Theme | undefined,
    private readonly getMessage: () => string = () => "Working",
    private readonly now: () => number = () => performance.now(),
    private readonly reducedMotion = false,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [];
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const frame = this.reducedMotion ? 0 : Math.floor(elapsed / WORKING_FRAME_MS) % WORKING_FRAMES.length;
    const label = `${WORKING_FRAMES[frame]} ${inlineText(this.getMessage()).slice(0, 160) || "Working"}`;
    const theme = this.getTheme();
    const chars = Array.from(label);
    const center = (elapsed % SHIMMER_MS) / SHIMMER_MS * (chars.length + 4) - 2;
    const shimmer = chars.map((char, index) => {
      if (!theme) return char;
      if (this.reducedMotion) return theme.fg(index === 0 ? "accent" : "muted", char);
      const strength = Math.max(0, 1 - Math.abs(index - center) / 2);
      return theme.style(char, {
        fg: mixColors(theme.colors[index === 0 ? "accent" : "muted"], theme.colors.text, strength),
      });
    }).join("");
    const duration = ` (${formatWorkingDuration(elapsed)})`;
    return ["", truncateToWidth(` ${shimmer}${theme ? theme.fg("muted", duration) : duration}`, width, "")];
  }
}

/** Frozen completion time with a static marker and no animation timer. */
export class WorkedDurationComponent implements Component {
  constructor(
    private readonly duration: number,
    private readonly getTheme: () => Theme | undefined,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [];
    const text = ` ✽ Worked for ${formatWorkingDuration(this.duration)}`;
    const theme = this.getTheme();
    return ["", truncateToWidth(theme ? theme.fg("muted", text) : text, width, "")];
  }
}

function patchMethod(target: any, name: string, wrapper: Method): MethodPatch {
  const patch = { target, name, original: target[name], own: Object.getOwnPropertyDescriptor(target, name), wrapper };
  target[name] = wrapper;
  return patch;
}

function restore(patch: MethodPatch): void {
  if (patch.target[patch.name] !== patch.wrapper) return;
  if (patch.own) Object.defineProperty(patch.target, patch.name, patch.own);
  else delete patch.target[patch.name];
}

export class WorkingIndicatorController {
  private renderPatch?: MethodPatch;
  private indicatorPatches: MethodPatch[] = [];
  private indicator?: any;
  private view?: WorkingIndicatorComponent;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt?: number;
  private receipt?: WorkedDurationComponent;
  private receiptAnchor?: any;
  private failed = false;
  private disabled = false;

  constructor(
    private readonly mode: any,
    private readonly getTheme: () => Theme | undefined,
    private readonly now: () => number = () => performance.now(),
    private readonly reducedMotion = process.env.PI_RENDERER_REDUCED_MOTION === "1",
  ) {}

  recordEvent(event: { type?: string; aborted?: boolean; message?: any; messages?: any[] }): void {
    if (this.disabled) return;
    // agent_end can be followed by automatic recovery. Reset only on settlement.
    if (event.type === "agent_start" && this.startedAt === undefined) {
      this.startedAt = this.now();
      this.receipt = undefined;
      this.receiptAnchor = undefined;
      this.failed = false;
    }
    const message = event.type === "message_end" ? event.message
      : event.type === "agent_end" ? event.messages?.filter(message => message?.role === "assistant").at(-1) : undefined;
    if (message?.role === "assistant") {
      this.failed = ["aborted", "error", "length"].includes(message.stopReason);
    }
    if (event.type === "agent_settled") {
      const duration = this.startedAt === undefined ? 0 : Math.max(0, this.now() - this.startedAt);
      const anchor = this.mode.chatContainer?.children?.at(-1);
      if (this.renderPatch && anchor && !event.aborted && !this.failed && duration >= RECEIPT_THRESHOLD_MS) {
        this.receipt = new WorkedDurationComponent(duration, this.getTheme);
        this.receiptAnchor = anchor;
      }
      this.startedAt = undefined;
      this.mode.ui?.requestRender?.();
    }
  }

  adopt(indicator: any): boolean {
    if (this.disabled || indicator?.kind !== "working" || indicator !== this.mode.activeStatusIndicator) return false;
    if (this.indicator === indicator) return true;
    const container = this.mode.chatContainer;
    if (!container || typeof container.render !== "function" ||
      typeof this.mode.ui?.requestRender !== "function" ||
      !["render", "renderInBorder", "renderSpinnerInBorder", "dispose", "start", "stop"]
        .every(name => typeof indicator[name] === "function")) return false;
    this.release(false);
    try {
      if (!this.renderPatch || this.renderPatch.target !== container) {
        if (this.renderPatch) restore(this.renderPatch);
        const original = container.render;
        const controller = this;
        this.renderPatch = patchMethod(container, "render", function (width: number) {
          // Keep native rendering/errors and mouse layout intact. The passive tail
          // lives inside the transcript viewport, but never splits activity groups.
          const rows = original.call(this, width);
          if (controller.disabled) return rows;
          const live = controller.mode.activeStatusIndicator === controller.indicator ? controller.view : undefined;
          // A receipt belongs only to the just-completed transcript tail. Rebuilds,
          // branch changes, and later messages must not inherit stale timing.
          const receipt = this.children?.at(-1) === controller.receiptAnchor ? controller.receipt : undefined;
          const tail = live ?? receipt;
          if (!tail) return rows;
          try { return [...rows, ...tail.render(width)]; }
          catch { controller.detach(); return rows; }
        });
      }
      this.indicator = indicator;
      this.startedAt ??= this.now();
      this.view = new WorkingIndicatorComponent(
        this.startedAt, this.getTheme, () => indicator.message ?? "Working", this.now, this.reducedMotion,
      );
      // Pi still owns the active indicator and its disposal. Suppress only its
      // native border/status-row presentation, including after editor changes.
      const controller = this;
      for (const name of ["render", "renderInBorder", "renderSpinnerInBorder"]) {
        const original = indicator[name];
        this.indicatorPatches.push(patchMethod(indicator, name, function (...args) {
          if (controller.disabled || controller.indicator !== this) return original.apply(this, args);
          return name === "render" ? [] : "";
        }));
      }
      const originalDispose = indicator.dispose;
      this.indicatorPatches.push(patchMethod(indicator, "dispose", function (...args) {
        if (controller.indicator === this) controller.release(false);
        return originalDispose.apply(this, args);
      }));
      indicator.stop();
      // setWorkingIndicator() may call Loader.setIndicator() again mid-run.
      // Keep its native timer stopped while this view owns redraws.
      const originalStart = indicator.start;
      this.indicatorPatches.push(patchMethod(indicator, "start", function (...args) {
        if (controller.disabled || controller.indicator !== this) return originalStart.apply(this, args);
      }));
      this.timer = setInterval(() => {
        if (this.mode.activeStatusIndicator !== indicator) this.release(false);
        this.mode.ui.requestRender();
      }, this.reducedMotion ? 1000 : REFRESH_MS);
      this.timer.unref?.();
      this.mode.ui.requestRender();
      return true;
    } catch {
      this.detach();
      return false;
    }
  }

  private release(resume: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const indicator = this.indicator;
    this.indicator = undefined;
    this.view = undefined;
    for (const patch of this.indicatorPatches.reverse()) restore(patch);
    this.indicatorPatches = [];
    if (resume && indicator === this.mode.activeStatusIndicator) indicator?.start();
  }

  detach(resumeNative = true): void {
    this.disabled = true;
    this.release(resumeNative);
    if (this.renderPatch) restore(this.renderPatch);
    this.renderPatch = undefined;
    this.startedAt = undefined;
    this.receipt = undefined;
    this.receiptAnchor = undefined;
  }
}

interface PatchState {
  enabled: boolean;
  controllers: Map<any, WorkingIndicatorController>;
  factory: (mode: any) => WorkingIndicatorController;
  getTheme?: () => Theme | undefined;
}

/** Guarded Pi 1.3 status hooks; unsupported shapes retain their native loader. */
export function installWorkingIndicator(pi: ExtensionAPI): void {
  const prototype = InteractiveMode.prototype as any;
  let state = prototype[PATCH] as PatchState | undefined;
  if (!state) {
    if (!["showStatusIndicator", "handleEvent"].every(name => typeof prototype[name] === "function")) return;
    state = { enabled: false, controllers: new Map(), factory: undefined! };
    Object.defineProperty(prototype, PATCH, { value: state });
    const shared = state;
    const getController = (mode: any): WorkingIndicatorController | undefined => {
      if (!shared.enabled) return;
      let controller = shared.controllers.get(mode);
      if (!controller) {
        controller = shared.factory(mode);
        shared.controllers.set(mode, controller);
      }
      return controller;
    };
    const showStatus = prototype.showStatusIndicator;
    prototype.showStatusIndicator = function (...args: any[]) {
      const result = showStatus.apply(this, args);
      if (args[0]?.kind === "working") {
        try { getController(this)?.adopt(args[0]); }
        catch { shared.controllers.get(this)?.detach(); }
      }
      return result;
    };
    const handleEvent = prototype.handleEvent;
    prototype.handleEvent = function (...args: any[]) {
      getController(this)?.recordEvent(args[0] ?? {});
      return handleEvent.apply(this, args);
    };
  }
  const shared = state;
  // Prototype hooks survive /reload; swap controllers, not another wrapper layer.
  for (const controller of shared.controllers.values()) controller.detach();
  shared.controllers.clear();
  shared.enabled = true;
  shared.factory = mode => new WorkingIndicatorController(mode, () => shared.getTheme?.());
  pi.on("session_start", (_event, context) => { shared.getTheme = () => context.ui.theme; });
  pi.on("session_shutdown", (event) => {
    shared.enabled = false;
    for (const controller of shared.controllers.values()) controller.detach(event.reason === "reload");
    shared.controllers.clear();
    shared.getTheme = undefined;
  });
}
