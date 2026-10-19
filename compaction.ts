import {
  CompactionSummaryMessageComponent,
  keyText,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  Markdown,
  type MarkdownTheme,
  MouseRegion,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ACTIVITY_MARKER, treeOutputPrefix } from "./components.ts";

const PATCH_KEY = Symbol.for("pi.codex-tool-renderer.compaction");

export interface CompactionMessage {
  summary: string;
  tokensBefore: number;
}

interface CompactionComponentLike extends Component {
  expanded: boolean;
  message: CompactionMessage;
  markdownTheme: MarkdownTheme;
  setExpanded(expanded: boolean): void;
}

type Render = (this: CompactionComponentLike, width: number) => string[];
type Invalidate = (this: CompactionComponentLike) => void;

interface CompactionPatch {
  controller: CompactionRenderer;
  originalRender: Render;
  originalInvalidate: Invalidate;
  renderWrapper: Render;
  invalidateWrapper: Invalidate;
}

interface CompactionPrototype {
  render: Render;
  invalidate: Invalidate;
  [PATCH_KEY]?: CompactionPatch;
}

interface CachedView {
  expanded: boolean;
  markdownTheme: MarkdownTheme;
  summary: string;
  tokensBefore: number;
  component: Component;
}

/** Adds a tree gutter to Pi's Markdown component without flattening its styles. */
class TreeMarkdownComponent implements Component {
  constructor(
    private readonly markdown: Markdown,
    private readonly markdownTheme: MarkdownTheme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rawPrefix = treeOutputPrefix(safeWidth);
    const prefixWidth = visibleWidth(rawPrefix);
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const lines = this.markdown.render(contentWidth);

    return lines.map((line, index) => {
      const prefix = index === 0
        ? this.markdownTheme.listBullet(rawPrefix)
        : " ".repeat(prefixWidth);
      return truncateToWidth(`${prefix}${line}`, safeWidth, "…");
    });
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

function shortcutText(): string {
  return keyText("app.tools.expand") || "ctrl+o";
}

/** Build the flat, clickable transcript view used for a compaction entry. */
export function createCompactionTranscriptComponent(
  message: CompactionMessage,
  expanded: boolean,
  markdownTheme: MarkdownTheme,
  onToggle: () => void,
): Component {
  const content = new Container();
  const title = markdownTheme.bold("Compacted context");
  const tokenText = message.tokensBefore.toLocaleString();
  const hint = expanded ? "" : ` · ${shortcutText()} to expand`;
  const metadata = markdownTheme.linkUrl(`(${tokenText} tokens${hint})`);

  content.addChild(new Text(`${markdownTheme.listBullet(ACTIVITY_MARKER)} ${title} ${metadata}`, 0, 0));
  if (expanded && message.summary) {
    content.addChild(
      new TreeMarkdownComponent(
        new Markdown(message.summary, 0, 0, markdownTheme),
        markdownTheme,
      ),
    );
  }

  return new MouseRegion(content, (event) => {
    if (event.type !== "click" || event.button !== "left") return;
    onToggle();
    return { handled: true };
  });
}

class CompactionRenderer {
  private readonly views = new WeakMap<object, CachedView>();

  render(
    component: CompactionComponentLike,
    width: number,
    fallback: Render,
  ): string[] {
    const { expanded, markdownTheme, message } = component;
    if (
      !message ||
      typeof message.summary !== "string" ||
      typeof message.tokensBefore !== "number" ||
      !Number.isFinite(message.tokensBefore) ||
      !markdownTheme
    ) {
      return fallback.call(component, width);
    }

    let view = this.views.get(component);
    if (
      !view ||
      view.expanded !== expanded ||
      view.markdownTheme !== markdownTheme ||
      view.summary !== message.summary ||
      view.tokensBefore !== message.tokensBefore
    ) {
      view = {
        expanded,
        markdownTheme,
        summary: message.summary,
        tokensBefore: message.tokensBefore,
        component: createCompactionTranscriptComponent(
          message,
          expanded,
          markdownTheme,
          () => component.setExpanded(!component.expanded),
        ),
      };
      this.views.set(component, view);
    }

    return view.component.render(width);
  }

  invalidate(component: CompactionComponentLike): void {
    this.views.delete(component);
  }
}

/** Replace Pi's full-width compaction card with a flat transcript entry. */
export function installCompactionRenderer(): void {
  const prototype = CompactionSummaryMessageComponent.prototype as unknown as CompactionPrototype;
  let patch = prototype[PATCH_KEY];

  if (!patch) {
    const originalRender = prototype.render;
    const originalInvalidate = prototype.invalidate;
    patch = {
      controller: new CompactionRenderer(),
      originalRender,
      originalInvalidate,
      renderWrapper: function (width) {
        return patch!.controller.render(this, width, patch!.originalRender);
      },
      invalidateWrapper: function () {
        patch!.controller.invalidate(this);
        patch!.originalInvalidate.call(this);
      },
    };
    Object.defineProperty(prototype, PATCH_KEY, {
      configurable: false,
      enumerable: false,
      value: patch,
      writable: false,
    });
  } else {
    // The prototype survives extension reloads. Swap in fresh module state while
    // keeping the original methods captured by the first installation.
    patch.controller = new CompactionRenderer();
  }

  prototype.render = patch.renderWrapper;
  prototype.invalidate = patch.invalidateWrapper;
}
