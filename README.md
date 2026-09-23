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
- Execution results and model-facing content are unchanged.

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
- `index.ts` registers only the safe non-bash built-in overrides.

Codex combines consecutive reads, searches, and listings into one `Explored`
history cell. Pi's public renderer API operates on one tool call at a time, so
this extension adopts Codex's visual language without unsafe transcript-level
interception.

