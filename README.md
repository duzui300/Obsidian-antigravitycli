# Antigravity CLI - Obsidian plugin

Process your notes with **Gemini 3.8 Flash** (and the other models your Antigravity account
offers) from inside Obsidian, through the locally installed **Antigravity CLI** (`agy`).

- **Article presets**: Summarize, Translate, Rewrite, Key points, Title + tags - one click on
  the current note or selection, then **Copy / Insert / Replace selection / Append / New note**
  to put the result back into your vault.
- **Chat** with the note or selection attached, multi-tab, streamed replies, saved history that
  resumes the native conversation.
- **Direct**: the plugin spawns `agy` itself. No Claudian, no gateway, no API key in Obsidian -
  it reuses the CLI's own sign-in.

It is a separate plugin from `hermes-agent` / Claudian and does not touch them.

## How it works

Each chat tab runs one `agy` process in headless **stream-json** mode:

```
agy --input-format stream-json --output-format stream-json --model <slug>
    --add-dir <vault> --mode accept-edits [--conversation <id>] [--dangerously-skip-permissions]
```

The plugin writes one `{"event":"user","message":{"content":...}}` line per turn to stdin and
renders the `step_update` / `result` events from stdout. **Stop** kills the process tree; the tab
keeps its conversation id and the next message resumes it with `--conversation`. Prompts travel
over stdin, so long articles never hit the Windows command-line length limit.

`agy` has no system-prompt flag, so house instructions (reply language, Markdown formatting,
your custom instructions) are appended to each message inside an `<antigravity_app_context>`
block, the same approach the `claudian-antigravity` fork uses.

## Prerequisites

1. Install the Antigravity CLI and sign in once in a terminal. Verify:
   ```powershell
   agy --version
   agy models
   ```
   The model list must print (e.g. `gemini-3.8-flash-high`). If it says you are not logged in,
   run `agy` interactively and sign in; the plugin never handles login.
2. Windows default install path: `%LOCALAPPDATA%\agy\bin\agy.exe` (auto-detected). Set the path in
   settings if yours differs or `agy` is not on PATH when Obsidian starts.
3. Obsidian desktop 1.7.2 or newer. Tested with `agy` 1.2.7 on Windows 10.

## Build

```powershell
cd C:\Users\sr9rfx\.claude-project\Obsidian-antigravitycli\antigravity-cli
npm install
npm run build      # emits main.js
npm test           # unit tests (Node built-in runner; no agy needed)
npm run typecheck
npm run lint
npm run smoke      # optional live test against the real agy (uses quota); add -- --stop to test stop+resume
```

`npm run build` produces `main.js` next to `manifest.json` and `styles.css` - the three files
Obsidian needs.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` into a new plugin folder:

```
<vault>\.obsidian\plugins\antigravity-cli\
  main.js
  manifest.json
  styles.css
```

Then Settings -> Community plugins -> enable **Antigravity CLI**.

## Configure

Settings -> Antigravity CLI:

- **Executable path** - leave empty to auto-detect. Click **Test CLI**: it reports the version,
  whether the CLI is signed in, and loads the model list into the pickers.
- **Default model** - `gemini-3.8-flash-high` by default. The slug carries the reasoning effort
  (high / medium / low); `-medium` is faster for bulk summarizing. Each tab can switch models from
  the footer chip.
- **Reply language** - auto (match the source), Simplified Chinese, or English.
- **Tool access** - *Native permission rules* (default): tools that would need an interactive
  approval are declined and the run continues. *Full access* adds
  `--dangerously-skip-permissions` so the agent can read/write files and run commands in the vault
  without prompts. Article processing needs no tools; leave this on native unless you want
  agentic edits.
- **Working folder** - the agent's cwd and `--add-dir`, relative to the vault root.
- **Idle timeout** - a turn is stopped if `agy` prints nothing for this long (default 120 s).
- **Instructions** - the built-in Markdown reminder and your own custom instructions.
- **Article presets** - edit names, instructions, what they apply to (selection / note / either)
  and the suggested result action; add your own or restore the built-ins.

## Use

- Ribbon **sparkles** icon or command **Antigravity CLI: Open chat view** opens the sidebar.
- Click a **preset** button (or run `Preset: ...` from the command palette). It uses the current
  selection when it has one and the preset accepts it, otherwise the whole current note.
- Or type a message; the **current note** / **selection** toggles attach context. Enter sends,
  Shift+Enter inserts a newline. Send turns into **Stop** while a reply streams.
- Under every reply: **Copy**, **Insert** (at cursor), **Replace selection** (only when the turn
  had a selection; it re-finds the original text even if the cursor moved), **Append to note**,
  **New note** (created next to the source note with a `Source: [[...]]` link). The preset's
  suggested action is outlined.
- Footer: the model chip switches models (and refreshes the list); the folder chip shows the
  working folder and tool-access mode; token counts show the last turn's usage.
- **History** (clock icon) lists saved conversations; opening one restores the messages and
  resumes the native `agy` conversation. Stored in `history.json` in the plugin folder.

### Structured output and frontmatter (Title + tags)

A preset can carry an **output schema** (JSON Schema, editable in settings). Such a preset runs in
its own one-shot `agy --json-schema` session, the CLI returns a parsed object, and the chat shows
its fields (Title, Tags, ...). The **Apply to frontmatter** button merges them into the note's
properties: `title` is set, `tags` are merged with existing ones (normalized: no `#`, lowercase,
hyphenated), other scalar fields are added only if absent. The built-in **Title + tags** preset
ships with a `{title, tags}` schema and suggests this action.

