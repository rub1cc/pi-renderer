# @rub1cc/pi-renderer

This Pi extension gives the built-in coding tools a compact, transcript-like
presentation inspired by the Codex CLI:

## Install

```bash
pi install npm:@rub1cc/pi-renderer
```

Try it for one invocation without adding it to settings:

```bash
pi -e npm:@rub1cc/pi-renderer
```

```text
• Read src/auth.ts

• Ran npm test (1.4s)
  └ Tests: 12 passed

• Searched /refreshSession/ in src
  └ src/auth.ts:42: return refreshSession(token)
    … +4 lines (ctrl+o to expand)
```

## Behavior

- Transparent activity rows instead of full-width status cards.
- Semantic `Reading`/`Read`, `Running`/`Ran`, `Searching`/`Searched`,
  `Writing`/`Wrote`, and `Editing`/`Edited` states.
- Three-row previews for most tool output; successful reads stay header-only
  until expanded.
- `edit` and `apply_patch` use the same unified diff renderer: full-row red/green
  backgrounds on changes, transparent context, and matching line-number gutters.
- Edit diffs up to 24 visual rows appear in full. Larger diffs show a 24-row
  preview; expanding reveals every available diff row with wrapped long lines
  and a collapse hint.
- Pi's native click/`ctrl+o` expansion, with hints following configured keys.
- Flat, clickable compaction rows in place of Pi's full-width purple card;
  `ctrl+o` still expands the generated context summary.
- Tail previews for shell output and leading previews for search/file output.
- Width-aware wrapping, tree gutters, errors, edit statistics, and shell
  durations.
- Claude Code-style cancellation when Escape aborts before any tool starts: the
  empty aborted turn is removed and the submitted prompt returns to the editor.
  Aborts after tool execution remain visible in the transcript.
- Tool execution payloads and completed-turn model content are unchanged.

The extension registers `read`, `grep`, `find`, `ls`, `write`, and `edit`.
It deliberately does not register `bash` or `apply_patch`.
`edit` and `write` are registered with hidden exposure: they are unavailable to
the model and nested tool calls, but their renderers remain available for
historical results. Use `apply_patch` for file creation and edits instead.

Extension tools that provide no renderer receive a generic Codex-style
fallback:

```text
• Called TaskUpdate({"taskId":"6","status":"completed"})
  └ Updated task #6 status
```

The fallback uses Pi's public `registerToolRenderer` API (Pi 1.0.1+), including
for tools not yet registered when a session is resumed. It does not re-register
the tool or replace its execution function. Renderers supplied by later
resolvers or registered tools remain untouched when either callback is present.

The `Agent` tool is the deliberate exception. `pi-subagents` supplies a
Claude-style full-width card, so the renderer replaces only its presentation
with flat `Running`/`Ran`/`Started` bullet states and a bounded activity/result
tree. Agent execution and progress metadata are preserved. Other rich custom
renderers, including `SubagentWorkflow`, remain untouched.

The web-access tools are also adapted because their native search/fetch cards
use a full-width shell. `web_search`, `source_check`, `fetch_content`, and
`get_search_content` receive semantic bullet states while keeping their
model-facing results unchanged. Background content-ready and fetch-error
messages use the same flat activity-and-tree layout instead of Pi's default
purple custom-message card.

## Bash and sandboxing

`@rub1cc/pi-sandbox` remains the only extension that registers `bash`. It
imports `codexBashRenderers` from this package's `./renderers` export and adds
those renderer callbacks to its existing sandbox-owned tool definition. This
avoids a duplicate registration that could otherwise bypass OS-level
sandboxing.

The renderer imports only the presentation API from
`@rub1cc/pi-apply-patch/renderer`; it does not register or execute `apply_patch`.
That dependency is bundled so installation does not require a sibling checkout.
In this workspace it is linked to `../apply_patch` so both tools use the same
source. Before publishing, verify `npm pack --dry-run` includes the bundled
`node_modules/@rub1cc/pi-apply-patch/renderer` files.

## Architecture

- `components.ts` contains reusable activity and tree-preview components.
- `compaction.ts` replaces Pi's compaction card presentation while preserving
  its native summary, shortcut, and click-to-expand behavior.
- `renderers.ts` contains tool-specific presentation and exports the composable
  bash renderer.
- `generic.ts` supplies presentation for renderer-less third-party tools
  without taking ownership of their execution.
- `web.ts` adapts pi-web-access tools and asynchronous fetch notifications
  without changing their search, fetch, or storage behavior.
- `cancellation.ts` restores no-action aborted prompts and moves the append-only
  session onto a hidden marker branch so the cancellation survives restart.
- `index.ts` registers only the safe non-bash built-in overrides.

Codex combines consecutive reads, searches, and listings into one `Explored`
history cell. Pi's public renderer API operates on one tool call at a time, so
the tool presentation adopts Codex's visual language without taking ownership
of execution. No public API currently exists for removing an empty aborted
turn, so `cancellation.ts` limits its TUI-only patch to that behavior and leaves
aborts after tool execution on Pi's normal path.

