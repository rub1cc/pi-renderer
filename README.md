# @rub1cc/pi-renderer

This Pi extension gives the built-in coding tools a compact, transcript-like
presentation with Claude Code-style exploration summaries:

## Install

```bash
pi install npm:@rub1cc/pi-renderer
```

Try it for one invocation without adding it to settings:

```bash
pi -e npm:@rub1cc/pi-renderer
```

```text
⏺ I will inspect the authentication code and run its tests.

  Searched for 1 pattern, read 1 file, ran 1 shell command

⏺ The tests pass. Here is what I found...
```

## Behavior

- A temporary inline working row at the bottom of the scrolling transcript,
  rather than in the editor border: `✽ Working (1m 15s)`. The symbol cycles
  `✽ → ✻ → ✢ → ∙ → ✢ → ✻ → ✽` with a theme-aware text shimmer. Elapsed time
  includes days, hours, minutes, and seconds as needed; it continues across tool
  rounds and automatic recovery until the run settles. Retry and compaction
  indicators keep their native placement. Nothing is added to saved messages.
  Successful turns lasting at least 10 seconds leave a muted `✽ Worked for 1m 15s`
  receipt until the next run or transcript change. Short, cancelled, and failed
  turns leave no receipt; receipts are not reconstructed from saved history.
  Set `PI_RENDERER_REDUCED_MOTION=1` for a static symbol and no shimmer.
- One `⏺` marker per visible assistant prose message, including progress updates
  and final replies. Paragraphs and wrapped continuation lines align with the
  text. Thinking-only and tool-only messages do not get a marker; tool calls and
  active or failed activity groups keep their small `•` dots. Successful group
  receipts are muted and dot-free. This is terminal-only presentation:
  model-facing content, saved messages, and non-TUI output are unchanged.
- Transparent activity rows instead of full-width status cards.
- Small `•` activity dots, aliased `Label(arguments)` tool headers, and `⎿` output gutters.
  Active labels distinguish `preparing…`, `waiting…`, and actual `running…`;
  failures keep an explicit red `Failed` suffix. Completed labels stay stable.
- Display-only aliases such as `Read`, `Grep`, `Glob`, `List`, `Bash`, `Patch`,
  `WebSearch`, `CheckSources`, `WebFetch`, and `WebContent`. Actual tool names,
  arguments, execution, and session records are unchanged.
- Three-row previews for most tool output; successful reads stay header-only
  until expanded.
- `edit` and `apply_patch` use the same unified diff renderer: full-row red/green
  backgrounds on changes, transparent context, and matching line-number gutters.
- Edit and patch diffs show every changed hunk inline by default, with wrapped
  long lines and a collapse hint. Clicking their header or body toggles a compact
  24-row preview. The local view survives redraws and resizing; global tool
  expansion/collapse changes override it without affecting other tool defaults.
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
- `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskExecute`, `TaskOutput`,
  and `TaskStop` rows are hidden from interactive previews, summaries, and
  expanded tool history. They do not replace the current activity preview or
  split a group. Task failures and image artifacts remain visible, including
  background failures reported by `TaskOutput` and details-only errors. Task
  execution, saved records, approval dialogs, and task progress widgets are
  unchanged. Replay and reload apply the same visibility rules.

### Exploration groups

Consecutive `read`, `grep`, `find`, `ls`, and `bash` calls collapse into a combined
Claude Code-style summary, including groups containing only one call:

```text
  Read 1 file
  Ran 1 shell command
  Searched for 1 pattern, read 2 files, listed 1 directory, ran 3 shell commands
```

`grep` and `find` each count as a pattern search. Reads count distinct normalized
file paths; listings count distinct normalized directory paths. Repeated file or
directory paths count once, with the total number of calls shown separately.
Shell calls count commands, without trying to infer file reads or other effects
from their scripts. Unused categories are omitted. During live work, the group
shows only the latest operation, not aggregate counters:

```text
  Reading package.json
  ⎿ /path/to/package.json
```

The next executing tool replaces that preview in place:

```text
  Running pwd
  ⎿ /Users/raz/project
```

