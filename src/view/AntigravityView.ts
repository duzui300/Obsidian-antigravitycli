// AntigravityView - the sidebar chat panel with a multi-tab manager.
//
// Ported from the hermes-agent plugin's HermesView. Each tab owns one agy
// session (a persistent child process), its conversation id, its messages,
// and its DOM. Pure Obsidian DOM API, no framework.

import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AntigravityPlugin from "../main";
import type { TurnContext } from "../main";
import type { AgySession, ChatHandle } from "../runtime/agySession";
import { assembleTurn, buildAppContext } from "../runtime/context";
import type { NoteContext } from "../runtime/context";
import { Conversation, StoredMessage, deriveTitle, lastMessagePreview, relativeTime, tabLabel } from "../runtime/history";
import { Preset, ResultAction, presetApplicable, presetInstruction, presetTarget } from "../runtime/presets";
import { ToolEvent, UsageInfo, humanizeModel } from "../runtime/protocol";

export const VIEW_TYPE_ANTIGRAVITY = "antigravity-chat";

/** "842 chars" / "3.4k chars" - a rough size label for an attachment chip. */
function formatAttachmentSize(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

function greetingOptions(userName: string): string[] {
  const name = (userName || "").trim();
  const p = (base: string): string => (name ? `${base}, ${name}` : base);
  return [
    p("What shall we read today") + "?",
    p("Welcome back") + "!",
    p("Ready when you are"),
    name ? `Hi ${name}, pick a preset or ask anything.` : "Pick a preset above, or ask anything."
  ];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** UI-only rendering hint for one message: display text + collapsed attachments. */
interface MessageUiMeta {
  display?: string;
  ctx?: TurnContext;
}

interface AssistantEls {
  msgEl: HTMLElement;
  contentEl: HTMLElement;
  toolsEl: HTMLElement;
  usageEl: HTMLElement;
  actionsEl: HTMLElement;
}

interface Tab {
  id: string;
  title: string;
  messages: ChatMessage[];
  uiMeta: (MessageUiMeta | undefined)[];
  /** Native agy conversation id (set after the first turn; survives Stop). */
  conversationId?: string;
  /** Model slug for this tab (defaults to the settings model at creation). */
  model: string;
  session: AgySession | null;
  handle: ChatHandle | null;
  bodyEl: HTMLElement;
  tabButtonEl: HTMLElement;
  lastUsage: UsageInfo | null;
  greeting?: string;
  historyId: string;
}

export class AntigravityView extends ItemView {
  private plugin: AntigravityPlugin;

  private tabBarEl!: HTMLElement;
  private bodyHostEl!: HTMLElement;
  private presetBarEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private includeNoteToggle!: HTMLInputElement;
  private includeSelectionToggle!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private metaModelEl!: HTMLElement;
  private metaTokensEl!: HTMLElement;
  private accessChipEl!: HTMLElement;
  private accessLabelEl!: HTMLElement;

  private tabs: Tab[] = [];
  private activeTabId = "";
  private tabSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: AntigravityPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_ANTIGRAVITY;
  }
  getDisplayText(): string {
    return "Antigravity";
  }
  getIcon(): string {
    return "sparkles";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("agy-view");

    // Header
    const header = root.createDiv({ cls: "agy-header" });
    header.createSpan({ cls: "agy-title", text: "Antigravity" });
    const headerActions = header.createDiv({ cls: "agy-header-actions" });
    const historyBtn = headerActions.createEl("button", { cls: "agy-icon-btn", attr: { "aria-label": "Chat history" } });
    setIcon(historyBtn, "history");
    historyBtn.onclick = () => this.openHistory();
    const newTabBtn = headerActions.createEl("button", { cls: "agy-icon-btn", attr: { "aria-label": "New tab" } });
    setIcon(newTabBtn, "plus");
    newTabBtn.onclick = () => this.newTab();

    // Tab bar
    this.tabBarEl = root.createDiv({ cls: "agy-tabbar" });

    // Body host (per-tab bodies live here)
    this.bodyHostEl = root.createDiv({ cls: "agy-body-host" });

    // Preset bar
    this.presetBarEl = root.createDiv({ cls: "agy-preset-bar" });
    this.renderPresetBar();

    // Context toggles
    const ctxRow = root.createDiv({ cls: "agy-context-row" });
    const noteLabel = ctxRow.createEl("label", { cls: "agy-context-toggle" });
    this.includeNoteToggle = noteLabel.createEl("input", { type: "checkbox" });
    noteLabel.createSpan({ text: " current note" });
    const selLabel = ctxRow.createEl("label", { cls: "agy-context-toggle" });
    this.includeSelectionToggle = selLabel.createEl("input", { type: "checkbox" });
    selLabel.createSpan({ text: " selection" });

    // Input
    const inputWrap = root.createDiv({ cls: "agy-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "agy-input",
      attr: { rows: "3", placeholder: "Message Antigravity..." }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.onSend();
      }
    });
    this.inputEl.addEventListener("input", () => this.plugin.touchSelectionActivity());
    const inputActions = inputWrap.createDiv({ cls: "agy-input-actions" });

    // Meta bar (model | tokens | access chip)
    const metaEl = inputActions.createDiv({ cls: "agy-input-meta" });
    this.metaModelEl = metaEl.createDiv({ cls: "agy-meta-item agy-meta-model", attr: { "aria-label": "Model - click to switch" } });
    this.metaModelEl.onclick = (e) => this.showModelMenu(e);
    this.metaTokensEl = metaEl.createDiv({ cls: "agy-meta-item agy-meta-tokens", attr: { "aria-label": "Tokens used by the last turn" } });
    this.accessChipEl = metaEl.createDiv({ cls: "agy-access-chip" });
    const accessIcon = this.accessChipEl.createSpan({ cls: "agy-access-icon" });
    setIcon(accessIcon, "folder");
    this.accessLabelEl = this.accessChipEl.createSpan({ cls: "agy-access-label" });
    this.accessChipEl.onclick = () => this.plugin.openPluginSettings();

    const rightEl = inputActions.createDiv({ cls: "agy-input-actions-right" });
    this.statusEl = rightEl.createSpan({ cls: "agy-status" });
    this.sendBtn = rightEl.createEl("button", { cls: "agy-send-btn", text: "Send" });
    this.sendBtn.onclick = () => {
      if (this.activeTab()?.handle) this.stopActive();
      else void this.onSend();
    };

    this.newTab();
    this.refreshMetaBar();
    return Promise.resolve();
  }

  async onClose(): Promise<void> {
    for (const t of this.tabs) {
      t.handle?.abort();
      t.handle = null;
      if (t.session) await t.session.close();
      t.session = null;
    }
  }

  // ---- tab management ----

  newTab(): void {
    if (this.tabs.length >= Math.max(1, this.plugin.settings.maxTabs)) {
      new Notice(`Antigravity: tab limit reached (${this.plugin.settings.maxTabs}). Adjust it in settings.`);
      return;
    }
    this.tabSeq += 1;
    const id = `tab-${Date.now()}-${this.tabSeq}`;
    const bodyEl = this.bodyHostEl.createDiv({ cls: "agy-body" });
    const tabButtonEl = this.tabBarEl.createDiv({ cls: "agy-tab" });
    const tab: Tab = {
      id,
      title: `Chat ${this.tabSeq}`,
      messages: [],
      uiMeta: [],
      model: this.plugin.settings.model,
      session: null,
      handle: null,
      bodyEl,
      tabButtonEl,
      lastUsage: null,
      historyId: id
    };
    this.renderGreeting(tab);

    const label = tabButtonEl.createSpan({ cls: "agy-tab-label", text: tab.title });
    label.onclick = () => this.activateTab(id);
    const closeBtn = tabButtonEl.createSpan({ cls: "agy-tab-close" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      void this.closeTab(id);
    };

    this.tabs.push(tab);
    this.activateTab(id);
  }

  private activateTab(id: string): void {
    this.activeTabId = id;
    for (const t of this.tabs) {
      const active = t.id === id;
      t.bodyEl.toggleClass("is-active", active);
      t.tabButtonEl.toggleClass("is-active", active);
    }
    this.refreshRunningState();
    this.refreshMetaBar();
  }

  private async closeTab(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    tab.handle?.abort();
    tab.handle = null;
    if (tab.session) {
      const s = tab.session;
      tab.session = null;
      await s.close();
    }
    tab.bodyEl.remove();
    tab.tabButtonEl.remove();
    this.tabs.splice(idx, 1);
    if (this.tabs.length === 0) {
      this.newTab();
      return;
    }
    if (this.activeTabId === id) {
      this.activateTab(this.tabs[Math.max(0, idx - 1)].id);
    }
  }

  private activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  private refreshRunningState(): void {
    const running = !!this.activeTab()?.handle;
    this.sendBtn.setText(running ? "Stop" : "Send");
    this.sendBtn.classList.toggle("is-running", running);
    this.statusEl.setText(running ? "Antigravity is working..." : "");
  }

  /** Refresh the footer meta bar and preset bar. Public so settings can refresh it live. */
  refreshMetaBar(): void {
    if (!this.accessChipEl) return;
    const s = this.plugin.settings;
    const tab = this.activeTab();

    const modelId = tab?.model || s.model || "";
    const cached = s.cachedModels.find((m) => m.id === modelId);
    this.metaModelEl.setText(cached?.label || humanizeModel(modelId) || "(default model)");

    const u = tab?.lastUsage;
    this.metaTokensEl.setText(u ? `in ${u.inputTokens.toLocaleString()} / out ${u.outputTokens.toLocaleString()}` : "");
    this.metaTokensEl.toggleClass("agy-hidden", !u);

    const base = this.plugin.getVaultBasePath();
    const folder = s.workingFolder ? `${base}${base.includes("\\") ? "\\" : "/"}${s.workingFolder}` : base;
    const name = folder ? folder.split(/[\\/]/).filter(Boolean).pop() || folder : "(no folder)";
    const full = s.toolAccess === "full";
    this.accessLabelEl.setText(full ? `${name} (full access)` : name);
    this.accessChipEl.toggleClass("is-full", full);
    this.accessChipEl.setAttr(
      "aria-label",
      `Working folder: ${folder || "(unavailable)"}\nTool access: ${full ? "FULL (auto-approve all tools)" : "native permission rules"}\nClick to open settings`
    );

    this.renderPresetBar();
  }

  /** Empty-state greeting (kept stable per tab). */
  private renderGreeting(tab: Tab): void {
    if (tab.messages.length > 0) return;
    if (!tab.greeting) {
      const opts = greetingOptions(this.plugin.settings.userName || "");
      tab.greeting = opts[Math.floor(Math.random() * opts.length)];
    }
    const wrap = tab.bodyEl.createDiv({ cls: "agy-greeting" });
    wrap.createDiv({ cls: "agy-greeting-text", text: tab.greeting });
  }

  private clearGreeting(tab: Tab): void {
    tab.bodyEl.querySelector(".agy-greeting")?.remove();
  }

  // ---- presets ----

  private renderPresetBar(): void {
    if (!this.presetBarEl) return;
    this.presetBarEl.empty();
    const presets = this.plugin.settings.presets;
    if (presets.length === 0) {
      this.presetBarEl.createSpan({ cls: "agy-preset-empty", text: "No presets - add some in settings." });
      return;
    }
    for (const preset of presets) {
      const btn = this.presetBarEl.createEl("button", { cls: "agy-preset-btn", text: preset.name });
      btn.setAttr("aria-label", preset.instruction.length > 160 ? preset.instruction.slice(0, 157) + "..." : preset.instruction);
      btn.onclick = () => void this.runPreset(preset.id);
    }
  }

  /** Run a preset against the current selection/note (used by buttons and commands). */
  async runPreset(presetId: string): Promise<void> {
    const preset = this.plugin.settings.presets.find((p) => p.id === presetId);
    if (!preset) {
      new Notice("Antigravity: preset not found.");
      return;
    }
    const mdView = this.plugin.getActiveMarkdownView();
    const sel = this.plugin.getCurrentSelection();
    const hasSelection = !!sel?.text.trim();
    const hasNote = !!mdView;
    if (!presetApplicable(preset, hasSelection, hasNote)) {
      const need = preset.appliesTo === "selection" ? "select some text" : preset.appliesTo === "note" ? "open a note" : "open a note or select text";
      new Notice(`Antigravity: ${preset.name} needs you to ${need} first.`);
      return;
    }
    const target = presetTarget(preset, hasSelection, hasNote);
    if (!target) return;

    const ctx: TurnContext = {};
    if (target === "selection" && sel) {
      ctx.selection = sel.text;
      ctx.notePath = sel.notePath ?? mdView?.file?.path;
      ctx.selectionRange = sel.range;
    } else if (mdView) {
      ctx.notePath = mdView.file?.path;
      ctx.noteContent = mdView.editor.getValue();
    }
    const userText = presetInstruction(preset, target);
    await this.runTurn(userText, ctx, preset.name, preset);
  }

  // ---- model picker ----

  private showModelMenu(evt: MouseEvent): void {
    const tab = this.activeTab();
    const menu = new Menu();
    const models = this.plugin.settings.cachedModels;
    const current = tab?.model || this.plugin.settings.model;
    if (models.length === 0) {
      menu.addItem((item) => item.setTitle("No model list yet - click to load").onClick(() => void this.refreshModels()));
    } else {
      for (const m of models) {
        menu.addItem((item) =>
          item
            .setTitle(m.label || humanizeModel(m.id))
            .setChecked(current === m.id)
            .onClick(() => this.setTabModel(m.id))
        );
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Refresh model list").onClick(() => void this.refreshModels()));
    }
    menu.showAtMouseEvent(evt);
  }

  private async refreshModels(): Promise<void> {
    new Notice("Antigravity: loading models...");
    try {
      const models = await this.plugin.client.listModels();
      this.plugin.settings.cachedModels = models;
      await this.plugin.saveSettings();
      this.refreshMetaBar();
      new Notice(`Antigravity: ${models.length} models loaded.`);
    } catch (e) {
      new Notice(`Antigravity: ${(e as Error).message}`);
    }
  }

  /**
   * Change the model for the active tab. A running agy process is bound to its
   * model, so an existing session is closed; the next turn resumes the same
   * conversation with the new model.
   */
  private setTabModel(id: string): void {
    const tab = this.activeTab();
    if (!tab) return;
    if (tab.handle) {
      new Notice("Antigravity: wait for the current reply to finish before switching models.");
      return;
    }
    tab.model = id;
    if (tab.session) {
      const s = tab.session;
      tab.session = null;
      void s.close();
    }
    this.refreshMetaBar();
  }

  // ---- sending ----

  /** Public entry used by commands: run a turn with prepared text + context. */
  submitPrompt(userText: string, display: string | undefined, ctx: TurnContext): void {
    void this.runTurn(userText, ctx, display);
  }

  private async onSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    const ctx: TurnContext = {};
    const mdView = this.plugin.getActiveMarkdownView();
    if (this.includeNoteToggle.checked && mdView) {
      ctx.notePath = mdView.file?.path;
      if (this.plugin.settings.includeNoteContent) ctx.noteContent = mdView.editor.getValue();
    }
    if (this.includeSelectionToggle.checked) {
      const sel = this.plugin.getCurrentSelection();
      if (sel) {
        ctx.selection = sel.text;
        ctx.selectionRange = sel.range;
        if (!ctx.notePath) ctx.notePath = sel.notePath;
      }
    }
    this.inputEl.value = "";
    await this.runTurn(text, ctx, text);
  }

  /** Create (or re-create) the tab's agy session and wait for its init event. */
  private async ensureSession(tab: Tab): Promise<AgySession> {
    if (tab.session?.alive) return tab.session;
    if (tab.session) {
      void tab.session.close();
      tab.session = null;
    }
    const session = this.plugin.client.createSession(tab.model, tab.conversationId);
    tab.session = session;
    const info = await session.start();
    if (info.conversationId) tab.conversationId = info.conversationId;
    return session;
  }

  /**
   * Run one conversation turn in the active tab.
   * @param userText the user's message (preset instruction or typed text)
   * @param ctx      attached note/selection (rendered as collapsed chips)
   * @param display  optional shorter text for the user bubble
   * @param preset   the preset that produced this turn (for the suggested action)
   */
  private async runTurn(userText: string, ctx: TurnContext, display?: string, preset?: Preset): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    if (tab.handle) {
      new Notice("Antigravity: a response is already streaming in this tab.");
      return;
    }

    this.clearGreeting(tab);
    this.renderUserMessage(tab, display ?? userText, ctx);
    const assistant = this.createAssistantMessage(tab);
    this.statusEl.setText("Starting Antigravity...");

    const noteCtx: NoteContext = { notePath: ctx.notePath, selection: ctx.selection, noteContent: ctx.noteContent };
    const s = this.plugin.settings;
    const appContext = buildAppContext({
      vaultPath: this.plugin.client.workingDir(),
      outputLanguage: s.outputLanguage,
      customPrompt: s.customSystemPrompt,
      markdownReminder: s.markdownFormattingPromptEnabled,
      fullAccess: s.toolAccess === "full"
    });
    const full = assembleTurn(userText, noteCtx, appContext);

    tab.messages.push({ role: "user", content: full });
    tab.uiMeta.push({ display: display ?? userText, ctx });

    // Placeholder handle so Send shows Stop while the process starts.
    let starting = true;
    tab.handle = {
      abort: () => {
        if (!starting) return;
        starting = false;
        const sess = tab.session;
        tab.session = null;
        sess?.stop();
      }
    };
    this.refreshRunningState();

    let session: AgySession;
    try {
      session = await this.ensureSession(tab);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.finishWithError(tab, assistant, msg);
      return;
    }
    if (!starting) {
      // Stopped while starting.
      this.finishWithError(tab, assistant, "Stopped.");
      return;
    }
    starting = false;

    let buffer = "";
    const flush = () => {
      assistant.contentEl.empty();
      void MarkdownRenderer.render(this.app, buffer || "", assistant.contentEl, ctx.notePath || "", this);
      this.scrollToBottom(tab);
    };

    try {
      tab.handle = session.send(full, {
        onChunk: (t) => {
          buffer += t;
          flush();
        },
        onToolEvent: (e: ToolEvent) => {
          this.renderToolEvent(assistant, e);
          this.scrollToBottom(tab);
        },
        onUsage: (u: UsageInfo) => {
          tab.lastUsage = u;
          assistant.usageEl.setText(`tokens: in ${u.inputTokens.toLocaleString()} / out ${u.outputTokens.toLocaleString()}`);
          if (tab.id === this.activeTabId) this.refreshMetaBar();
        },
        onError: (msg) => {
          this.finishWithError(tab, assistant, msg, buffer);
        },
        onDone: (conversationId) => {
          if (conversationId) tab.conversationId = conversationId;
          tab.messages.push({ role: "assistant", content: buffer });
          tab.uiMeta.push(undefined);
          tab.handle = null;
          this.renderResultActions(assistant, buffer, ctx, preset?.suggestedAction);
          this.refreshRunningState();
          this.saveTabHistory(tab);
        }
      });
    } catch (e) {
      this.finishWithError(tab, assistant, (e as Error).message);
      return;
    }
    this.refreshRunningState();
  }

  private finishWithError(tab: Tab, assistant: AssistantEls, msg: string, partial = ""): void {
    if (partial.trim()) {
      // Keep whatever streamed before the failure, then show the error under it.
      assistant.contentEl.createDiv({ cls: "agy-error", text: msg });
      this.renderResultActions(assistant, partial, undefined);
    } else {
      assistant.contentEl.empty();
      assistant.contentEl.createDiv({ cls: "agy-error", text: msg });
    }
    tab.handle = null;
    tab.messages.push({ role: "assistant", content: partial ? `${partial}\n\n[error] ${msg}` : `[error] ${msg}` });
    tab.uiMeta.push(undefined);
    this.refreshRunningState();
    this.scrollToBottom(tab);
    this.saveTabHistory(tab);
  }

  private stopActive(): void {
    const tab = this.activeTab();
    if (tab?.handle) {
      tab.handle.abort();
      tab.handle = null;
      // The process is gone; the conversation id survives for the next turn.
      tab.session = null;
      this.refreshRunningState();
      this.statusEl.setText("Stopped.");
    }
  }

  // ---- rendering helpers ----

  private renderUserMessage(tab: Tab, text: string, ctx?: TurnContext): void {
    const msg = tab.bodyEl.createDiv({ cls: "agy-msg agy-msg-user" });
    msg.createDiv({ cls: "agy-msg-role", text: "You" });
    msg.createDiv({ cls: "agy-msg-content", text });
    if (ctx) this.renderAttachments(msg, ctx);
    this.scrollToBottom(tab);
  }

  private renderAttachments(msg: HTMLElement, ctx: TurnContext): void {
    const chips: { label: string; body: string }[] = [];
    const baseName = (p?: string) => (p ? (p.split("/").pop() ?? p) : "current note");
    if (ctx.noteContent && ctx.noteContent.trim()) {
      chips.push({ label: `note: ${baseName(ctx.notePath)} (${formatAttachmentSize(ctx.noteContent.length)})`, body: ctx.noteContent });
    }
    if (ctx.selection && ctx.selection.trim()) {
      chips.push({ label: `selection: ${baseName(ctx.notePath)} (${formatAttachmentSize(ctx.selection.length)})`, body: ctx.selection });
    }
    for (const chip of chips) {
      const wrap = msg.createDiv({ cls: "agy-attachment" });
      const titleEl = wrap.createDiv({ cls: "agy-attachment-title", text: `> ${chip.label}` });
      const bodyEl = wrap.createDiv({ cls: "agy-attachment-body" });
      bodyEl.setText(chip.body);
      titleEl.addEventListener("click", () => {
        const expanded = wrap.classList.toggle("is-expanded");
        titleEl.setText(`${expanded ? "v" : ">"} ${chip.label}`);
      });
    }
  }

  private createAssistantMessage(tab: Tab): AssistantEls {
    const msgEl = tab.bodyEl.createDiv({ cls: "agy-msg agy-msg-assistant" });
    msgEl.createDiv({ cls: "agy-msg-role", text: "Antigravity" });
    const toolsEl = msgEl.createDiv({ cls: "agy-tools" });
    const contentEl = msgEl.createDiv({ cls: "agy-msg-content" });
    const usageEl = msgEl.createDiv({ cls: "agy-usage" });
    const actionsEl = msgEl.createDiv({ cls: "agy-actions" });
    return { msgEl, contentEl, toolsEl, usageEl, actionsEl };
  }

  private renderToolEvent(assistant: AssistantEls, e: ToolEvent): void {
    // One line per tool step: update in place from running -> completed/failed.
    const existing = assistant.toolsEl.querySelector<HTMLElement>(`[data-step="${e.stepIndex}"]`);
    const line = existing ?? assistant.toolsEl.createDiv({ attr: { "data-step": String(e.stepIndex) } });
    line.className = `agy-tool agy-tool-${e.status}`;
    line.empty();
    const iconEl = line.createSpan({ cls: "agy-tool-icon" });
    setIcon(iconEl, e.status === "completed" ? "check" : e.status === "failed" ? "x" : "loader");
    line.createSpan({ cls: "agy-tool-name", text: ` ${e.name}` });
    if (e.preview) line.createSpan({ cls: "agy-tool-preview", text: ` ${e.preview}` });
    if (e.error) line.createSpan({ cls: "agy-tool-error", text: ` ${e.error}` });
  }

  /** Copy / Insert / Replace / Append / New note buttons under a reply. */
  private renderResultActions(assistant: AssistantEls, text: string, ctx?: TurnContext, suggested?: ResultAction): void {
    assistant.actionsEl.empty();
    if (!text.trim()) return;
    const actions: { id: ResultAction; label: string; icon: string; show: boolean }[] = [
      { id: "copy", label: "Copy", icon: "copy", show: true },
      { id: "insert", label: "Insert", icon: "text-cursor-input", show: true },
      { id: "replace", label: "Replace selection", icon: "replace", show: !!ctx?.selection },
      { id: "append", label: "Append to note", icon: "list-plus", show: true },
      { id: "new-note", label: "New note", icon: "file-plus", show: true }
    ];
    for (const a of actions) {
      if (!a.show) continue;
      const btn = assistant.actionsEl.createEl("button", { cls: "agy-action-btn" });
      if (a.id === suggested) btn.addClass("is-suggested");
      const icon = btn.createSpan({ cls: "agy-action-icon" });
      setIcon(icon, a.icon);
      btn.createSpan({ text: a.label });
      btn.onclick = () => void this.plugin.applyResult(a.id, text, ctx ?? {});
    }
  }

  private scrollToBottom(tab: Tab): void {
    tab.bodyEl.scrollTop = tab.bodyEl.scrollHeight;
  }

  // ---- chat history ----

  private openHistory(): void {
    new HistoryModal(this.app, this).open();
  }

  getConversations(): Conversation[] {
    return this.plugin.conversations.slice();
  }

  private saveTabHistory(tab: Tab): void {
    if (!tab.messages.length) return;
    const messages: StoredMessage[] = tab.messages.map((m, i) => {
      const meta = tab.uiMeta[i];
      const stored: StoredMessage = { role: m.role, content: m.content };
      if (meta?.display !== undefined) stored.display = meta.display;
      if (meta?.ctx && (meta.ctx.noteContent || meta.ctx.selection)) {
        stored.attachments = { notePath: meta.ctx.notePath, noteContent: meta.ctx.noteContent, selection: meta.ctx.selection };
      }
      return stored;
    });
    const entry: Conversation = {
      id: tab.historyId,
      title: deriveTitle(messages),
      updatedAt: Date.now(),
      messages
    };
    if (tab.conversationId) entry.conversationId = tab.conversationId;
    if (tab.model) entry.model = tab.model;
    void this.plugin.saveConversation(entry);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.plugin.deleteConversation(id);
  }

  /** Restore a saved conversation into a tab (reuses an empty active tab). */
  restoreConversation(id: string): void {
    const conv = this.plugin.conversations.find((c) => c.id === id);
    if (!conv) return;

    let tab = this.activeTab();
    if (!tab || tab.messages.length > 0) {
      const before = this.tabs.length;
      this.newTab();
      if (this.tabs.length === before) {
        new Notice("Antigravity: close a tab first (tab limit reached).");
        return;
      }
      tab = this.activeTab();
    }
    if (!tab) return;

    tab.bodyEl.empty();
    tab.messages = conv.messages.map((m) => ({ role: m.role, content: m.content }));
    tab.uiMeta = conv.messages.map((m) =>
      m.display !== undefined || m.attachments
        ? {
            display: m.display,
            ctx: m.attachments
              ? { notePath: m.attachments.notePath, noteContent: m.attachments.noteContent, selection: m.attachments.selection }
              : undefined
          }
        : undefined
    );
    tab.conversationId = conv.conversationId;
    if (conv.model) tab.model = conv.model;
    tab.historyId = conv.id;
    tab.lastUsage = null;
    tab.title = tabLabel(conv.title);
    const labelEl = tab.tabButtonEl.querySelector(".agy-tab-label");
    if (labelEl) labelEl.setText(tab.title);

    this.renderRestoredMessages(tab);
    this.activateTab(tab.id);
  }

  private renderRestoredMessages(tab: Tab): void {
    tab.messages.forEach((m, i) => {
      if (m.role === "user") {
        const meta = tab.uiMeta[i];
        this.renderUserMessage(tab, meta?.display ?? m.content, meta?.ctx);
      } else if (m.role === "assistant") {
        const assistant = this.createAssistantMessage(tab);
        const content = m.content || "";
        const errIdx = content.indexOf("[error] ");
        const body = errIdx >= 0 ? content.slice(0, errIdx).trim() : content;
        if (body) void MarkdownRenderer.render(this.app, body, assistant.contentEl, "", this);
        if (errIdx >= 0) assistant.contentEl.createDiv({ cls: "agy-error", text: content.slice(errIdx + "[error] ".length) });
        const userMeta = i > 0 ? tab.uiMeta[i - 1] : undefined;
        if (body) this.renderResultActions(assistant, body, userMeta?.ctx);
      }
    });
    this.scrollToBottom(tab);
  }
}

