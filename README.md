# Antigravity CLI for Obsidian

Process your notes with **Gemini 3.8 Flash** (and the other models your Google Antigravity
account offers) from inside Obsidian, through the locally installed **Antigravity CLI** (`agy`).

- **Article presets** - Summarize, Translate, Rewrite, Key points, Title + tags. One click on
  the current note or selection, then **Copy / Insert / Replace selection / Append / New note /
  Apply to frontmatter** to put the result back into your vault.
- **Chat** with the note or selection attached, multi-tab, streamed replies, saved history that
  resumes the native conversation.
- **Batch** - run a preset over every note in a folder, writing results into each note.
- **Direct** - the plugin runs `agy` itself. No proxy service, no API key stored in Obsidian; it
  reuses the CLI's own sign-in.

## Requirements

- **Obsidian** 1.7.2 or newer, desktop only (the plugin spawns a local process).
- **Antigravity CLI** installed and signed in. Verify in a terminal:
  ```sh
  agy --version
  agy models
  ```
  The second command must print the model list (for example `gemini-3.8-flash-high`). If it says
  you are not logged in, run `agy` interactively and sign in first; the plugin never handles login.
- Tested with `agy` 1.2.7 on Windows 10. macOS and Linux use the same protocol but were not
  manually verified.

## Install

### From Community plugins

Settings -> Community plugins -> Browse -> search **Antigravity CLI** -> Install -> Enable.
(Available once the plugin is accepted into the directory.)

### With BRAT

1. Install the **BRAT** community plugin.
2. Run **BRAT: Add a beta plugin for testing** and enter
   `https://github.com/jsun2020/Obsidian-antigravitycli`.
3. Enable **Antigravity CLI** under Settings -> Community plugins.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/jsun2020/Obsidian-antigravitycli/releases/latest)
into `<vault>/.obsidian/plugins/antigravity-cli/`, then enable the plugin.

## Configure

Settings -> Antigravity CLI:

