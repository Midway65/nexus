/**
 * Location: src/ui/semanticPanel/SemanticPanelView.ts
 * Purpose: Main ItemView for the Nexus semantic discovery panel.
 *
 * Modes:
 *   browse  — anchored to the active markdown note
 *   search  — anchored to a free-text semantic query
 *
 * Result granularities:
 *   notes   — always available
 *   blocks  — only when blockIndexingEnabled and !blockIndexStale
 *
 * Race safety: every async refresh is tagged with a requestId; stale
 * responses are silently discarded.
 *
 * Chat integration: onSendToChat callback supplied by SemanticPanelUIManager
 * (wired from ChatView.addSemanticContext) is forwarded to each result row.
 */

import { ItemView, MarkdownView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type NexusPlugin from '../../main';
import { SEMANTIC_PANEL_VIEW_TYPE } from '../../constants/branding';
import type { NoteEmbeddingService, SimilarNote, SimilarBlock } from '../../services/embeddings/NoteEmbeddingService';
import type { SemanticFeedbackService } from './SemanticFeedbackService';
import { ConnectionsService } from './ConnectionsService';
import type { ConnectionsSettings } from './ConnectionsSettings';
import { SemanticResultRow } from './SemanticResultRow';
import type { RowResult } from './SemanticResultRow';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SemanticContextPayload =
  | {
      kind: 'semantic-note';
      path: string;
      title: string;
      score: number;
      content: string;
    }
  | {
      kind: 'semantic-block';
      path: string;
      title: string;
      heading?: string;
      chunkIndex: number;
      score: number;
      excerpt: string;
    };

type PanelMode = 'browse' | 'search';
type ResultMode = 'notes' | 'blocks';

// ---------------------------------------------------------------------------
// Panel settings (mirrors SemanticPanelSettings in PluginTypes)
// ---------------------------------------------------------------------------

interface PanelSettings {
  resultCount: number;
  minScore: number;
  resultMode: ResultMode;
  autoRefresh: boolean;
  showScore: boolean;
  showFullPath: boolean;
}

const DEFAULT_SETTINGS: PanelSettings = {
  resultCount: 10,
  minScore: 0.70,
  resultMode: 'notes',
  autoRefresh: true,
  showScore: true,
  showFullPath: false,
};

// ---------------------------------------------------------------------------
// SemanticPanelView
// ---------------------------------------------------------------------------

export class SemanticPanelView extends ItemView {
  // ---- services (resolved lazily from plugin) ----
  private noteEmbeddingService: NoteEmbeddingService | null = null;
  private feedbackService: SemanticFeedbackService | null = null;
  private connectionsService: ConnectionsService | null = null;

  // ---- state ----
  private panelMode: PanelMode = 'browse';
  private resultMode: ResultMode = 'notes';
  private activeNotePath: string | null = null;
  private searchQuery = '';
  private settings: PanelSettings = { ...DEFAULT_SETTINGS };

  // ---- race safety ----
  private requestId = 0;

  // ---- timers ----
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- rendered rows ----
  private rows: SemanticResultRow[] = [];

  // ---- block availability (cached per refresh) ----
  private blocksAvailable = false;

  // ---- DOM ----
  private headerEl: HTMLElement | null = null;
  private modeBarEl: HTMLElement | null = null;
  private notesBlocksToggleEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private conversationRefsEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: NexusPlugin,
    private onSendToChat: ((payload: SemanticContextPayload) => void) | null = null,
  ) {
    super(leaf);
  }

  // ---- ItemView overrides ----

  getViewType(): string {
    return SEMANTIC_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Semantic Panel';
  }

  getIcon(): string {
    return 'network';
  }

  async onOpen(): Promise<void> {
    this.resolveServices();
    this.loadSettings();
    this.buildLayout();
    this.wireEvents();
    await this.onActiveFileChange();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
    this.rows = [];
  }

  // ---- service resolution ----

  private resolveServices(): void {
    try {
      const em = (this.plugin as unknown as { getEmbeddingManager?(): { getNoteEmbeddingService?(): NoteEmbeddingService } }).getEmbeddingManager?.();
      this.noteEmbeddingService = em?.getNoteEmbeddingService?.() ?? null;
    } catch { /* service not yet ready */ }

    try {
      const db = (this.plugin as unknown as { getSQLiteManager?(): unknown }).getSQLiteManager?.();
      if (db) {
        // Lazy-import to avoid circular dependency
        const { SemanticFeedbackService: SFS } = require('./SemanticFeedbackService') as { SemanticFeedbackService: new (db: unknown) => SemanticFeedbackService };
        this.feedbackService = new SFS(db);
      }
    } catch { /* not available */ }

    if (this.noteEmbeddingService) {
      this.connectionsService = new ConnectionsService(
        this.app,
        this.noteEmbeddingService,
        () => this.getConnectionsSettings(),
      );
    }
  }

  private getConnectionsSettings(): Partial<ConnectionsSettings> {
    try {
      return (this.plugin as unknown as { settings?: { connections?: Partial<ConnectionsSettings> } }).settings?.connections ?? {};
    } catch {
      return {};
    }
  }

  private loadSettings(): void {
    try {
      const saved = (this.plugin as unknown as { settings?: { semanticPanel?: Partial<PanelSettings> } }).settings?.semanticPanel;
      if (saved) {
        this.settings = { ...DEFAULT_SETTINGS, ...saved };
      }
    } catch { /* use defaults */ }
    this.resultMode = this.settings.resultMode;
  }

  private saveSettings(): void {
    try {
      const p = this.plugin as unknown as { settings?: { semanticPanel?: Partial<PanelSettings> }; saveSettings?(): Promise<void> };
      if (p.settings) {
        p.settings.semanticPanel = { ...this.settings, resultMode: this.resultMode };
        void p.saveSettings?.();
      }
    } catch { /* best-effort */ }
  }

  // ---- layout construction ----

  private get contentContainer(): HTMLElement {
    return this.containerEl.children[1] as HTMLElement;
  }

  private buildLayout(): void {
    const root = this.contentContainer;
    root.empty();
    root.addClass('semantic-panel-view');

    // Header bar
    this.headerEl = root.createDiv('semantic-panel-header');
    this.buildHeaderBar(this.headerEl);

    // Mode/status bar (active note display or search field)
    this.modeBarEl = root.createDiv('semantic-panel-mode-bar');
    this.buildModeBar(this.modeBarEl);

    // Notes/Blocks toggle
    this.notesBlocksToggleEl = root.createDiv('semantic-panel-toggle');
    this.buildNotesBlocksToggle(this.notesBlocksToggleEl);

    // Status / empty states
    this.statusEl = root.createDiv('semantic-panel-status');

    // Results list
    this.resultsEl = root.createDiv('semantic-panel-results');
    this.resultsEl.setAttribute('role', 'list');

    // Conversation cross-reference section
    this.conversationRefsEl = root.createDiv('semantic-panel-conv-refs');
    this.conversationRefsEl.style.display = 'none';

    // Footer
    this.footerEl = root.createDiv('semantic-panel-footer');
  }

  private buildHeaderBar(container: HTMLElement): void {
    const titleEl = container.createEl('span', { cls: 'semantic-panel-title', text: 'Semantic Panel' });
    titleEl.setAttribute('aria-hidden', 'true');

    const actions = container.createDiv('semantic-panel-header-actions');

    // Search mode toggle
    const searchBtn = actions.createEl('button', { cls: 'semantic-panel-icon-btn' });
    searchBtn.setAttribute('aria-label', this.panelMode === 'search' ? 'Browse mode' : 'Search mode');
    setIcon(searchBtn, 'search');
    this.registerDomEvent(searchBtn, 'click', () => {
      this.setPanelMode(this.panelMode === 'search' ? 'browse' : 'search');
    });

    // Refresh
    const refreshBtn = actions.createEl('button', { cls: 'semantic-panel-icon-btn' });
    refreshBtn.setAttribute('aria-label', 'Refresh');
    setIcon(refreshBtn, 'refresh-cw');
    this.registerDomEvent(refreshBtn, 'click', () => void this.refresh());

    // Settings popover
    const settingsBtn = actions.createEl('button', { cls: 'semantic-panel-icon-btn' });
    settingsBtn.setAttribute('aria-label', 'Panel settings');
    setIcon(settingsBtn, 'settings');
    this.registerDomEvent(settingsBtn, 'click', () => this.showSettingsPopover(settingsBtn));
  }

  private buildModeBar(container: HTMLElement): void {
    container.empty();

    if (this.panelMode === 'browse') {
      const activeLabel = container.createEl('span', { cls: 'semantic-panel-active-note' });
      if (this.activeNotePath) {
        const basename = this.activeNotePath.split('/').pop()?.replace(/\.md$/, '') ?? this.activeNotePath;
        activeLabel.textContent = `Active: ${basename}`;
        activeLabel.setAttribute('title', this.activeNotePath);
      } else {
        activeLabel.textContent = 'No active note';
      }
    } else {
      // Search input
      const inputWrapper = container.createDiv('semantic-panel-search-wrapper');
      this.searchInputEl = inputWrapper.createEl('input', {
        cls: 'semantic-panel-search-input',
        type: 'text',
        placeholder: 'Semantic search…',
      } as unknown as { cls: string; type: string; placeholder: string });
      this.searchInputEl.value = this.searchQuery;
      this.searchInputEl.setAttribute('aria-label', 'Semantic search query');
      this.registerDomEvent(this.searchInputEl, 'input', () => {
        this.searchQuery = this.searchInputEl?.value ?? '';
        if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = setTimeout(() => {
          if (!this.searchQuery.trim()) {
            this.setPanelMode('browse');
          } else {
            void this.refresh();
          }
        }, 300);
      });
      // Focus on switch to search mode
      setTimeout(() => this.searchInputEl?.focus(), 0);
    }
  }

  private buildNotesBlocksToggle(container: HTMLElement): void {
    container.empty();

    const notesBtn = container.createEl('button', {
      cls: `semantic-panel-toggle-btn${this.resultMode === 'notes' ? ' is-active' : ''}`,
      text: 'Notes',
    });
    notesBtn.setAttribute('aria-pressed', String(this.resultMode === 'notes'));
    this.registerDomEvent(notesBtn, 'click', () => {
      if (this.resultMode !== 'notes') {
        this.resultMode = 'notes';
        this.saveSettings();
        this.buildNotesBlocksToggle(container);
        void this.refresh();
      }
    });

    const blocksBtn = container.createEl('button', {
      cls: `semantic-panel-toggle-btn${this.resultMode === 'blocks' ? ' is-active' : ''}`,
      text: 'Blocks',
    });
    blocksBtn.setAttribute('aria-pressed', String(this.resultMode === 'blocks'));
    if (!this.blocksAvailable) {
      blocksBtn.setAttribute('disabled', 'true');
      blocksBtn.setAttribute('aria-disabled', 'true');
      blocksBtn.setAttribute('title', 'Block indexing is disabled or stale');
    }
    this.registerDomEvent(blocksBtn, 'click', () => {
      if (!this.blocksAvailable) return;
      if (this.resultMode !== 'blocks') {
        this.resultMode = 'blocks';
        this.saveSettings();
        this.buildNotesBlocksToggle(container);
        void this.refresh();
      }
    });
  }

  // ---- event wiring ----

  private wireEvents(): void {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (this.panelMode !== 'browse') return;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.onActiveFileChange(), 250);
      })
    );
  }

  // ---- mode switching ----

  private setPanelMode(mode: PanelMode): void {
    this.panelMode = mode;
    if (mode === 'browse') {
      this.searchQuery = '';
      this.searchInputEl = null;
    }
    if (this.modeBarEl) this.buildModeBar(this.modeBarEl);
    if (mode === 'browse') {
      void this.onActiveFileChange();
    }
  }

  // ---- active file tracking ----

  async onActiveFileChange(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? null;
    this.activeNotePath = file?.path ?? null;

    if (this.modeBarEl) this.buildModeBar(this.modeBarEl);

    if (!this.activeNotePath) {
      this.renderEmptyState('no-file');
      return;
    }

    await this.refresh();
  }

  // ---- main refresh ----

  async refresh(): Promise<void> {
    if (!this.noteEmbeddingService) {
      this.renderEmptyState('index-not-ready');
      return;
    }

    // Check block availability
    try {
      const state = await this.noteEmbeddingService.getIndexState();
      this.blocksAvailable = state.blockIndexingEnabled && !state.blockIndexStale;
    } catch {
      this.blocksAvailable = false;
    }

    // Auto-correct mode if blocks became unavailable
    if (this.resultMode === 'blocks' && !this.blocksAvailable) {
      this.resultMode = 'notes';
    }

    if (this.notesBlocksToggleEl) {
      this.buildNotesBlocksToggle(this.notesBlocksToggleEl);
    }

    const requestId = ++this.requestId;
    this.setLoading(true);

    try {
      let results: RowResult[] = [];

      if (this.panelMode === 'browse') {
        if (!this.activeNotePath) {
          this.renderEmptyState('no-file');
          return;
        }
        results = await this.loadBrowseResults(this.activeNotePath, requestId);
      } else {
        const query = this.searchQuery.trim();
        if (!query) {
          this.setPanelMode('browse');
          return;
        }
        results = await this.loadSearchResults(query, requestId);
      }

      if (requestId !== this.requestId) return;

      const filtered = await this.applyFeedback(results);
      if (requestId !== this.requestId) return;

      this.renderResults(filtered, requestId);
      this.setLoading(false);

      if (this.panelMode === 'browse' && this.activeNotePath) {
        void this.refreshConversationRefs(this.activeNotePath, requestId);
      } else {
        if (this.conversationRefsEl) this.conversationRefsEl.style.display = 'none';
      }
    } catch {
      if (requestId !== this.requestId) return;
      this.setLoading(false);
      this.renderEmptyState('error');
    }
  }

  private async loadBrowseResults(notePath: string, requestId: number): Promise<RowResult[]> {
    if (!this.noteEmbeddingService) return [];

    const opts = { limit: this.settings.resultCount, minScore: this.settings.minScore };

    if (this.resultMode === 'blocks') {
      const raw = this.connectionsService
        ? await this.connectionsService.getBlockConnectionsForFile(notePath, opts)
        : await this.noteEmbeddingService.findSimilarBlocks(notePath, opts.limit, opts.minScore);
      if (requestId !== this.requestId) return [];
      return raw.map(b => this.blockToRow(b));
    } else {
      const raw = this.connectionsService
        ? await this.connectionsService.getConnectionsForFile(notePath, opts)
        : await this.noteEmbeddingService.findSimilarNotes(notePath, opts.limit, opts.minScore);
      if (requestId !== this.requestId) return [];
      return raw.map(n => this.noteToRow(n));
    }
  }

  private async loadSearchResults(query: string, requestId: number): Promise<RowResult[]> {
    if (!this.noteEmbeddingService) return [];

    const opts = { limit: this.settings.resultCount, minScore: this.settings.minScore };

    if (this.resultMode === 'blocks') {
      const raw = this.connectionsService
        ? await this.connectionsService.semanticSearchBlocks(query, opts)
        : await this.noteEmbeddingService.semanticSearchBlocks(query, opts.limit, opts.minScore);
      if (requestId !== this.requestId) return [];
      return raw.map(b => this.blockToRow(b));
    } else {
      const raw = this.connectionsService
        ? await this.connectionsService.semanticSearch(query, opts)
        : await this.noteEmbeddingService.semanticSearchNotes(query, opts.limit, opts.minScore);
      if (requestId !== this.requestId) return [];
      return raw.map(n => this.noteToRow(n));
    }
  }

  // ---- result mapping ----

  private noteToRow(n: SimilarNote): RowResult {
    const basename = n.notePath.split('/').pop()?.replace(/\.md$/, '') ?? n.notePath;
    return {
      kind: 'note',
      notePath: n.notePath,
      title: basename,
      score: n.score,
    };
  }

  private blockToRow(b: SimilarBlock): RowResult {
    const basename = b.notePath.split('/').pop()?.replace(/\.md$/, '') ?? b.notePath;
    return {
      kind: 'block',
      notePath: b.notePath,
      title: basename,
      score: b.score,
      heading: b.heading,
      chunkIndex: b.chunkIndex,
      contentPreview: b.contentPreview,
    };
  }

  // ---- feedback filtering ----

  private async applyFeedback(results: RowResult[]): Promise<RowResult[]> {
    if (!this.feedbackService || !this.activeNotePath || this.panelMode !== 'browse') {
      return results;
    }
    try {
      const [pinned, hidden] = await Promise.all([
        this.feedbackService.getPinned(this.activeNotePath),
        this.feedbackService.getHidden(this.activeNotePath),
      ]);

      const visible = results.filter(r => !hidden.has(r.notePath));
      const pinnedResults = visible.filter(r => pinned.has(r.notePath));
      const normalResults = visible.filter(r => !pinned.has(r.notePath));
      return [...pinnedResults, ...normalResults];
    } catch {
      return results;
    }
  }

  // ---- render ----

  private renderResults(results: RowResult[], requestId: number): void {
    if (!this.resultsEl || !this.statusEl || !this.footerEl) return;

    this.statusEl.empty();
    this.resultsEl.empty();
    this.rows = [];

    if (results.length === 0) {
      this.renderEmptyState(this.panelMode === 'browse' ? 'no-results-browse' : 'no-results-search');
      this.footerEl.empty();
      return;
    }

    this.statusEl.style.display = 'none';

    let expandedRow: SemanticResultRow | null = null;

    for (const result of results) {
      const row = new SemanticResultRow({
        app: this.app,
        result,
        sourceNotePath: this.panelMode === 'browse' ? this.activeNotePath : null,
        showScore: this.settings.showScore,
        showFullPath: this.settings.showFullPath,
        feedbackService: this.feedbackService,
        onSendToChat: this.onSendToChat,
        onExpand: () => {
          if (expandedRow && expandedRow !== row) {
            expandedRow.collapse();
          }
          expandedRow = row;
        },
      });

      this.resultsEl.appendChild(row.el);
      this.rows.push(row);
    }

    // Arrow-key navigation between rows
    this.wireRowNavigation();

    // Footer count
    this.footerEl.empty();
    this.footerEl.textContent = `Showing ${results.length} result${results.length === 1 ? '' : 's'}`;

    // Silence unused requestId warning — used by caller for stale check
    void requestId;
  }

  private wireRowNavigation(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      this.registerDomEvent(row.el, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.rows[i + 1]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.rows[i - 1]?.focus();
        }
      });
    }
  }

  // ---- empty / error states ----

  private renderEmptyState(
    reason: 'no-file' | 'index-not-ready' | 'note-not-indexed' | 'block-unavailable' | 'block-stale'
           | 'no-results-browse' | 'no-results-search' | 'error'
  ): void {
    if (!this.statusEl || !this.resultsEl || !this.footerEl) return;

    this.resultsEl.empty();
    this.rows = [];
    this.footerEl.empty();

    this.statusEl.empty();
    this.statusEl.style.display = '';

    const STATE_MESSAGES: Record<string, string> = {
      'no-file': 'Open a markdown note to browse related notes.',
      'index-not-ready': 'Semantic index is not ready yet.',
      'note-not-indexed': 'This note has not been indexed yet.',
      'block-unavailable': 'Block indexing is disabled in Embeddings settings.',
      'block-stale': 'Block index needs rebuild after settings change.',
      'no-results-browse': 'No related notes found for this note.',
      'no-results-search': 'No semantic matches found for this query.',
      'error': 'Could not load semantic results.',
    };

    const msg = this.statusEl.createEl('p', {
      cls: 'semantic-panel-empty-msg',
      text: STATE_MESSAGES[reason] ?? 'Unexpected state.',
    });

    if (reason === 'index-not-ready') {
      const link = msg.createEl('a', { cls: 'semantic-panel-action-link', text: 'Open Embeddings settings' });
      this.registerDomEvent(link, 'click', () => {
        (this.plugin as unknown as { openSettings?(tab?: string): void }).openSettings?.('embeddings');
      });
    } else if (reason === 'note-not-indexed') {
      const btn = this.statusEl.createEl('button', { cls: 'semantic-panel-action-btn', text: 'Index now' });
      this.registerDomEvent(btn, 'click', () => void this.indexCurrentNote());
    } else if (reason === 'block-unavailable' || reason === 'block-stale') {
      const link = msg.createEl('a', { cls: 'semantic-panel-action-link', text: 'Open Embeddings' });
      this.registerDomEvent(link, 'click', () => {
        (this.plugin as unknown as { openSettings?(tab?: string): void }).openSettings?.('embeddings');
      });
      if (reason === 'block-stale') {
        const rebuildBtn = this.statusEl.createEl('button', { cls: 'semantic-panel-action-btn', text: 'Rebuild index' });
        this.registerDomEvent(rebuildBtn, 'click', () => void this.triggerRebuild());
      }
    } else if (reason === 'error') {
      const retryBtn = this.statusEl.createEl('button', { cls: 'semantic-panel-action-btn', text: 'Retry' });
      this.registerDomEvent(retryBtn, 'click', () => void this.refresh());
    }
  }

  // ---- loading state ----

  private setLoading(loading: boolean): void {
    if (!this.resultsEl) return;
    if (loading) {
      this.resultsEl.addClass('is-loading');
    } else {
      this.resultsEl.removeClass('is-loading');
    }
  }

  // ---- conversation cross-reference ----

  private async refreshConversationRefs(notePath: string, requestId: number): Promise<void> {
    if (!this.conversationRefsEl || !this.noteEmbeddingService) return;

    try {
      const refs = await this.noteEmbeddingService.getConversationsReferencingNote(notePath);
      if (requestId !== this.requestId) return;

      this.conversationRefsEl.empty();

      if (!refs || refs.length === 0) {
        this.conversationRefsEl.style.display = 'none';
        return;
      }

      this.conversationRefsEl.style.display = '';
      this.conversationRefsEl.createEl('h4', {
        cls: 'semantic-panel-section-heading',
        text: 'Referenced in conversations',
      });

      const list = this.conversationRefsEl.createDiv('semantic-panel-conv-list');
      list.setAttribute('role', 'list');

      for (const ref of refs) {
        const item = list.createDiv('semantic-panel-conv-item');
        item.setAttribute('role', 'listitem');
        item.setAttribute('tabindex', '0');

        const date = new Date(ref.created);
        const relativeTime = this.formatRelativeTime(date);
        item.createEl('span', { cls: 'semantic-panel-conv-label', text: `Conversation · ${relativeTime}` });

        const openHandler = () => {
          (this.plugin as unknown as { openConversation?(id: string): void }).openConversation?.(ref.conversationId);
        };
        this.registerDomEvent(item, 'click', openHandler);
        this.registerDomEvent(item, 'keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openHandler();
          }
        });
      }
    } catch {
      if (this.conversationRefsEl) this.conversationRefsEl.style.display = 'none';
    }
  }

  private formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    return date.toLocaleDateString();
  }

  // ---- maintenance actions ----

  private async indexCurrentNote(): Promise<void> {
    if (!this.activeNotePath || !this.noteEmbeddingService) return;
    try {
      await this.noteEmbeddingService.embedNote(this.activeNotePath);
      await this.refresh();
    } catch { /* silent */ }
  }

  private async triggerRebuild(): Promise<void> {
    try {
      const em = (this.plugin as unknown as { getEmbeddingManager?(): { getCoordinator?(): { rebuildAll?(): Promise<void> } } }).getEmbeddingManager?.();
      await em?.getCoordinator?.()?.rebuildAll?.();
      await this.refresh();
    } catch { /* silent */ }
  }

  // ---- settings popover ----

  private showSettingsPopover(anchor: HTMLElement): void {
    type MenuItem = { setTitle(t: string): MenuItem; setChecked(c: boolean): MenuItem; onClick(fn: () => void): MenuItem };
    type MenuLike = { addItem(fn: (item: MenuItem) => void): void; showAtMouseEvent(e: MouseEvent): void };
    const menu = new (window as unknown as { Menu: new () => MenuLike }).Menu();

    menu.addItem(item => {
      item.setTitle(`Auto-refresh: ${this.settings.autoRefresh ? 'On' : 'Off'}`)
        .setChecked(this.settings.autoRefresh)
        .onClick(() => {
          this.settings.autoRefresh = !this.settings.autoRefresh;
          this.saveSettings();
        });
    });

    menu.addItem(item => {
      item.setTitle(`Show score: ${this.settings.showScore ? 'On' : 'Off'}`)
        .setChecked(this.settings.showScore)
        .onClick(() => {
          this.settings.showScore = !this.settings.showScore;
          this.saveSettings();
          void this.refresh();
        });
    });

    menu.addItem(item => {
      item.setTitle(`Show full path: ${this.settings.showFullPath ? 'On' : 'Off'}`)
        .setChecked(this.settings.showFullPath)
        .onClick(() => {
          this.settings.showFullPath = !this.settings.showFullPath;
          this.saveSettings();
          void this.refresh();
        });
    });

    menu.addItem(item => {
      item.setTitle('Reset feedback for this note')
        .setChecked(false)
        .onClick(() => {
          if (this.feedbackService && this.activeNotePath) {
            void this.feedbackService.resetAllFeedback(this.activeNotePath!).then(() => this.refresh());
          }
        });
    });

    const rect = anchor.getBoundingClientRect();
    const fakeEvent = { clientX: rect.left, clientY: rect.bottom } as MouseEvent;
    menu.showAtMouseEvent(fakeEvent);
  }

  // ---- public API ----

  /** Called by SemanticPanelUIManager to wire the Send-to-Chat callback after construction. */
  setSendToChatCallback(fn: (payload: SemanticContextPayload) => void): void {
    this.onSendToChat = fn;
    // propagate to already-rendered rows
    for (const row of this.rows) {
      (row as unknown as { opts: { onSendToChat: typeof fn } }).opts.onSendToChat = fn;
    }
  }
}
