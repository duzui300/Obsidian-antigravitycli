// BatchModal - run one preset over every Markdown note in a folder.
//
// Sequential, one fresh agy session per note (no context bleed between notes,
// at the cost of the CLI's startup per note). Results are written as soon as a
// note finishes, so a cancelled batch keeps what was done. Nothing goes
// through the chat tabs.

import { App, Modal, Notice, Setting, TFile, TFolder, setIcon } from "obsidian";
import type AntigravityPlugin from "../main";
import type { AgySession } from "../runtime/agySession";
import { BATCH_MAX_CHARS, BatchItem, BatchItemStatus, BatchOutput, selectBatchNotes, structuredToMarkdown, summarizeBatch } from "../runtime/batch";
import { assembleTurn } from "../runtime/context";
import { Preset, presetInstruction } from "../runtime/presets";

interface TurnOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

/** Icon for a batch row's status marker. */
function batchIcon(status: BatchItemStatus): string {
  switch (status) {
    case "done":
      return "check";
    case "error":
      return "x";
    case "running":
      return "loader";
    case "skipped":
    case "cancelled":
      return "minus";
    default:
      return "circle";
  }
}

export class BatchModal extends Modal {
  private folder: TFolder | null;
  private presetId = "";
  private recursive = false;
  private output: BatchOutput = "append";
  private excluded = new Set<string>();

  private candidates: TFile[] = [];
  private items: BatchItem[] = [];
  private running = false;
  private cancelled = false;
  private current: AgySession | null = null;
  /** Releases the in-flight runOne promise when the batch is cancelled. */
  private cancelSignal: (() => void) | null = null;