Reads show the file basename in the title and full normalized path in the
gutter. Commands and other inspections show up to three visual rows of output;
shell previews use the tail. Empty output shows `No output`. Output can update
while executing, but completion does not change the title or replace the preview
with a count or waiting label. The last useful preview stays while the next
call's arguments stream. Before the first call has usable arguments, no empty
tool placeholder is shown. Parallel calls select the most recently started
operation, not whichever older operation finishes last.

Only when assistant prose resumes does the preview become a muted count receipt:

```text
  Read 1 file, ran 1 shell command

⏺ Here is what I found...
```

There are no artificial execution delays. A normal run ending without prose
keeps the preview. Visible consequential actions, notices, reasoning, and
interruptions still form boundaries; errors and diffs stay reviewable.
Single calls follow the same lifecycle. Empty text placeholders and hidden
thinking do not close a live preview. Expanding a group reveals original calls
without a duplicate gutter preview. Replay shows historical count summaries,
not invented live activity or waiting states.

With `/settings` -> `Hide thinking` on, thinking blocks disappear entirely (no
collapsed label or leftover spacing), and exploration calls can group across
hidden thinking and assistant-message boundaries: `Read A` -> thinking ->
`Read B` becomes `Read 2 files`.

With `Hide thinking` off, reasoning remains visible and groups stop at thinking.
Tool-only assistant messages do not break a group under either setting.
Text, non-routine tools, visible user/custom
messages, interruption notices, and unknown transcript components always break
groups. Edits, `apply_patch`, writes, questions, and unknown actions remain
separate. Shell commands (including `ls` or `cat` run through Bash) join the
exploration group but count only as shell commands. Image reads collapse like
text reads; expanding the group reveals the original read and its image when
Pi's image display is enabled. Images returned by other tools remain outside
groups so artifacts do not disappear into a count.
Changing the existing setting updates displayed reasoning and grouping without
changing saved messages or recreating tool components.

In fullscreen, click the group header to reveal individual calls in their
original order, then click a tool's row to expand its output. Closing a group
preserves individual row state. Pi's global tool expansion shortcut (default
`ctrl+o`) expands/collapses both groups and their contents, including in regular
terminal mode. Failure counts stay at the front of group summaries so they
remain visible when long summaries are truncated on narrow terminals. The first
failed target and error appear separately beneath a collapsed summary, wrapping
to at most three visual rows. Expanding reveals the original tool errors.

```text
• 1 failed · Searched for 1 pattern, read 2 files
  ⎿ src/auth.ts: Permission denied
```

This is transcript-only grouping: original tool components, arguments, results,
and session records are retained. HTML exports remain ungrouped. It uses guarded
private transcript hooks tested against Pi 1.3.0; unknown host/component shapes
fall back to normal per-call rendering.

### Other routine activity

Other safe routine calls share the replace-in-place preview. Completed summaries
retain their category-specific operation counts:

```text
  Web research · 2 searches, 3 fetches, 5 content reads
  Status checks · 3 agent checks
  Browser inspection · 2 snapshots, 1 read
```

- Web research includes `web_search`, `source_check`, `fetch_content`, and
  `get_search_content`. Counts describe tool operations, not query counts,
  URLs, unique targets, or claims of successful completion.
- Status checks include `get_subagent_result`. Task tool rows, including
  `TaskOutput`, remain hidden unless they report a failure or contain an image.
- Browser inspection uses a strict allowlist of native `snapshot`, supported
  `get`, and `is` commands. Clicks, typing, navigation, screenshots, batches,
  arbitrary code, unknown flags, and output writes remain standalone.

Groups can combine these safe categories, but never move calls across
explanations, visible user/custom messages, interruptions, or consequential
actions. Missing tool components still form boundaries. Single calls also receive
category summaries. Hidden-thinking behavior and click/global expansion work
like filesystem groups: expand to see the original aliased calls in order, then
expand individual results as needed. Failure counts and a bounded first error remain visible while collapsed,
including partial web failures and explicitly reported background-task failures.
Returned web/browser images remain ungrouped so artifacts stay visible.

The extension registers `read`, `grep`, `find`, `ls`, `write`, and `edit`.
It deliberately does not register `bash` or `apply_patch`.
`edit` and `write` are registered with hidden exposure: they are unavailable to
the model and nested tool calls, but their renderers remain available for
historical results. Use `apply_patch` for file creation and edits instead.