/** Modal listing saved conversations, with open + delete per row. */
class HistoryModal extends Modal {
  constructor(
    app: App,
    private view: AntigravityView
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("agy-history-modal");
    contentEl.createEl("h3", { text: "Chat history" });

    const listEl = contentEl.createDiv({ cls: "agy-history-list" });
    const emptyEl = contentEl.createDiv({ cls: "agy-history-empty", text: "No saved conversations yet." });

    const render = (): void => {
      listEl.empty();
      const items = this.view.getConversations();
      emptyEl.toggleClass("agy-hidden", items.length > 0);
      const now = Date.now();
      for (const conv of items) {
        const row = listEl.createDiv({ cls: "agy-history-row" });
        const main = row.createDiv({ cls: "agy-history-main" });
        main.createDiv({ cls: "agy-history-title", text: conv.title });
        const preview = lastMessagePreview(conv.messages);
        if (preview) main.createDiv({ cls: "agy-history-preview", text: preview });
        main.createDiv({
          cls: "agy-history-meta",
          text: `${relativeTime(now, conv.updatedAt)} - ${conv.messages.length} messages${conv.model ? ` - ${humanizeModel(conv.model)}` : ""}`
        });
        main.onclick = () => {
          this.view.restoreConversation(conv.id);
          this.close();
        };
        const del = row.createSpan({ cls: "agy-history-del", attr: { "aria-label": "Delete" } });
        setIcon(del, "trash");
        del.onclick = async (e) => {
          e.stopPropagation();
          await this.view.deleteConversation(conv.id);
          render();
        };
      }
    };
    render();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