- **Executable path** - leave empty to auto-detect (`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows,
  `~/.local/bin/agy`, `/usr/local/bin/agy`, `/opt/homebrew/bin/agy`, then `PATH`). Click **Test
  CLI**: it reports the version, whether the CLI is signed in, and loads the model list.
- **Default model** - `gemini-3.8-flash-high` by default. The slug carries the reasoning effort
  (high / medium / low); `-medium` is faster for bulk summarizing. Each chat tab can switch models
  from its footer chip.
- **Reply language** - auto (match the source text), Simplified Chinese, or English.
- **Tool access** - *Native permission rules* (default): tools that would need an interactive
  approval are declined and the run continues. *Full access* adds `--dangerously-skip-permissions`
  so the agent can read and write files and run commands in the vault without prompts. The article
  presets do not need tools, so leave this on native unless you want agentic edits.
- **Working folder** - the agent's working directory and `--add-dir`, relative to the vault root.
- **Idle timeout** - a turn is stopped if `agy` prints nothing for this long (default 120 s).
- **Instructions** - the built-in Markdown reminder and your own custom instructions.
- **Article presets** - edit names, instructions, what they apply to, the suggested result
  action, and an optional output schema. Add your own or restore the built-ins.

## Use

- Click the **sparkles** ribbon icon or run **Antigravity CLI: Open chat view**.
- Click a **preset** button, or run `Preset: ...` from the command palette. A preset uses the
  current selection when there is one and the preset accepts it, otherwise the whole current note.
- Or type a message; the **current note** / **selection** toggles attach context. Enter sends,
  Shift+Enter inserts a newline. The Send button turns into **Stop** while a reply streams.
- Under every reply: **Copy**, **Insert** at the cursor, **Replace selection** (only when the
  turn had a selection; it re-finds the original text even if the cursor moved), **Append to
  note**, **New note** (created next to the source note with a `Source: [[...]]` link). The
  preset's suggested action is outlined.
- The footer shows the model (click to switch or refresh the list), the working folder and
  tool-access mode, and the last turn's token counts.
- **History** (clock icon) lists saved conversations; opening one restores the messages and
  resumes the native `agy` conversation. History lives in `history.json` in the plugin folder.

### Structured output and frontmatter

A preset can carry an **output schema** (JSON Schema). Such a preset runs in its own one-shot
`agy --json-schema` session, the CLI returns a parsed object, and the chat shows its fields.
**Apply to frontmatter** merges them into the note's properties: `title` is set, `tags` are merged
with existing ones (normalized: no `#`, lowercase, hyphenated), and other scalar fields are added
only when absent. The built-in **Title + tags** preset ships with a `{title, tags}` schema.

### Batch: run a preset on a folder

Right-click a folder in the file explorer -> **Antigravity: run preset on folder...**, or run the
command **Run preset on folder...**. Pick the preset, whether to include subfolders, and how to
write results: **Append to each note**, **New note per source note**, or **Into frontmatter**
(schema presets only). Untick notes you want to skip, then **Start**.

- Notes are processed one at a time, each in a fresh `agy` process, so nothing bleeds between
  notes. Expect roughly 10-30 seconds per note including the CLI startup.
- Results are written as soon as each note finishes. **Cancel batch** stops after the current note
  and keeps what was done. Per-note errors are listed and do not stop the batch.
- Notes over 200k characters are skipped.

## How it works

Each chat tab owns one `agy` process in headless **stream-json** mode:

```
agy --input-format stream-json --output-format stream-json --model <slug>
    --add-dir <vault> --mode accept-edits [--conversation <id>] [--dangerously-skip-permissions]
```

The plugin writes one `{"event":"user","message":{"content":...}}` line per turn to stdin and
renders the `step_update` / `result` events from stdout. **Stop** kills the process tree; the tab
keeps its conversation id and the next message resumes it with `--conversation`. Prompts travel
over stdin, so long articles never hit command-line length limits.

`agy` has no system-prompt flag, so house instructions (reply language, Markdown formatting, your
custom instructions) are appended to each message inside an `<antigravity_app_context>` block.

## Privacy

Note text you send (the attached note or selection, plus your message) goes to Google's
Antigravity service through the CLI under your own account. Nothing is sent anywhere else, and
the plugin makes no network requests of its own. Settings are stored in `data.json` and chat
history in `history.json` inside the plugin folder; no credentials are stored by the plugin.

## Troubleshooting

- **"Antigravity CLI (agy) was not found"** - set the executable path in settings.
- **"not logged in"** - run `agy` in a terminal and sign in, then retry.
- **Slow first reply** - `agy` takes several seconds to start and authenticate; later turns in
  the same tab are fast because the process stays alive.
- **Timed out** - raise the idle timeout for long articles with a high-effort model, or use a
  `-medium` / `-low` model.
- **Tools were declined** - expected under native permission rules in headless mode. Presets
  attach the text directly, so no tools are needed; switch to Full access only if you want the
  agent to edit files itself.
- **Works in a terminal but not in Obsidian** - the CLI inherits the environment Obsidian was
  started with (for example proxy variables). Start Obsidian from the same environment or set the
  variables system-wide.

## Development

```sh
npm install
npm run build      # emits main.js
npm test           # unit tests against captured agy output (no agy needed)
npm run typecheck
npm run lint       # eslint + eslint-plugin-obsidianmd
npm run smoke      # optional live test against the real agy (uses quota); add -- --stop to test stop+resume
```

Pure logic lives in `src/runtime/` and is unit-tested with Node's built-in runner; Obsidian-API
code lives in `src/main.ts`, `src/view/`, and `src/settings/`.

### Releasing

Releases are automated by `.github/workflows/release.yml`. Bump the version in `manifest.json`,
`package.json`, and `versions.json`, then push a matching tag (bare version, no `v` prefix):

```sh
git tag 0.2.0 && git push origin 0.2.0
```

The workflow builds the plugin, verifies the tag equals the manifest version, attaches build
provenance attestations, and creates the GitHub release with `main.js`, `manifest.json`, and
`styles.css`.

## License

[MIT](LICENSE)