### Batch: run a preset on a folder

Right-click a folder in the file explorer -> **Antigravity: run preset on folder...**, or run the
command **Run preset on folder...**. Pick the preset (note-capable ones only), whether to include
subfolders, and how to write results: **Append to each note**, **New note per source note**, or
**Into frontmatter** (schema presets only). Untick notes you want to skip, then **Start**.

- Notes are processed one at a time, each in a fresh `agy` process (no context bleeds between
  notes). Expect roughly 10-30 s per note including the CLI startup.
- Results are written as soon as each note finishes; **Cancel batch** stops after the current one
  and keeps what was done. Per-note errors are shown in the list and do not stop the batch.
- Notes over 200k characters are skipped.

## Manual test checklist

1. Settings -> **Test CLI** -> "Antigravity CLI 1.2.7 at ... N model(s) available."
2. Open the panel, send "hello" -> a streamed reply; send a second message -> it remembers the first.
3. Open a long article, click **Summarize** -> summary streams; **Append to note** writes it.
4. Select two paragraphs, click **Translate** -> **Replace selection** swaps the text in place.
5. Click **Stop** mid-reply -> streaming halts; Task Manager shows no `agy.exe`; the next message
   continues the same conversation.
6. Close Obsidian -> no `agy.exe` left running.
7. Reopen a conversation from **History** after a restart -> it continues with context.
8. Set a wrong executable path -> a clear "not found" error; sign out of agy -> a clear
   "not logged in" error.
9. (0.2.0) Open a note, click **Title + tags** -> the reply shows Title/Tags fields; **Apply to
   frontmatter** adds `title` and `tags` properties; the chat tab's normal replies stay free text.
10. (0.2.0) Right-click a folder with 2-3 notes -> run **Summarize** with **Append** -> each note
    gets a summary appended; run **Title + tags** with **Into frontmatter** -> properties filled;
    cancel a batch mid-way -> finished notes keep their results and no `agy.exe` remains.

## Troubleshooting

- **"Antigravity CLI (agy) was not found"** - set the executable path in settings (Windows:
  `%LOCALAPPDATA%\agy\bin\agy.exe`).
- **"not logged in"** - run `agy` in a terminal and sign in; then retry.
- **Slow first reply** - `agy` takes several seconds to start and authenticate; later turns in the
  same tab are fast because the process stays alive.
- **Timed out** - raise the idle timeout for long articles with a high-effort model, or use a
  `-medium` / `-low` model.
- **Tools were declined** - expected under native permission rules in headless mode. Article
  presets attach the text directly, so no tools are needed; switch to Full access only if you
  want the agent to edit files itself.
- **Corporate proxy** - the CLI reaches Google through the same environment Obsidian was started
  with. If `agy models` works in a terminal but not from Obsidian, start Obsidian from that same
  terminal environment or set the proxy variables system-wide.
