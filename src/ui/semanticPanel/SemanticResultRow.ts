/**
 * Location: src/ui/semanticPanel/SemanticResultRow.ts
 * Purpose: Renders a single result row in the semantic panel (note or block result).
 *
 * Each row has:
 * - header (disclosure icon, title, score badge, context menu trigger)
 * - optional expandable preview region (lazy-loaded on first expand)
 * - action bar (Send to Chat, Open, Insert Link)
 *
 * Keyboard:
 * - Arrow keys navigate rows (managed by parent)
 * - Enter expands/collapses
 * - Cmd/Ctrl+Enter opens note
 *
 * Drag-to-link: draggable when note file exists.
 * Feedback: context menu for pin/hide.
 */

import { App, Menu, setIcon, TFile } from 'obsidian';
import type { SimilarNote, SimilarBlock } from '../../services/embeddings/NoteEmbeddingService';
import type { SemanticContextPayload } from './SemanticPanelView';
import type { SemanticFeedbackService } from './SemanticFeedbackService';

export interface RowResult {
  kind: 'note' | 'block';
  notePath: string;
  title: string;
  score: number;
  heading?: string | null;
  chunkIndex?: number;
  contentPreview?: string;
}

export interface SemanticResultRowOptions {
  app: App;
  result: RowResult;
  sourceNotePath: string | null; // null in search mode
  showScore: boolean;
  showFullPath: boolean;
  feedbackService: SemanticFeedbackService | null;
  onSendToChat: ((payload: SemanticContextPayload) => void) | null;
  onExpand?: () => void; // called when this row expands (for single-expand enforcement)
  onRefresh?: () => void; // called after pin/hide so the panel re-runs the feedback pipeline
  isPinned?: boolean;
  onSelectionChange: ((path: string, selected: boolean) => void) | null;
}

export class SemanticResultRow {
  readonly el: HTMLElement;
  private expanded = false;
  private previewEl: HTMLElement | null = null;
  private previewLoaded = false;
  private actionBar: HTMLElement | null = null;
  private checkboxEl: HTMLInputElement | null = null;

  constructor(private opts: SemanticResultRowOptions) {
    this.el = document.createElement('div');
    this.el.className = 'semantic-result-row';
    this.el.setAttribute('tabindex', '0');
    this.el.setAttribute('aria-expanded', 'false');
    this.el.setAttribute('role', 'listitem');
    this.build();
  }

  private build(): void {
    this.buildHeader();
    this.buildPreviewRegion();
    this.buildActionBar();
    this.wireDragToLink();
    this.wireKeyboard();
  }

