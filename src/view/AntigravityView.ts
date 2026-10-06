// AntigravityView - the sidebar chat panel with a multi-tab manager.
//
// Ported from the hermes-agent plugin's HermesView. Each tab owns one agy
// session (a persistent child process), its conversation id, its messages,
// and its DOM. Pure Obsidian DOM API, no framework.

import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AntigravityPlugin from "../main";
import type { TurnContext } from "../main";
import type { AgySession, ChatHandle } from "../runtime/agySession";
import { structuredToMarkdown } from "../runtime/batch";
import { assembleTurn, stripAppContext } from "../runtime/context";
import type { NoteContext } from "../runtime/context";
import { Conversation, StoredMessage, deriveTitle, lastMessagePreview, relativeTime, tabLabel } from "../runtime/history";
import { Preset, ResultAction, presetApplicable, presetIcon, presetInstruction, presetTarget } from "../runtime/presets";
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
  streamEl: HTMLElement;
  contentEl: HTMLElement;
  /** Errors render here, outside contentEl, which the paint chain owns. */
  errorEl: HTMLElement;
  toolsEl: HTMLElement;
  usageEl: HTMLElement;
  actionsEl: HTMLElement;
  /** Cancels a queued animation-frame paint; set while the turn streams. */
  cancelPending?: () => void;
  /** Forces one last render of the buffered text and resolves when painted. */
  finalize?: () => Promise<void>;
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
  /** Follow new output only while the user is parked near the bottom. */
  stickToBottom: boolean;
  /** The in-flight assistant bubble, so Stop can settle it cleanly. */
  pendingAssistant?: AssistantEls;
}

export class AntigravityView extends ItemView {
  private plugin: AntigravityPlugin;

  private tabBarEl!: HTMLElement;
  private bodyHostEl!: HTMLElement;
  private presetBarEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private ctxNoteChipEl!: HTMLElement;
  private ctxSelChipEl!: HTMLElement;
  private scrollBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private metaModelEl!: HTMLElement;
  private metaTokensEl!: HTMLElement;
  private accessChipEl!: HTMLElement;
  private accessLabelEl!: HTMLElement;

  /** Whether the next turn attaches the current note / the selection. */
  private includeNote = false;
  private includeSelection = false;
  /** What context actually exists right now (drives the chip states). */
  private noteAvailable = false;
  private selAvailable = false;

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

    // ---- header ----
    const header = root.createDiv({ cls: "agy-header" });
    const brand = header.createDiv({ cls: "agy-brand" });
    const brandIcon = brand.createSpan({ cls: "agy-brand-icon" });
    setIcon(brandIcon, "sparkles");
    brand.createSpan({ cls: "agy-title", text: "Antigravity" });

    const headerActions = header.createDiv({ cls: "agy-header-actions" });
    const historyBtn = headerActions.createEl("button", {
      cls: "agy-icon-btn",
      attr: { "aria-label": "Chat history", title: "Chat history" }
    });
    setIcon(historyBtn, "history");
    historyBtn.onclick = () => this.openHistory();
    const newTabBtn = headerActions.createEl("button", {
      cls: "agy-icon-btn",
      attr: { "aria-label": "New tab", title: "New tab" }
    });
    setIcon(newTabBtn, "plus");
    newTabBtn.onclick = () => this.newTab();

    // ---- tab bar ----
    this.tabBarEl = root.createDiv({
      cls: "agy-tabbar",
      attr: { role: "tablist", "aria-label": "Chat tabs" }
    });
    this.tabBarEl.addEventListener("keydown", (e) => this.onTabBarKeydown(e));

    // ---- transcript ----
    this.bodyHostEl = root.createDiv({ cls: "agy-body-host" });
    this.scrollBtnEl = this.bodyHostEl.createEl("button", {
      cls: "agy-scroll-btn",
      attr: { "aria-label": "Scroll to latest", title: "Scroll to latest" }
    });
    setIcon(this.scrollBtnEl, "chevron-down");
    this.scrollBtnEl.onclick = () => {
      const tab = this.activeTab();
      if (!tab) return;
      tab.stickToBottom = true;
      this.scrollToBottom(tab);
      this.refreshScrollBtn();
    };