  private formEl!: HTMLElement;
  private listEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private summaryEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: AntigravityPlugin,
    folder: TFolder | null
  ) {
    super(app);
    this.folder = folder;
  }

  private notePresets(): Preset[] {
    return this.plugin.settings.presets.filter((p) => p.appliesTo !== "selection");
  }

  private preset(): Preset | undefined {
    return this.notePresets().find((p) => p.id === this.presetId);
  }

  private folders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("agy-batch-modal");
    contentEl.createEl("h3", { text: "Run preset on folder" });

    const presets = this.notePresets();
    if (presets.length === 0) {
      contentEl.createDiv({ cls: "agy-history-empty", text: "No note-capable presets. Add one in settings." });
      return;
    }
    this.presetId = presets[0].id;
    this.output = this.defaultOutput(presets[0]);

    this.formEl = contentEl.createDiv();
    this.renderForm();

    contentEl.createDiv({ cls: "agy-batch-list-title", text: "Notes" });
    this.listEl = contentEl.createDiv({ cls: "agy-batch-list" });
    this.refreshCandidates();

    this.footerEl = contentEl.createDiv({ cls: "agy-batch-footer" });
    this.summaryEl = this.footerEl.createSpan({ cls: "agy-batch-summary" });
    const btns = this.footerEl.createDiv({ cls: "agy-batch-buttons" });
    this.cancelBtn = btns.createEl("button", { text: "Cancel" });
    this.cancelBtn.onclick = () => this.cancel();
    this.startBtn = btns.createEl("button", { text: "Start", cls: "mod-cta" });
    this.startBtn.onclick = () => void this.runBatch();
    this.refreshButtons();
  }

  onClose(): void {
    if (this.running) this.cancel();
    this.contentEl.empty();
  }

  private defaultOutput(preset: Preset): BatchOutput {
    if (preset.outputSchema && preset.suggestedAction === "frontmatter") return "frontmatter";
    if (preset.suggestedAction === "new-note") return "new-note";
    return "append";
  }

  private renderForm(): void {
    this.formEl.empty();

    new Setting(this.formEl).setName("Folder").addDropdown((dd) => {
      for (const f of this.folders()) dd.addOption(f.path, f.path === "/" ? "/ (vault root)" : f.path);
      dd.setValue(this.folder?.path ?? "/").onChange((v) => {
        const f = this.app.vault.getAbstractFileByPath(v);
        this.folder = f instanceof TFolder ? f : null;
        this.refreshCandidates();
      });
      if (!this.folder) {
        const root = this.app.vault.getAbstractFileByPath("/");
        this.folder = root instanceof TFolder ? root : null;
      }
    });

    new Setting(this.formEl).setName("Include subfolders").addToggle((tg) =>
      tg.setValue(this.recursive).onChange((v) => {
        this.recursive = v;
        this.refreshCandidates();
      })
    );

    new Setting(this.formEl).setName("Preset").addDropdown((dd) => {
      for (const p of this.notePresets()) dd.addOption(p.id, p.name);
      dd.setValue(this.presetId).onChange((v) => {
        this.presetId = v;
        const p = this.preset();
        if (p) this.output = this.defaultOutput(p);
        this.renderForm();
      });
    });

    const preset = this.preset();
    new Setting(this.formEl)
      .setName("Write result")
      .setDesc(
        preset?.outputSchema
          ? "Frontmatter merges the structured fields (title, tags, ...) into each note's properties."
          : "Append adds the reply to the end of each note; New note creates a sibling note per source."
      )
      .addDropdown((dd) => {
        dd.addOption("append", "Append to each note");
        dd.addOption("new-note", "New note per source note");
        if (preset?.outputSchema) dd.addOption("frontmatter", "Into frontmatter (properties)");
        dd.setValue(this.output).onChange((v) => (this.output = v as BatchOutput));
      });
  }

  private refreshCandidates(): void {
    const folderPath = this.folder?.path ?? "/";
    const all = this.app.vault.getMarkdownFiles();
    const selected = selectBatchNotes(
      all.map((f) => ({ path: f.path, extension: f.extension })),
      folderPath === "/" ? "" : folderPath,
      this.recursive
    );
    const byPath = new Map(all.map((f) => [f.path, f]));
    this.candidates = selected.map((c) => byPath.get(c.path)).filter((f): f is TFile => !!f);
    this.excluded.clear();
    this.items = this.candidates.map((f) => ({ path: f.path, status: "queued" }));
    this.renderList();
    this.refreshButtons();
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.items.length === 0) {
      this.listEl.createDiv({ cls: "agy-history-empty", text: "No Markdown notes in this folder." });
      return;
    }
    for (const item of this.items) {
      const row = this.listEl.createDiv({
        cls: `agy-batch-row agy-batch-${item.status}`,
        attr: { "data-path": item.path }
      });
      const cb = row.createEl("input", { type: "checkbox", attr: { "aria-label": item.path } });
      cb.checked = !this.excluded.has(item.path);
      cb.disabled = this.running;
      cb.onchange = () => {
        if (cb.checked) this.excluded.delete(item.path);
        else this.excluded.add(item.path);
        this.refreshButtons();
      };
      const icon = row.createSpan({ cls: "agy-batch-icon" });
      setIcon(icon, batchIcon(item.status));
      row.createSpan({ cls: "agy-batch-path", text: item.path });
      if (item.detail) row.createSpan({ cls: "agy-batch-detail", text: item.detail });
    }
  }

  /**
   * Update one row in place. Re-rendering the whole list on every status change
   * would reset its scroll position, making a long batch impossible to watch.
   */
  private updateRow(item: BatchItem): void {
    const row = this.listEl.querySelector<HTMLElement>(`[data-path="${CSS.escape(item.path)}"]`);
    if (!row) {
      this.renderList();
      return;
    }
    row.className = `agy-batch-row agy-batch-${item.status}`;
    const icon = row.querySelector<HTMLElement>(".agy-batch-icon");
    if (icon) setIcon(icon, batchIcon(item.status));
    const detail = row.querySelector<HTMLElement>(".agy-batch-detail");
    if (item.detail) {
      if (detail) detail.setText(item.detail);
      else row.createSpan({ cls: "agy-batch-detail", text: item.detail });
    } else if (detail) {
      detail.remove();
    }
  }

  private selectedCount(): number {
    return this.items.filter((i) => !this.excluded.has(i.path)).length;
  }

  private refreshButtons(): void {
    if (!this.startBtn) return;
    const n = this.selectedCount();
    this.startBtn.disabled = this.running || n === 0;
    this.startBtn.setText(this.running ? "Running..." : `Start (${n})`);
    this.cancelBtn.setText(this.running ? "Cancel batch" : "Close");
    if (!this.running && !this.items.some((i) => i.status !== "queued")) {
      this.summaryEl.setText(n > 0 ? `${n} note(s); one agy process per note, roughly 10-30 s each.` : "");
    }
  }

  private cancel(): void {
    if (!this.running) {
      this.close();
      return;
    }
    this.cancelled = true;
    // AgySession.stop() deliberately fires no callbacks, so release the
    // in-flight turn explicitly - otherwise runOne's promise never settles and
    // the batch loop waits on it forever.
    this.cancelSignal?.();
    this.current?.stop();
    this.summaryEl.setText("Cancelling after the current note...");
  }

  private async runBatch(): Promise<void> {
    const preset = this.preset();
    if (!preset || this.running) return;
    this.running = true;
    this.cancelled = false;
    this.renderList();
    this.refreshButtons();

    const appContext = this.plugin.buildAppContextText();
    const userText = presetInstruction(preset, "note");
    const model = this.plugin.settings.model;

    for (const item of this.items) {
      if (this.excluded.has(item.path)) {
        item.status = "skipped";
        item.detail = "unchecked";
        this.updateRow(item);
        continue;
      }
      if (this.cancelled) {
        item.status = "cancelled";
        this.updateRow(item);
        continue;
      }
      const file = this.candidates.find((f) => f.path === item.path);
      if (!file) {
        item.status = "error";
        item.detail = "file missing";
        this.updateRow(item);
        continue;
      }
      item.status = "running";
      this.updateRow(item);
      this.summaryEl.setText(`Processing ${file.basename}...`);
      try {
        const content = await this.app.vault.cachedRead(file);
        if (content.length > BATCH_MAX_CHARS) {
          item.status = "skipped";
          item.detail = `over ${Math.round(BATCH_MAX_CHARS / 1000)}k chars`;
          this.updateRow(item);
          continue;
        }
        const prompt = assembleTurn(userText, { notePath: file.path, noteContent: content }, appContext);
        const outcome = await this.runOne(model, preset, prompt);
        if (!outcome) {
          // Cancelled while this note was in flight.
          item.status = "cancelled";
          this.updateRow(item);
          continue;
        }
        await this.writeOutcome(file, outcome);
        item.status = "done";
        item.detail = this.output === "frontmatter" ? "frontmatter" : this.output === "new-note" ? "new note" : "appended";
      } catch (e) {
        item.status = this.cancelled ? "cancelled" : "error";
        item.detail = (e as Error).message;
      }
      this.updateRow(item);
    }

    this.running = false;
    this.current = null;
    this.renderList();
    this.refreshButtons();
    const summary = summarizeBatch(this.items);
    this.summaryEl.setText(summary);
    new Notice(`Antigravity batch: ${summary}.`);
  }

  /**
   * One fresh session, one turn, closed afterwards. Resolves to the reply, or
   * to null when the batch was cancelled mid-turn.
   */
  private async runOne(model: string, preset: Preset, prompt: string): Promise<TurnOutcome | null> {
    const session = this.plugin.client.createSession(model, undefined, preset.outputSchema ? { jsonSchema: preset.outputSchema } : {});
    this.current = session;
    try {
      await session.start();
      return await new Promise<TurnOutcome | null>((resolve, reject) => {
        let text = "";
        let settled = false;
        const settle = (finish: () => void): void => {
          if (settled) return;
          settled = true;
          this.cancelSignal = null;
          finish();
        };
        this.cancelSignal = () => settle(() => resolve(null));
        session.send(prompt, {
          onChunk: (t) => (text += t),
          onError: (m) => settle(() => reject(new Error(m))),
          onDone: (_id, _response, structured) => settle(() => resolve({ text, ...(structured ? { structured } : {}) }))
        });
      });
    } finally {
      this.cancelSignal = null;
      this.current = null;
      await session.close();
    }
  }

  private async writeOutcome(file: TFile, outcome: TurnOutcome): Promise<void> {
    if (this.output === "frontmatter") {
      if (!outcome.structured) throw new Error("no structured fields in the reply");
      await this.plugin.applyFrontmatter(file, outcome.structured);
      return;
    }
    const text = outcome.structured ? structuredToMarkdown(outcome.structured) : outcome.text;
    if (!text.trim()) throw new Error("empty reply");
    if (this.output === "new-note") {
      await this.plugin.createNoteFrom(file, text);
    } else {
      await this.plugin.appendToFile(file, text);
    }
  }
}