Extension tools that provide no renderer receive a compact function-style
fallback. Known tools use display aliases and concise argument summaries:

```text
• UpdateTask(#6, completed)
  ⎿ Updated task #6 status
```

The fallback uses Pi's public `registerToolRenderer` API (Pi 1.0.1+), including
for tools not yet registered when a session is resumed. It does not re-register
the tool or replace its execution function. Unknown rich custom renderers remain
untouched. Known aliased tools receive only a header adapter: their native call
state and rich result renderer are preserved.

The `Agent` tool is one deliberate exception. `pi-subagents` supplies a
Claude-style full-width card, so the renderer replaces only its presentation
with `Agent(type, "description")` headers and a bounded activity/result tree.
Agent execution and progress metadata are preserved. `SubagentWorkflow` uses
the `Workflow(name)` header while retaining its rich progress/results view.

The `agent_browser` family also replaces native full-width cards with compact
`Browser(...)` rows (for example, `Browser(snapshot -i)` or `Browser(click @e3)`).
Output previews show three visual rows; expansion reveals the complete wrapped
result. Headers omit arbitrary input values, eval/code bodies, and stdin to
avoid exposing secrets. Failure categories remain failures, and completed
actions are not presented as verified application changes. Tool execution,
text results, and host-rendered image payloads are unchanged.

The web-access tools are also adapted because their native search/fetch cards
use a full-width shell. `web_search`, `source_check`, `fetch_content`, and
`get_search_content` receive aliased function headers while keeping their
model-facing results unchanged. Completed successful calls use concise native
titles and result counts rather than previewing raw Markdown scaffolding and
blank lines. Expanding restores the complete original output. Unknown result
shapes fall back to a normal raw preview; streaming output and error diagnostics
stay visible. Partial query/fetch failures are never summarized as all-success.
Background content-ready and fetch-error
messages use the same flat activity-and-tree layout instead of Pi's default
purple custom-message card.

## Bash and sandboxing

`@rub1cc/pi-sandbox` remains the only extension that registers `bash`. It
imports `codexBashRenderers` from this package's `./renderers` export and adds
those renderer callbacks to its existing sandbox-owned tool definition. This
avoids a duplicate registration that could otherwise bypass OS-level
sandboxing.

The active renderer also resolves Bash presentation through the public
`registerToolRenderer` API. That keeps `/reload` on the current `Bash(...)`
display even when the sandbox's installed dependency bundles an older renderer.
Only the display callbacks change; the sandbox-owned execution function,
parameter schema, and permission checks remain intact.

The renderer imports only the presentation API from
`@rub1cc/pi-apply-patch/renderer`; it does not register or execute `apply_patch`.
That dependency is bundled so installation does not require a sibling checkout.
In this workspace it is linked to `../apply_patch` so both tools use the same
source. Before publishing, verify `npm pack --dry-run` includes the bundled
`node_modules/@rub1cc/pi-apply-patch/renderer` files.

## Architecture

- `components.ts` contains reusable activity and tree-preview components.
- `assistant-replies.ts` adds a width-aware prose gutter while preserving native
  Markdown, thinking click targets, terminal prompt zones, and graphics rows.
- `labels.ts` defines display aliases and bounded argument summaries for task,
  workflow, question, MCP, and other known tool headers.
- `group-model.ts` classifies safe activity categories and formats operation
  counts, live targets, and failure details without changing tool execution.
- `compaction.ts` replaces Pi's compaction card presentation while preserving
  its native summary, shortcut, and click-to-expand behavior.
- `working-indicator.ts` renders an animated, elapsed-time status at the
  transcript tail using guarded Pi 1.3 status hooks and native disposal.
- `renderers.ts` contains tool-specific presentation and exports the composable
  bash renderer.
- `generic.ts` supplies presentation for renderer-less third-party tools
  without taking ownership of their execution.
- `read-groups.ts` decorates the interactive transcript with expandable activity
  groups and fully hides reasoning when the existing setting requests it, while
  retaining original assistant/tool components for native keyboard/mouse behavior.
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

## Releases

See [RELEASING.md](RELEASING.md) for npm trusted publishing and tag-based releases
with `npm version`.

