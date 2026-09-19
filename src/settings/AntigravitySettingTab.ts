import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AntigravityPlugin from "../main";
import { BUILTIN_PRESETS, Preset, PresetTarget, ResultAction, normalizeSchema, slugifyPresetId } from "../runtime/presets";
import { humanizeModel } from "../runtime/protocol";
import type { OutputLanguage } from "../runtime/context";
import type { ToolAccess } from "./types";

export class AntigravitySettingTab extends PluginSettingTab {
  private plugin: AntigravityPlugin;

  constructor(app: App, plugin: AntigravityPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.render();
  }

  /** Full (re)render; called by display() and after edits that change the layout. */
  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---- CLI ----
    new Setting(containerEl)
      .setName("Command-line tool")
      .setDesc(
        "The plugin drives the locally installed, already signed-in `agy` command. Install it and run `agy models` in a terminal once; the plugin never handles login."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Executable path")
      .setDesc(
        "Absolute path to agy (Windows default: %LOCALAPPDATA%\\agy\\bin\\agy.exe). Leave empty to auto-detect from the well-known install folders and PATH."
      )
      .addText((text) =>
        text
          .setPlaceholder("(auto-detect)")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (v) => {
            this.plugin.settings.cliPath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    const testSetting = new Setting(containerEl)
      .setName("Test CLI")
      .setDesc("Checks the executable, its version, and login state by listing models. Also refreshes the model picker.");
    const resultEl = containerEl.createDiv({ cls: "setting-item-description agy-test-result" });
    testSetting.addButton((btn) =>
      btn
        .setButtonText("Test CLI")
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          resultEl.setText("Testing... (starts agy, may take ~10 s)");
          resultEl.removeClass("agy-test-ok", "agy-test-fail");
          const result = await this.plugin.client.testCli();
          resultEl.setText(result.detail);
          resultEl.toggleClass("agy-test-ok", result.ok);
          resultEl.toggleClass("agy-test-fail", !result.ok);
          if (result.ok && result.models && result.models.length > 0) {
            this.plugin.settings.cachedModels = result.models;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            this.render();
          }
          btn.setDisabled(false);
        })
    );

    // ---- Model + output ----
    new Setting(containerEl).setName("Model and output").setHeading();

    const models = this.plugin.settings.cachedModels;
    const modelSetting = new Setting(containerEl)
      .setName("Default model")
      .setDesc(
        models.length > 0
          ? "Used for new chat tabs. Reasoning effort is part of the slug (high / medium / low). Click Test CLI to refresh the list."
          : "No model list cached yet - type a slug (e.g. gemini-3.8-flash-high) or click Test CLI to load the list."
      );
    if (models.length > 0) {
      modelSetting.addDropdown((dd) => {
        const current = this.plugin.settings.model;
        if (current && !models.some((m) => m.id === current)) dd.addOption(current, `${current} (not in list)`);
        for (const m of models) dd.addOption(m.id, m.label || humanizeModel(m.id));
        dd.setValue(current).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        });
      });
    } else {
      modelSetting.addText((text) =>
        text
          .setPlaceholder("gemini-3.8-flash-high")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );
    }

    new Setting(containerEl)
      .setName("Reply language")
      .setDesc("auto = follow the language of your message and the attached text.")
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Auto (match source)")
          .addOption("zh-CN", "Simplified Chinese")
          .addOption("en", "English")
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (v) => {
            this.plugin.settings.outputLanguage = v as OutputLanguage;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include full note content")
      .setDesc('When "current note" is toggled on a message, send the note body (not just its path). Presets always send the text they act on.')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.includeNoteContent).onChange(async (v) => {
          this.plugin.settings.includeNoteContent = v;
          await this.plugin.saveSettings();
        })
      );

    // ---- Agent access ----
    new Setting(containerEl).setName("Agent access").setHeading();

    new Setting(containerEl)
      .setName("Tool access")
      .setDesc(
        "Native = agy's own permission rules; tools that would need an interactive approval are declined and the run continues. Full access adds --dangerously-skip-permissions to every session, letting the agent read/write files and run commands without prompts."
      )
      .addDropdown((dd) =>
        dd
          .addOption("native", "Native permission rules (recommended)")
          .addOption("full", "Full access (auto-approve all tools)")
          .setValue(this.plugin.settings.toolAccess)
          .onChange(async (v) => {
            this.plugin.settings.toolAccess = v as ToolAccess;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Working folder")
      .setDesc("Folder the agent runs in (its cwd and --add-dir), relative to the vault root. Leave empty for the whole vault. Applies to new sessions.")
      .addText((text) =>
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.workingFolder)
          .onChange(async (v) => {
            this.plugin.settings.workingFolder = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    // ---- Chat ----
    new Setting(containerEl).setName("Chat").setHeading();

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("Optional. Personalizes the greeting shown in an empty chat.")
      .addText((text) =>
        text
          .setPlaceholder("(none)")
          .setValue(this.plugin.settings.userName)
          .onChange(async (v) => {
            this.plugin.settings.userName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Idle timeout (ms)")
      .setDesc("A turn is stopped if agy prints nothing for this long. Default 120000 (120 s). Long articles with a high-effort model may need more.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.idleTimeoutMs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 10000) {
            this.plugin.settings.idleTimeoutMs = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max tabs")
      .setDesc("Maximum concurrent chat tabs. Each open tab with a conversation keeps one agy process alive.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxTabs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 1 && n <= 10) {
            this.plugin.settings.maxTabs = n;
            await this.plugin.saveSettings();
          }
        })
      );

    // ---- Instructions ----
    new Setting(containerEl)
      .setName("Instructions")
      .setDesc("agy has no system-prompt flag; these are appended to each message in a labelled application-context block.")
      .setHeading();

    new Setting(containerEl)
      .setName("Markdown formatting reminder")
      .setDesc("Built-in instruction that replies render as Markdown in a narrow sidebar and that summaries/rewrites should contain only the result.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.markdownFormattingPromptEnabled).onChange(async (v) => {
          this.plugin.settings.markdownFormattingPromptEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Custom instructions")
      .setDesc("Optional. Persona, tone, house style - anything Antigravity should consistently follow in this vault.")
      .addTextArea((ta) => {
        ta.setPlaceholder("e.g. Keep technical terms in English inside Chinese text.")
          .setValue(this.plugin.settings.customSystemPrompt)
          .onChange(async (v) => {
            this.plugin.settings.customSystemPrompt = v;
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 4;
        ta.inputEl.addClass("agy-settings-textarea");
        return ta;
      });

    // ---- Presets ----
    new Setting(containerEl)
      .setName("Article presets")
      .setDesc("One-click actions shown in the chat panel and the command palette (reload the plugin to refresh palette entries after edits).")
      .setHeading()
      .addButton((btn) =>
        btn.setButtonText("Add preset").onClick(async () => {
          const name = `Preset ${this.plugin.settings.presets.length + 1}`;
          this.plugin.settings.presets.push({
            id: this.uniquePresetId(slugifyPresetId(name)),
            name,
            instruction: "Describe what to do with the attached text.",
            appliesTo: "either",
            suggestedAction: "copy"
          });
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
          this.render();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Restore built-ins").onClick(async () => {
          const have = new Set(this.plugin.settings.presets.map((p) => p.id));
          for (const b of BUILTIN_PRESETS) if (!have.has(b.id)) this.plugin.settings.presets.push({ ...b });
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
          this.render();
          new Notice("Antigravity: built-in presets restored.");
        })
      );

    this.plugin.settings.presets.forEach((preset, index) => this.renderPreset(containerEl, preset, index));
  }

  private uniquePresetId(base: string): string {
    const ids = new Set(this.plugin.settings.presets.map((p) => p.id));
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  private renderPreset(containerEl: HTMLElement, preset: Preset, index: number): void {
    const box = containerEl.createDiv({ cls: "agy-preset-box" });
    new Setting(box)
      .setName(`Preset: ${preset.name}`)
      .addText((text) =>
        text
          .setPlaceholder("Name")
          .setValue(preset.name)
          .onChange(async (v) => {
            preset.name = v.trim() || preset.name;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      )
      .addDropdown((dd) =>
        dd
          .addOption("either", "Selection or note")
          .addOption("selection", "Selection only")
          .addOption("note", "Note only")
          .setValue(preset.appliesTo)
          .onChange(async (v) => {
            preset.appliesTo = v as PresetTarget;
            await this.plugin.saveSettings();
          })
      )
      .addDropdown((dd) =>
        dd
          .addOption("copy", "Suggest: copy")
          .addOption("insert", "Suggest: insert at cursor")
          .addOption("replace", "Suggest: replace selection")
          .addOption("append", "Suggest: append to note")
          .addOption("new-note", "Suggest: new note")
          .addOption("frontmatter", "Suggest: apply to frontmatter (needs schema)")
          .setValue(preset.suggestedAction)
          .onChange(async (v) => {
            preset.suggestedAction = v as ResultAction;
            await this.plugin.saveSettings();
          })
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Delete preset")
          .onClick(async () => {
            this.plugin.settings.presets.splice(index, 1);
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            this.render();
          })
      );
    new Setting(box).setName("Instruction").addTextArea((ta) => {
      ta.setValue(preset.instruction).onChange(async (v) => {
        preset.instruction = v;
        await this.plugin.saveSettings();
      });
      ta.inputEl.rows = 3;
      ta.inputEl.addClass("agy-settings-textarea");
      return ta;
    });
    new Setting(box)
      .setName("Output schema (optional)")
      .setDesc("JSON Schema for structured output. When set, the preset runs with --json-schema and the reply's fields (title, tags, ...) can be applied to the note's frontmatter. Leave empty for free text.")
      .addTextArea((ta) => {
        ta.setPlaceholder('{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}')
          .setValue(preset.outputSchema ?? "")
          .onChange(async (v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              delete preset.outputSchema;
              if (preset.suggestedAction === "frontmatter") preset.suggestedAction = "copy";
              await this.plugin.saveSettings();
              return;
            }
            const valid = normalizeSchema(trimmed);
            if (!valid) {
              new Notice("Antigravity: output schema must be a JSON object; not saved.");
              return;
            }
            preset.outputSchema = valid;
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("agy-settings-textarea");
        return ta;
      });
  }
}