    // ---- composer ----
    const composer = root.createDiv({ cls: "agy-composer" });

    this.presetBarEl = composer.createDiv({ cls: "agy-preset-bar" });
    this.renderPresetBar();

    const ctxRow = composer.createDiv({ cls: "agy-context-row" });
    this.ctxNoteChipEl = this.createContextChip(ctxRow, "file-text", "Current note", () => {
      if (!this.noteAvailable) return;
      this.includeNote = !this.includeNote;
      this.refreshContextChips();
    });
    this.ctxSelChipEl = this.createContextChip(ctxRow, "scissors", "Selection", () => {
      if (!this.selAvailable) return;
      this.includeSelection = !this.includeSelection;
      this.refreshContextChips();
    });

    const inputWrap = composer.createDiv({ cls: "agy-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "agy-input",
      attr: { rows: "1", placeholder: "Ask Antigravity, or pick a preset…" }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.onSend();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autoGrowInput();
      this.plugin.touchSelectionActivity();
    });

    // Meta bar (model | tokens | access chip)
    const inputActions = inputWrap.createDiv({ cls: "agy-input-actions" });
    const metaEl = inputActions.createDiv({ cls: "agy-input-meta" });
    this.metaModelEl = metaEl.createEl("button", {
      cls: "agy-meta-item agy-meta-model",
      attr: { title: "Switch model" }
    });
    this.metaModelEl.onclick = (e) => this.showModelMenu(e);
    this.metaTokensEl = metaEl.createDiv({
      cls: "agy-meta-item agy-meta-tokens",
      attr: { "aria-label": "Tokens used by the last turn" }
    });
    this.accessChipEl = metaEl.createEl("button", {
      cls: "agy-access-chip",
      attr: { title: "Working folder and tool access - click to open settings" }
    });
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
    this.autoGrowInput();
    return Promise.resolve();
  }

  /** One toggle chip in the composer's context row. */
  private createContextChip(parent: HTMLElement, icon: string, label: string, onToggle: () => void): HTMLElement {
    const chip = parent.createEl("button", {
      cls: "agy-ctx-chip",
      attr: { "aria-pressed": "false", title: `Attach the ${label.toLowerCase()} to your message` }
    });
    const iconEl = chip.createSpan({ cls: "agy-ctx-icon" });
    setIcon(iconEl, icon);
    chip.createSpan({ cls: "agy-ctx-label", text: label });
    chip.onclick = onToggle;
    return chip;
  }

  /** Keep the composer textarea sized to its content (up to a cap). */
  private autoGrowInput(): void {
    if (!this.inputEl) return;
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 180)}px` });
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
    bodyEl.id = `agy-panel-${id}`;
    bodyEl.setAttr("role", "tabpanel");
    const tabButtonEl = this.tabBarEl.createDiv({
      cls: "agy-tab",
      attr: { role: "tab", "aria-selected": "false", "aria-controls": bodyEl.id, tabindex: "-1" }
    });
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
      historyId: id,
      stickToBottom: true
    };
    bodyEl.addEventListener("scroll", () => this.onBodyScroll(tab));
    this.renderGreeting(tab);

    const dotEl = tabButtonEl.createSpan({ cls: "agy-tab-dot" });
    dotEl.setAttr("aria-hidden", "true");
    tabButtonEl.createSpan({ cls: "agy-tab-label", text: tab.title });
    const closeBtn = tabButtonEl.createEl("button", {
      cls: "agy-tab-close",
      attr: { "aria-label": "Close tab", title: "Close tab" }
    });
    setIcon(closeBtn, "x");
    tabButtonEl.onclick = () => this.activateTab(id);
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      void this.closeTab(id);
    };

    this.tabs.push(tab);
    this.activateTab(id);
  }

  private setTabTitle(tab: Tab, title: string): void {
    tab.title = title;
    const labelEl = tab.tabButtonEl.querySelector<HTMLElement>(".agy-tab-label");
    if (labelEl) labelEl.setText(title);
    tab.tabButtonEl.setAttr("aria-label", title);
  }

  /** Left/Right move between tabs (the ARIA tablist convention). */
  private onTabBarKeydown(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    if (idx === -1) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = this.tabs[(idx + step + this.tabs.length) % this.tabs.length];
    this.activateTab(next.id);
    next.tabButtonEl.focus();
  }

  private activateTab(id: string): void {
    this.activeTabId = id;
    for (const t of this.tabs) {
      const active = t.id === id;
      t.bodyEl.toggleClass("is-active", active);
      t.tabButtonEl.toggleClass("is-active", active);
      t.tabButtonEl.setAttr("aria-selected", active ? "true" : "false");
      t.tabButtonEl.setAttr("tabindex", active ? "0" : "-1");
    }
    this.refreshRunningState();
    this.refreshMetaBar();
    this.refreshScrollBtn();
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
    this.sendBtn.setAttr("aria-label", running ? "Stop the current reply" : "Send message");
    this.statusEl.setText(running ? "Working…" : "");
    // Mark every streaming tab, not just the active one.
    for (const t of this.tabs) t.tabButtonEl.toggleClass("is-streaming", !!t.handle);
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
    this.refreshContextChips();
  }

  /**
   * Reflect what context actually exists: a chip is only usable (and only
   * renders as "on") when the note/selection it needs is really there.
   */
  refreshContextChips(): void {
    if (!this.ctxNoteChipEl) return;
    const mdView = this.plugin.getActiveMarkdownView();
    const sel = this.plugin.getCurrentSelection();
    const selText = sel && sel.text.trim() ? sel.text : "";

    this.noteAvailable = !!mdView;
    this.selAvailable = !!selText;

    this.updateContextChip(
      this.ctxNoteChipEl,
      this.includeNote && this.noteAvailable,
      this.noteAvailable,
      this.noteAvailable ? `Note: ${mdView?.file?.basename ?? "current"}` : "No note open"
    );
    this.updateContextChip(
      this.ctxSelChipEl,
      this.includeSelection && this.selAvailable,
      this.selAvailable,
      this.selAvailable ? `Selection: ${formatAttachmentSize(selText.length)}` : "No selection"
    );
  }

  private updateContextChip(chip: HTMLElement, on: boolean, available: boolean, label: string): void {
    chip.toggleClass("is-on", on);
    chip.toggleClass("is-off", !available);
    chip.setAttr("aria-pressed", on ? "true" : "false");
    chip.setAttr("aria-disabled", available ? "false" : "true");
    const labelEl = chip.querySelector<HTMLElement>(".agy-ctx-label");
    if (labelEl && labelEl.textContent !== label) labelEl.setText(label);
  }

  /** Empty-state hero (kept stable per tab). */
  private renderGreeting(tab: Tab): void {
    if (tab.messages.length > 0) return;
    if (!tab.greeting) {
      const opts = greetingOptions(this.plugin.settings.userName || "");
      tab.greeting = opts[Math.floor(Math.random() * opts.length)];
    }
    const wrap = tab.bodyEl.createDiv({ cls: "agy-greeting" });
    const glyph = wrap.createDiv({ cls: "agy-greeting-glyph" });
    setIcon(glyph, "sparkles");
    wrap.createDiv({ cls: "agy-greeting-text", text: tab.greeting });
    wrap.createDiv({ cls: "agy-greeting-hint", text: this.greetingHint() });

    const keys = wrap.createDiv({ cls: "agy-greeting-keys" });
    for (const [key, what] of [
      ["Enter", "send"],
      ["Shift+Enter", "new line"]
    ]) {
      const row = keys.createSpan({ cls: "agy-keyhint" });
      row.createEl("kbd", { text: key });
      row.createSpan({ text: what });
    }
  }

  private greetingHint(): string {
    const presets = this.plugin.settings.presets.length;
    if (presets > 0) return "Pick a preset above, attach a note, or just start typing.";
    return "Ask anything about your vault, or add presets in settings.";
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
      const btn = this.presetBarEl.createEl("button", { cls: "agy-preset-btn" });
      const iconEl = btn.createSpan({ cls: "agy-preset-icon" });
      setIcon(iconEl, presetIcon(preset));
      btn.createSpan({ cls: "agy-preset-label", text: preset.name });
      btn.setAttr("aria-label", preset.instruction.length > 160 ? preset.instruction.slice(0, 157) + "..." : preset.instruction);
      btn.setAttr("title", preset.instruction.length > 160 ? preset.instruction.slice(0, 157) + "..." : preset.instruction);
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
    if (this.includeNote && mdView) {
      ctx.notePath = mdView.file?.path;
      if (this.plugin.settings.includeNoteContent) ctx.noteContent = mdView.editor.getValue();
    }
    if (this.includeSelection) {
      const sel = this.plugin.getCurrentSelection();
      if (sel && sel.text.trim()) {
        ctx.selection = sel.text;
        ctx.selectionRange = sel.range;
        if (!ctx.notePath) ctx.notePath = sel.notePath;
      }
    }
    this.inputEl.value = "";
    this.autoGrowInput();
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
    tab.pendingAssistant = assistant;
    this.statusEl.setText("Starting…");

    const noteCtx: NoteContext = { notePath: ctx.notePath, selection: ctx.selection, noteContent: ctx.noteContent };
    const full = assembleTurn(userText, noteCtx, this.plugin.buildAppContextText());

    tab.messages.push({ role: "user", content: full });
    tab.uiMeta.push({ display: display ?? userText, ctx });

    // A preset with an output schema runs in its own one-shot session: the
    // --json-schema flag is process-level and would force JSON onto every
    // later chat turn of the tab's long-lived process.
    const schema = preset?.outputSchema;
    let oneShot: AgySession | null = null;

    // Placeholder handle so Send shows Stop while the process starts.
    let starting = true;
    tab.handle = {
      abort: () => {
        if (!starting) return;
        starting = false;
        if (oneShot) {
          oneShot.stop();
          return;
        }
        const sess = tab.session;
        tab.session = null;
        sess?.stop();
      }
    };
    this.refreshRunningState();

    let session: AgySession;
    try {
      if (schema) {
        oneShot = this.plugin.client.createSession(tab.model, undefined, { jsonSchema: schema });
        await oneShot.start();
        session = oneShot;
      } else {
        session = await this.ensureSession(tab);
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.finishWithError(tab, assistant, msg, "", ctx, preset);
      return;
    }
    if (!starting) {
      // Stopped while starting.
      if (oneShot) void oneShot.close();
      this.finishWithError(tab, assistant, "Stopped.", "", ctx, preset);
      return;
    }
    starting = false;

    let buffer = "";
    let lastRendered = "";
    let chain: Promise<void> = Promise.resolve();
    let frame: number | null = null;

    // Serialized, frame-throttled Markdown rendering. Deltas arrive far faster
    // than the renderer can keep up, and every render re-parses the whole
    // buffer: overlapping renders would both be quadratic and able to
    // interleave their output into the same element.
    const paint = (force = false): Promise<void> => {
      chain = chain.then(async () => {
        const text = buffer;
        if (!force && text === lastRendered) return;
        lastRendered = text;
        assistant.contentEl.empty();
        await MarkdownRenderer.render(this.app, text, assistant.contentEl, ctx.notePath || "", this);
        if (tab.stickToBottom) this.scrollToBottom(tab);
      });
      return chain;
    };
    const schedulePaint = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void paint();
      });
    };
    const cancelPaint = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
    };
    assistant.cancelPending = cancelPaint;
    assistant.finalize = () => paint(true);

    const releaseOneShot = () => {
      if (oneShot) void oneShot.close();
    };

    try {
      tab.handle = session.send(full, {
        onChunk: (t) => {
          buffer += t;
          assistant.streamEl.addClass("agy-hidden");
          schedulePaint();
        },
        onToolEvent: (e: ToolEvent) => {
          this.renderToolEvent(assistant, e);
          if (tab.stickToBottom) this.scrollToBottom(tab);
        },
        onUsage: (u: UsageInfo) => {
          tab.lastUsage = u;
          assistant.usageEl.setText(`in ${u.inputTokens.toLocaleString()} / out ${u.outputTokens.toLocaleString()}`);
          if (tab.id === this.activeTabId) this.refreshMetaBar();
        },
        onError: (msg) => {
          releaseOneShot();
          this.finishWithError(tab, assistant, msg, buffer, ctx, preset);
        },
        onDone: (conversationId, _response, structured) => {
          releaseOneShot();
          cancelPaint();
          // Structured runs are one-shot: they do not own the tab's conversation.
          if (conversationId && !oneShot) tab.conversationId = conversationId;
          if (structured) buffer = structuredToMarkdown(structured) || buffer;
          tab.messages.push({ role: "assistant", content: buffer });
          tab.uiMeta.push(undefined);
          tab.handle = null;
          tab.pendingAssistant = undefined;
          // Settle the final text before wiring the action buttons underneath.
          void paint(true).then(() => {
            assistant.cancelPending = undefined;
            this.renderResultActions(assistant, buffer, ctx, preset?.suggestedAction, structured);
            this.refreshRunningState();
            this.refreshScrollBtn();
            this.saveTabHistory(tab);
          });
        }
      });
    } catch (e) {
      releaseOneShot();
      this.finishWithError(tab, assistant, (e as Error).message, "", ctx, preset);
      return;
    }
    this.refreshRunningState();
  }

  private finishWithError(
    tab: Tab,
    assistant: AssistantEls,
    msg: string,
    partial = "",
    ctx?: TurnContext,
    preset?: Preset
  ): void {
    assistant.cancelPending?.();
    assistant.streamEl.addClass("agy-hidden");
    // The error lives outside contentEl, which the render chain still owns, so a
    // late render of the partial reply cannot wipe it.
    assistant.errorEl.createDiv({ cls: "agy-error", text: msg });
    tab.handle = null;
    tab.pendingAssistant = undefined;
    tab.messages.push({ role: "assistant", content: partial ? `${partial}\n\n[error] ${msg}` : `[error] ${msg}` });
    tab.uiMeta.push(undefined);
    this.refreshRunningState();
    if (tab.stickToBottom) this.scrollToBottom(tab);
    this.refreshScrollBtn();

    const finalize = assistant.finalize;
    assistant.finalize = undefined;
    assistant.cancelPending = undefined;
    if (partial.trim() && finalize) {
      void finalize().then(() => {
        // A failed turn that still produced text keeps its result actions.
        this.renderResultActions(assistant, partial, ctx, preset?.suggestedAction);
        this.refreshScrollBtn();
      });
    }
    this.saveTabHistory(tab);
  }

  private stopActive(): void {
    const tab = this.activeTab();
    if (!tab?.handle) return;
    tab.handle.abort();
    tab.handle = null;
    // The process is gone; the conversation id survives for the next turn.
    tab.session = null;

    // Settle the bubble the stopped turn was streaming into: keep the partial
    // text on screen and drop the spinner instead of leaving it spinning.
    const assistant = tab.pendingAssistant;
    tab.pendingAssistant = undefined;
    if (assistant) {
      assistant.cancelPending?.();
      assistant.streamEl.addClass("agy-hidden");
      const finalize = assistant.finalize;
      assistant.finalize = undefined;
      assistant.cancelPending = undefined;
      if (finalize) void finalize();
    }
    this.refreshRunningState();
    this.statusEl.setText("Stopped.");
  }

  // ---- rendering helpers ----

  /** Role header with an avatar glyph, shared by user and assistant bubbles. */
  private renderMessageHead(parent: HTMLElement, role: "user" | "assistant"): void {
    const head = parent.createDiv({ cls: "agy-msg-head" });
    const avatar = head.createSpan({ cls: `agy-avatar agy-avatar-${role}` });
    avatar.setAttr("aria-hidden", "true");
    setIcon(avatar, role === "user" ? "user" : "sparkles");
    head.createSpan({ cls: "agy-msg-role", text: role === "user" ? "You" : "Antigravity" });
  }

  private renderUserMessage(tab: Tab, text: string, ctx?: TurnContext): void {
    const msg = tab.bodyEl.createDiv({ cls: "agy-msg agy-msg-user" });
    this.renderMessageHead(msg, "user");
    msg.createDiv({ cls: "agy-msg-content", text });
    if (ctx) this.renderAttachments(msg, ctx);
    if (tab.stickToBottom) this.scrollToBottom(tab);
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
      const titleEl = wrap.createEl("button", { cls: "agy-attachment-title", attr: { "aria-expanded": "false" } });
      const caret = titleEl.createSpan({ cls: "agy-attachment-caret" });
      caret.setAttr("aria-hidden", "true");
      setIcon(caret, "chevron-right");
      titleEl.createSpan({ cls: "agy-attachment-label", text: chip.label });
      const bodyEl = wrap.createDiv({ cls: "agy-attachment-body" });
      bodyEl.setText(chip.body);
      titleEl.onclick = () => {
        const expanded = wrap.classList.toggle("is-expanded");
        titleEl.setAttr("aria-expanded", expanded ? "true" : "false");
      };
    }
  }

  private createAssistantMessage(tab: Tab): AssistantEls {
    const msgEl = tab.bodyEl.createDiv({ cls: "agy-msg agy-msg-assistant" });
    this.renderMessageHead(msgEl, "assistant");
    const toolsEl = msgEl.createDiv({ cls: "agy-tools" });
    // Shown until the first token lands, so the CLI's several-second startup
    // reads as "working" rather than as an empty reply.
    const streamEl = msgEl.createDiv({ cls: "agy-streaming", attr: { "aria-label": "Antigravity is thinking" } });
    for (let i = 0; i < 3; i++) {
      const dot = streamEl.createSpan({ cls: "agy-streaming-dot" });
      dot.setAttr("aria-hidden", "true");
    }
    const contentEl = msgEl.createDiv({ cls: "agy-msg-content" });
    const errorEl = msgEl.createDiv({ cls: "agy-msg-error" });
    const usageEl = msgEl.createDiv({ cls: "agy-usage" });
    const actionsEl = msgEl.createDiv({ cls: "agy-actions" });
    return { msgEl, streamEl, contentEl, errorEl, toolsEl, usageEl, actionsEl };
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

  /** Copy / Insert / Replace / Append / New note / Frontmatter buttons under a reply. */
  private renderResultActions(
    assistant: AssistantEls,
    text: string,
    ctx?: TurnContext,
    suggested?: ResultAction,
    structured?: Record<string, unknown>
  ): void {
    assistant.actionsEl.empty();
    if (!text.trim() && !structured) return;
    const actions: { id: ResultAction; label: string; icon: string; show: boolean }[] = [
      { id: "frontmatter", label: "Apply to frontmatter", icon: "tags", show: !!structured },
      { id: "copy", label: "Copy", icon: "copy", show: true },
      { id: "insert", label: "Insert", icon: "text-cursor-input", show: true },
      { id: "replace", label: "Replace selection", icon: "replace", show: !!ctx?.selection },
      { id: "append", label: "Append to note", icon: "list-plus", show: true },
      { id: "new-note", label: "New note", icon: "file-plus", show: true }
    ];
    for (const a of actions) {
      if (!a.show) continue;
      const btn = assistant.actionsEl.createEl("button", { cls: "agy-action-btn", attr: { title: a.label } });
      if (a.id === suggested) btn.addClass("is-suggested");
      const icon = btn.createSpan({ cls: "agy-action-icon" });
      setIcon(icon, a.icon);
      btn.createSpan({ cls: "agy-action-label", text: a.label });
      btn.onclick = () => void this.plugin.applyResult(a.id, text, ctx ?? {}, structured);
    }
  }

  // ---- scrolling ----

  private scrollToBottom(tab: Tab): void {
    tab.bodyEl.scrollTop = tab.bodyEl.scrollHeight;
  }

  /** True while the transcript is parked at (or very near) the bottom. */
  private isNearBottom(tab: Tab): boolean {
    const el = tab.bodyEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
  }

  private onBodyScroll(tab: Tab): void {
    tab.stickToBottom = this.isNearBottom(tab);
    if (tab.id === this.activeTabId) this.refreshScrollBtn();
  }

  /** Offer "jump to latest" only when the active transcript is scrolled up. */
  private refreshScrollBtn(): void {
    if (!this.scrollBtnEl) return;
    const tab = this.activeTab();
    const show = !!tab && tab.messages.length > 0 && !this.isNearBottom(tab);
    this.scrollBtnEl.toggleClass("is-visible", show);
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
      // A user turn is stored as the assembled prompt. Drop the house
      // instructions block: it is ~1.5 kB per turn, identical every time, and
      // rebuilt before each send anyway.
      const content = m.role === "user" ? stripAppContext(m.content) : m.content;
      const stored: StoredMessage = { role: m.role, content };
      if (meta?.display !== undefined) stored.display = meta.display;
      if (meta?.ctx && (meta.ctx.noteContent || meta.ctx.selection)) {
        stored.attachments = { notePath: meta.ctx.notePath, noteContent: meta.ctx.noteContent, selection: meta.ctx.selection };
      }
      return stored;
    });
    const title = deriveTitle(messages);
    // Keep the tab bar and the history list showing the same name.
    if (title !== tab.title) this.setTabTitle(tab, tabLabel(title));
    const entry: Conversation = {
      id: tab.historyId,
      title,
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
    this.setTabTitle(tab, tabLabel(conv.title));

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
        assistant.streamEl.addClass("agy-hidden");
        const content = m.content || "";
        const errIdx = content.indexOf("[error] ");
        const body = errIdx >= 0 ? content.slice(0, errIdx).trim() : content;
        if (body) void MarkdownRenderer.render(this.app, body, assistant.contentEl, "", this);
        if (errIdx >= 0) assistant.errorEl.createDiv({ cls: "agy-error", text: content.slice(errIdx + "[error] ".length) });
        const userMeta = i > 0 ? tab.uiMeta[i - 1] : undefined;
        if (body) this.renderResultActions(assistant, body, userMeta?.ctx);
      }
    });
    this.scrollToBottom(tab);
    tab.stickToBottom = true;
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
        const row = listEl.createDiv({ cls: "agy-history-row", attr: { role: "button", tabindex: "0" } });
        const main = row.createDiv({ cls: "agy-history-main" });
        main.createDiv({ cls: "agy-history-title", text: conv.title });
        const preview = lastMessagePreview(conv.messages);
        if (preview) main.createDiv({ cls: "agy-history-preview", text: preview });
        main.createDiv({
          cls: "agy-history-meta",
          text: `${relativeTime(now, conv.updatedAt)} - ${conv.messages.length} messages${conv.model ? ` - ${humanizeModel(conv.model)}` : ""}`
        });
        const open = (): void => {
          this.view.restoreConversation(conv.id);
          this.close();
        };
        row.onclick = open;
        row.addEventListener("keydown", (e) => {
          // Ignore keys aimed at the delete button nested in this row.
          if (e.target !== row) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          open();
        });
        const del = row.createEl("button", {
          cls: "agy-history-del",
          attr: { "aria-label": `Delete ${conv.title}`, title: "Delete" }
        });
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