  private buildHeader(): void {
    const header = this.el.createDiv('semantic-result-header');

    // Checkbox for multi-select (hidden until hover or selection active)
    if (this.opts.onSelectionChange) {
      this.checkboxEl = header.createEl('input', { cls: 'semantic-result-checkbox' });
      this.checkboxEl.type = 'checkbox';
      this.checkboxEl.setAttribute('aria-label', 'Select for bulk link');
      this.checkboxEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onSelectionChange?.(this.opts.result.notePath, (e.currentTarget as HTMLInputElement).checked);
      });
    }

    // Disclosure chevron
    const chevron = header.createEl('span', { cls: 'semantic-result-chevron' });
    setIcon(chevron, 'chevron-right');

    // Pin indicator (shown when result is pinned)
    if (this.opts.isPinned) {
      const pinEl = header.createEl('span', { cls: 'semantic-result-pin-indicator' });
      setIcon(pinEl, 'pin');
    }

    // Title
    const titleEl = header.createEl('span', { cls: 'semantic-result-title' });
    titleEl.textContent = this.opts.result.title;

    // Subtitle (heading for blocks, path if showFullPath)
    if (this.opts.result.kind === 'block' && this.opts.result.heading) {
      const subtitleEl = header.createEl('span', { cls: 'semantic-result-subtitle' });
      subtitleEl.textContent = this.opts.result.heading;
    } else if (this.opts.showFullPath) {
      const subtitleEl = header.createEl('span', { cls: 'semantic-result-subtitle' });
      subtitleEl.textContent = this.opts.result.notePath;
    }

    // Score badge
    if (this.opts.showScore) {
      const scoreEl = header.createEl('span', { cls: 'semantic-result-score' });
      scoreEl.textContent = `${Math.round(this.opts.result.score * 100)}%`;
    }

    // Add to chat context button (only when a chat callback is wired)
    if (this.opts.onSendToChat) {
      const chatBtn = header.createEl('button', { cls: 'semantic-result-menu-btn' });
      chatBtn.setAttribute('aria-label', 'Add to chat context');
      setIcon(chatBtn, 'send');
      chatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.sendToChat();
      });
    }

    // Context menu button
    const menuBtn = header.createEl('button', { cls: 'semantic-result-menu-btn' });
    menuBtn.setAttribute('aria-label', 'Result options');
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showContextMenu(menuBtn);
    });

    // Click on header to expand/collapse
    header.addEventListener('click', () => this.toggle());
  }

  private buildPreviewRegion(): void {
    this.previewEl = this.el.createDiv('semantic-result-preview');
    this.previewEl.style.display = 'none';
  }

  private buildActionBar(): void {
    this.actionBar = this.el.createDiv('semantic-result-actions');
    this.actionBar.style.display = 'none';

    // Send to Chat
    if (this.opts.onSendToChat) {
      const sendBtn = this.actionBar.createEl('button', {
        cls: 'semantic-action-btn',
        text: 'Send to Chat'
      });
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.sendToChat();
      });
    }

    // Open
    const openBtn = this.actionBar.createEl('button', {
      cls: 'semantic-action-btn',
      text: 'Open'
    });
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openNote();
    });

    // Insert Link
    const linkBtn = this.actionBar.createEl('button', {
      cls: 'semantic-action-btn',
      text: 'Insert Link'
    });
    linkBtn.setAttribute('title', 'Insert [[wikilink]] at cursor');
    linkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.insertLink();
    });
  }

  private wireDragToLink(): void {
    const file = this.opts.app.vault.getFileByPath(this.opts.result.notePath);
    if (!file) return;

    this.el.setAttribute('draggable', 'true');
    this.el.addEventListener('dragstart', (e: DragEvent) => {
      const f = this.opts.app.vault.getFileByPath(this.opts.result.notePath);
      if (f && e.dataTransfer) {
        // Use Obsidian's drag manager for proper note drag behavior
        const dm = (this.opts.app as unknown as { dragManager?: { dragFile(e: DragEvent, f: TFile): void } }).dragManager;
        if (dm) dm.dragFile(e, f);
      }
    });
  }

  private wireKeyboard(): void {
    this.el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (e.metaKey || e.ctrlKey) {
          this.openNote();
        } else {
          this.toggle();
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Expand / collapse
  // ---------------------------------------------------------------------------

  toggle(): void {
    if (this.expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  expand(): void {
    if (this.expanded) return;
    this.expanded = true;
    this.el.setAttribute('aria-expanded', 'true');
    this.el.addClass('is-expanded');

    // Update chevron
    const chevron = this.el.querySelector('.semantic-result-chevron');
    if (chevron) setIcon(chevron as HTMLElement, 'chevron-down');

    if (this.previewEl) this.previewEl.style.display = '';
    if (this.actionBar) this.actionBar.style.display = '';

    if (!this.previewLoaded) {
      this.loadPreview();
    }

    this.opts.onExpand?.();
  }

  collapse(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.el.setAttribute('aria-expanded', 'false');
    this.el.removeClass('is-expanded');

    const chevron = this.el.querySelector('.semantic-result-chevron');
    if (chevron) setIcon(chevron as HTMLElement, 'chevron-right');

    if (this.previewEl) this.previewEl.style.display = 'none';
    if (this.actionBar) this.actionBar.style.display = 'none';
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  // ---------------------------------------------------------------------------
  // Preview loading (lazy)
  // ---------------------------------------------------------------------------

  private async loadPreview(): Promise<void> {
    if (!this.previewEl) return;
    this.previewLoaded = true;

    const preview = this.opts.result.contentPreview ?? '';
    if (preview) {
      this.previewEl.textContent = preview.length > 2000
        ? preview.slice(0, 2000) + '…'
        : preview;
      return;
    }

    // Fallback: read opening excerpt from the file
    try {
      const file = this.opts.app.vault.getFileByPath(this.opts.result.notePath);
      if (!file) return;
      const content = await this.opts.app.vault.cachedRead(file);
      // Strip frontmatter and show a generous excerpt (scrollable in the panel)
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
      const truncated = body.length > 3000 ? body.slice(0, 3000) + '…' : body;
      this.previewEl.textContent = truncated;
    } catch {
      this.previewEl.textContent = 'Preview unavailable.';
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async sendToChat(): Promise<void> {
    if (!this.opts.onSendToChat) return;

    const result = this.opts.result;
    let content = result.contentPreview ?? '';

    if (result.kind === 'note') {
      try {
        const file = this.opts.app.vault.getFileByPath(result.notePath);
        if (file) {
          const raw = await this.opts.app.vault.cachedRead(file);
          content = raw.slice(0, 32000); // 32K cap from Plan 05 spec
        }
      } catch { /* use preview as fallback */ }
      this.opts.onSendToChat({
        kind: 'semantic-note',
        path: result.notePath,
        title: result.title,
        score: result.score,
        content,
      });
    } else {
      this.opts.onSendToChat({
        kind: 'semantic-block',
        path: result.notePath,
        title: result.title,
        heading: result.heading ?? undefined,
        chunkIndex: result.chunkIndex ?? 0,
        score: result.score,
        excerpt: content,
      });
    }
  }

  private openNote(): void {
    const file = this.opts.app.vault.getFileByPath(this.opts.result.notePath);
    if (!file) return;
    // Open in a new leaf to the right so the source note stays visible.
    this.opts.app.workspace.getLeaf(true).openFile(file);
  }

  private async insertLink(): Promise<void> {
    const notePath = this.opts.result.notePath;
    // Derive display name (basename without extension)
    const basename = notePath.split('/').pop()?.replace(/\.md$/, '') ?? notePath;
    const wikilink = `[[${basename}]]`;

    // Append to the end of the source note (the one whose results are showing).
    // We target the specific source note editor rather than the first editor found,
    // so having multiple notes open doesn't route the link to the wrong file.
    type EditorLike = {
      lastLine(): number;
      getLine(n: number): string;
      replaceRange(text: string, from: { line: number; ch: number }): void;
    };

    const appendToEditor = (editor: EditorLike): void => {
      const lastLine = editor.lastLine();
      const lastCh = editor.getLine(lastLine).length;
      const separator = lastCh > 0 ? '\n' : '';
      editor.replaceRange(separator + wikilink, { line: lastLine, ch: lastCh });
    };

    // Pass 1: find the leaf that matches the source note path specifically.
    let inserted = false;
    if (this.opts.sourceNotePath) {
      this.opts.app.workspace.iterateAllLeaves((leaf) => {
        if (inserted) return;
        const view = leaf.view as unknown as { file?: { path?: string }; editor?: EditorLike };
        if (view?.file?.path === this.opts.sourceNotePath && view?.editor) {
          appendToEditor(view.editor);
          inserted = true;
        }
      });
    }

    // Pass 2: fall back to first editor (search mode or source leaf not found).
    if (!inserted) {
      this.opts.app.workspace.iterateAllLeaves((leaf) => {
        if (inserted) return;
        const view = leaf.view as unknown as { editor?: EditorLike };
        if (view?.editor) {
          appendToEditor(view.editor);
          inserted = true;
        }
      });
    }
  }

  private showContextMenu(anchor: HTMLElement): void {
    const menu = new Menu();

    menu.addItem(item => {
      item.setTitle('Pin result').setIcon('pin').onClick(async () => {
        if (!this.opts.sourceNotePath || !this.opts.feedbackService) return;
        await this.opts.feedbackService.setFeedback(
          this.opts.sourceNotePath,
          this.opts.result.notePath,
          'pinned'
        );
        this.opts.onRefresh?.();
      });
    });

    menu.addItem(item => {
      item.setTitle('Hide result').setIcon('eye-off').onClick(async () => {
        if (!this.opts.sourceNotePath || !this.opts.feedbackService) return;
        await this.opts.feedbackService.setFeedback(
          this.opts.sourceNotePath!,
          this.opts.result.notePath,
          'hidden'
        );
        this.opts.onRefresh?.();
      });
    });

    // Trigger menu near the anchor button
    const rect = anchor.getBoundingClientRect();
    const fakeEvent = { clientX: rect.left, clientY: rect.bottom } as MouseEvent;
    menu.showAtMouseEvent(fakeEvent);
  }

  focus(): void {
    this.el.focus();
  }

  setSelected(selected: boolean): void {
    if (this.checkboxEl) this.checkboxEl.checked = selected;
  }

  get result(): RowResult {
    return this.opts.result;
  }
}
