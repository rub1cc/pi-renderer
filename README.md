# Codex-style tool renderer

This Pi extension gives the built-in coding tools a compact, transcript-like
presentation inspired by the Codex CLI:

```text
• Read src/auth.ts

• Ran npm test (1.4s)
  └ Tests: 12 passed

• Searched /refreshSession/ in src
  └ src/auth.ts:42: return refreshSession(token)
    … +4 lines (ctrl+e to expand)
```

## Behavior

- Transparent activity rows instead of full-width status cards.
- Semantic `Reading`/`Read`, `Running`/`Ran`, `Searching`/`Searched`,
  `Writing`/`Wrote`, and `Editing`/`Edited` states.
- Three-row collapsed previews with Pi's native click/`ctrl+e` expansion.
- Tail previews for shell output and leading previews for search/file output.
- Width-aware wrapping, tree gutters, errors, edit statistics, and shell
  durations.
- Claude Code-style cancellation when Escape aborts before any tool starts: the
  empty aborted turn is removed and the submitted prompt returns to the editor.
  Aborts after tool execution remain visible in the transcript.
- Tool execution payloads and completed-turn model content are unchanged.

The extension registers `read`, `grep`, `find`, `ls`, `write`, and `edit`.
It deliberately does not register `bash` or `apply_patch`.

Extension tools that provide no renderer receive a generic Codex-style
fallback:

```text
• Called TaskUpdate({"taskId":"6","status":"completed"})
  └ Updated task #6 status
```

The fallback is applied only at Pi's final interactive presentation lookup. It
does not re-register the tool or replace its execution function, and tools that
already provide either renderer callback remain untouched.

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

`../sandbox/index.ts` remains the only extension that registers `bash`. It
imports `codexBashRenderers` from this extension and adds those renderer
callbacks to its existing sandbox-owned tool definition. This avoids a
duplicate registration that could otherwise bypass OS-level sandboxing.

`apply_patch` keeps its dedicated rich diff renderer.

## Architecture

- `components.ts` contains reusable activity and tree-preview components.
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

