import { Editor, EditorPosition, FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";
import { AntigravitySettings, DEFAULT_SETTINGS } from "./settings/types";
import { AntigravitySettingTab } from "./settings/AntigravitySettingTab";
import { AntigravityView, VIEW_TYPE_ANTIGRAVITY } from "./view/AntigravityView";
import { BatchModal } from "./view/BatchModal";
import { AgyClient } from "./runtime/agyClient";
import { buildAppContext } from "./runtime/context";
import type { NoteContext } from "./runtime/context";
import { mergeFrontmatterFields } from "./runtime/batch";
import { normalizePresets, presetApplicable, presetCommandId, ResultAction } from "./runtime/presets";
import { parseModelsOutput } from "./runtime/protocol";
import { Conversation, parseHistoryFile, removeConversation, serializeHistoryFile, upsertConversation } from "./runtime/history";

/** Bundled-build marker (checked after deploy per project rules). */
export const ANTIGRAVITY_PLUGIN_VERSION = "0.2.0";

/** Editor range of a selection, so "Replace selection" can target it later. */
export interface SelectionRange {
  from: EditorPosition;
  to: EditorPosition;
}

/** Note context plus the UI-only selection range (not sent to the model). */
export interface TurnContext extends NoteContext {
  selectionRange?: SelectionRange;
}

export interface SelectionSnapshot {
  notePath?: string;
  text: string;
  range?: SelectionRange;
}

export default class AntigravityPlugin extends Plugin {
  settings!: AntigravitySettings;
  client!: AgyClient;

  /** Locally persisted chat history (newest first), loaded from history.json. */
  conversations: Conversation[] = [];

  /**
   * Last Markdown view that was actually focused (tracked via
   * `active-leaf-change`), because `getActiveViewOfType(MarkdownView)` is null
   * once focus moves into the sidebar chat input.
   */
  private lastMarkdownView: MarkdownView | null = null;

  /**
   * Live snapshot of the last non-empty selection in `lastMarkdownView`,
   * expiring 5 s after the last related activity (selection change or typing
   * in the chat input) so a stale selection is not silently attached later.
   */
  private lastSelectionSnapshot: SelectionSnapshot | null = null;
  private selectionExpiryTimer: number | null = null;
  private static readonly SELECTION_EXPIRY_MS = 5000;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadHistory();
    this.client = new AgyClient(
      () => ({
        cliPath: this.settings.cliPath,
        model: this.settings.model,
        toolAccess: this.settings.toolAccess,
        idleTimeoutMs: this.settings.idleTimeoutMs,
        workingFolder: this.settings.workingFolder
      }),
      () => this.getVaultBasePath()
    );

    this.registerView(VIEW_TYPE_ANTIGRAVITY, (leaf) => new AntigravityView(leaf, this));

    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (this.lastMarkdownView) {
          const snap = this.captureViewSelection(this.lastMarkdownView);
          if (snap) this.setSelectionSnapshot(snap);
        }
        const view = leaf?.view;
        if (view instanceof MarkdownView) this.lastMarkdownView = view;
      })
    );
    this.registerDomEvent(activeDocument, "selectionchange", () => {
      const view = this.lastMarkdownView;
      if (!view) return;
      const snap = this.captureViewSelection(view);
      if (snap) this.setSelectionSnapshot(snap);
    });

    this.addRibbonIcon("sparkles", "Open Antigravity", () => {
      void this.activateView();
    });

    this.addCommand({ id: "open-view", name: "Open chat view", callback: () => void this.activateView() });

    this.addCommand({
      id: "new-tab",
      name: "New chat tab",
      callback: async () => {
        const view = await this.activateView();
        view?.newTab();
      }
    });

    this.addCommand({
      id: "send-note",
      name: "Send current note to Antigravity",
      checkCallback: (checking) => {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return false;
        if (!checking) void this.sendNote(mdView);
        return true;
      }
    });

    this.addCommand({
      id: "send-selection",
      name: "Send selection to Antigravity",
      checkCallback: (checking) => {
        const sel = this.getCurrentSelection();
        if (!sel?.text.trim()) return false;
        if (!checking) void this.sendSelection(sel);
        return true;
      }
    });

    this.addCommand({
      id: "run-preset-on-folder",
      name: "Run preset on folder...",
      callback: () => new BatchModal(this.app, this, null).open()
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("Antigravity: run preset on folder...")
            .setIcon("sparkles")
            .onClick(() => new BatchModal(this.app, this, file).open())
        );
      })
    );

    for (const preset of this.settings.presets) {
      this.addCommand({
        id: presetCommandId(preset),
        name: `Preset: ${preset.name}`,
        checkCallback: (checking) => {
          const hasNote = !!this.getActiveMarkdownView();
          const hasSelection = !!this.getCurrentSelection()?.text.trim();
          if (!presetApplicable(preset, hasSelection, hasNote)) return false;
          if (!checking) {
            void this.activateView().then((view) => view?.runPreset(preset.id));
          }
          return true;
        }
      });
    }

    this.addSettingTab(new AntigravitySettingTab(this.app, this));
  }

  onunload(): void {
    // Obsidian detaches leaves; AntigravityView.onClose closes the agy sessions.
    if (this.selectionExpiryTimer !== null) window.clearTimeout(this.selectionExpiryTimer);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AntigravitySettings> | null;
    const merged = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    merged.presets = normalizePresets(data?.presets);
    // Re-validate the cached model list through the same parser used live.
    const cached = Array.isArray(data?.cachedModels) ? data.cachedModels : [];
    merged.cachedModels = parseModelsOutput(
      cached
        .filter((m) => m && typeof m.id === "string")
        .map((m) => `${m.id}\t${typeof m.label === "string" ? m.label : m.id}`)
        .join("\n")
    );
    this.settings = merged;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- chat history persistence (history.json, separate from data.json) ----

  private historyPath(): string {
    return normalizePath(`${this.manifest.dir}/history.json`);
  }

  async loadHistory(): Promise<void> {
    try {
      const p = this.historyPath();
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(p)) this.conversations = parseHistoryFile(await adapter.read(p));
    } catch {
      this.conversations = [];
    }
  }

  private async persistHistory(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.historyPath(), serializeHistoryFile(this.conversations));
    } catch {
      /* best effort - a failed history write must never break a chat turn */
    }
  }

  async saveConversation(entry: Conversation): Promise<void> {
    this.conversations = upsertConversation(this.conversations, entry);
    await this.persistHistory();
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = removeConversation(this.conversations, id);
    await this.persistHistory();
  }

  // ---- editor / selection helpers ----

  getActiveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const fallback = this.lastMarkdownView;
    if (fallback && this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === fallback)) return fallback;
    return null;
  }

  /** The selection to attach to a turn: a live read if possible, else the snapshot. */
  getCurrentSelection(): SelectionSnapshot | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      const snap = this.captureViewSelection(active);
      if (snap) return snap;
    }
    return this.lastSelectionSnapshot;
  }

  private setSelectionSnapshot(snap: SelectionSnapshot): void {
    this.lastSelectionSnapshot = snap;
    this.scheduleSelectionExpiry();
  }

  private scheduleSelectionExpiry(): void {
    if (this.selectionExpiryTimer !== null) window.clearTimeout(this.selectionExpiryTimer);
    this.selectionExpiryTimer = window.setTimeout(() => {
      this.lastSelectionSnapshot = null;
      this.selectionExpiryTimer = null;
    }, AntigravityPlugin.SELECTION_EXPIRY_MS);
  }

  /** Typing in the chat keeps a pending selection snapshot alive. */
  touchSelectionActivity(): void {
    if (this.lastSelectionSnapshot) this.scheduleSelectionExpiry();
  }

  /**
   * Read the highlighted text in a Markdown view, covering Reading View (DOM
   * selection inside the view) and Source/Live Preview (CodeMirror selection,
   * which also yields an editor range for later replacement).
   */
  private captureViewSelection(view: MarkdownView): SelectionSnapshot | null {
    const notePath = view.file?.path;
    try {
      const editorText = view.editor.getSelection();
      if (editorText.trim()) {
        const sels = view.editor.listSelections();
        let range: SelectionRange | undefined;
        if (sels.length > 0) {
          const { anchor, head } = sels[0];
          const before = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
          range = before ? { from: anchor, to: head } : { from: head, to: anchor };
        }
        return { notePath, text: editorText, range };
      }
    } catch {
      /* no editor in this mode */
    }
    try {
      const domSel = window.getSelection();
      if (domSel && !domSel.isCollapsed && domSel.rangeCount > 0) {
        const r = domSel.getRangeAt(0);
        if (view.containerEl.contains(r.commonAncestorContainer)) {
          const text = domSel.toString();
          if (text.trim()) return { notePath, text };
        }
      }
    } catch {
      /* defensive */
    }
    return null;
  }

  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  /** The app-context block appended to every turn (chat and batch). */
  buildAppContextText(): string {
    const s = this.settings;
    return buildAppContext({
      vaultPath: this.client.workingDir(),
      outputLanguage: s.outputLanguage,
      customPrompt: s.customSystemPrompt,
      markdownReminder: s.markdownFormattingPromptEnabled,
      fullAccess: s.toolAccess === "full"
    });
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANTIGRAVITY)) {
      const view = leaf.view;
      if (view instanceof AntigravityView) view.refreshMetaBar();
    }
  }

  /** Open Obsidian settings on this plugin's tab (best effort). */
  openPluginSettings(): void {
    const settingApi = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (settingApi?.open) {
      settingApi.open();
      settingApi.openTabById?.("antigravity-cli");
    } else {
      new Notice("Open Settings -> Antigravity CLI.");
    }
  }

  async activateView(): Promise<AntigravityView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_ANTIGRAVITY);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_ANTIGRAVITY, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
    return leaf?.view instanceof AntigravityView ? leaf.view : null;
  }

  private async sendNote(mdView: MarkdownView): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    const ctx: TurnContext = { notePath: mdView.file?.path };
    if (this.settings.includeNoteContent) ctx.noteContent = mdView.editor.getValue();
    view.submitPrompt("Please review the current note.", "Please review the current note.", ctx);
  }

  private async sendSelection(sel: SelectionSnapshot): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    const ctx: TurnContext = { notePath: sel.notePath, selection: sel.text, selectionRange: sel.range };
    view.submitPrompt("Please review the selected text.", "Please review the selected text.", ctx);
  }

  // ---- result actions (write the reply back into the vault) ----

  async applyResult(action: ResultAction, rawText: string, ctx: TurnContext, structured?: Record<string, unknown>): Promise<void> {
    const text = rawText.replace(/\s+$/, "");
    if (!text && action !== "frontmatter") return;
    try {
      switch (action) {
        case "copy":
          await navigator.clipboard.writeText(text);
          new Notice("Antigravity: copied to clipboard.");
          return;
        case "insert":
          return this.insertAtCursor(text);
        case "replace":
          return await this.replaceSelection(text, ctx);
        case "append": {
          const file = this.fileForContext(ctx);
          if (!file) {
            new Notice("Antigravity: no note to append to.");
            return;
          }
          await this.appendToFile(file, text);
          new Notice(`Antigravity: appended to ${file.basename}.`);
          return;
        }
        case "new-note": {
          const created = await this.createNoteFrom(this.fileForContext(ctx), text);
          await this.app.workspace.getLeaf("tab").openFile(created);
          new Notice(`Antigravity: created ${created.basename}.`);
          return;
        }
        case "frontmatter": {
          const file = this.fileForContext(ctx);
          if (!file) {
            new Notice("Antigravity: no note to update.");
            return;
          }
          if (!structured) {
            new Notice("Antigravity: this reply has no structured fields.");
            return;
          }
          const changed = await this.applyFrontmatter(file, structured);
          new Notice(changed.length ? `Antigravity: updated ${changed.join(", ")} in ${file.basename}.` : "Antigravity: frontmatter already up to date.");
          return;
        }
      }
    } catch (e) {
      new Notice(`Antigravity: ${(e as Error).message}`);
    }
  }

  /** The note a turn was taken from, else the active note. */
  private fileForContext(ctx: TurnContext): TFile | null {
    if (ctx.notePath) {
      const f = this.app.vault.getAbstractFileByPath(ctx.notePath);
      if (f instanceof TFile) return f;
    }
    return this.getActiveMarkdownView()?.file ?? null;
  }

  /** Append text to a note (used by chat actions and batch runs). */
  async appendToFile(file: TFile, text: string): Promise<void> {
    await this.app.vault.append(file, `\n\n${text.replace(/\s+$/, "")}\n`);
  }

  /** Merge structured fields into a note's frontmatter; returns changed keys. */
  async applyFrontmatter(file: TFile, structured: Record<string, unknown>): Promise<string[]> {
    let changed: string[] = [];
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      changed = mergeFrontmatterFields(fm, structured);
    });
    return changed;
  }

  private insertAtCursor(text: string): void {
    const mdView = this.getActiveMarkdownView();
    if (!mdView) {
      new Notice("Antigravity: open a note in the editor first.");
      return;
    }
    const editor = mdView.editor;
    editor.replaceRange(text, editor.getCursor());
    new Notice("Antigravity: inserted at cursor.");
  }

  /** Find (or open) the editor for the note a turn was taken from. */
  private async editorForNote(notePath: string | undefined): Promise<{ editor: Editor; file: TFile } | null> {
    if (!notePath) {
      const active = this.getActiveMarkdownView();
      return active?.file ? { editor: active.editor, file: active.file } : null;
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file?.path === notePath) {
        await this.app.workspace.revealLeaf(leaf);
        return { editor: v.editor, file: v.file };
      }
    }
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return null;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    const v = leaf.view;
    return v instanceof MarkdownView ? { editor: v.editor, file } : null;
  }

  private async replaceSelection(text: string, ctx: TurnContext): Promise<void> {
    const original = ctx.selection || "";
    if (!original) {
      new Notice("Antigravity: this reply has no original selection to replace.");
      return;
    }
    const target = await this.editorForNote(ctx.notePath);
    if (!target) {
      await navigator.clipboard.writeText(text);
      new Notice("Antigravity: source note not found; copied to clipboard instead.");
      return;
    }
    const { editor } = target;
    // 1. The recorded range still holds the original text.
    if (ctx.selectionRange) {
      try {
        if (editor.getRange(ctx.selectionRange.from, ctx.selectionRange.to) === original) {
          editor.replaceRange(text, ctx.selectionRange.from, ctx.selectionRange.to);
          new Notice("Antigravity: selection replaced.");
          return;
        }
      } catch {
        /* range no longer valid */
      }
    }
    // 2. The live selection is the original text.
    if (editor.getSelection() === original) {
      editor.replaceSelection(text);
      new Notice("Antigravity: selection replaced.");
      return;
    }
    // 3. The original text occurs exactly once in the note.
    const doc = editor.getValue();
    const first = doc.indexOf(original);
    if (first >= 0 && doc.indexOf(original, first + 1) === -1) {
      editor.replaceRange(text, editor.offsetToPos(first), editor.offsetToPos(first + original.length));
      new Notice("Antigravity: selection replaced.");
      return;
    }
    await navigator.clipboard.writeText(text);
    new Notice("Antigravity: the original text has changed; result copied to clipboard instead.");
  }

  /** Create a sibling note holding `text`, linking back to `source` (used by chat and batch). */
  async createNoteFrom(source: TFile | null, text: string): Promise<TFile> {
    const folder = source?.parent?.path && source.parent.path !== "/" ? source.parent.path : "";
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const baseName = source ? `${source.basename} - Antigravity ${when}` : `Antigravity ${when}`;
    let name = `${baseName}.md`;
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      name = `${baseName} (${n++}).md`;
      path = normalizePath(folder ? `${folder}/${name}` : name);
    }
    const body = source ? `${text.replace(/\s+$/, "")}\n\n---\nSource: [[${source.basename}]]\n` : `${text.replace(/\s+$/, "")}\n`;
    return this.app.vault.create(path, body);
  }
}
