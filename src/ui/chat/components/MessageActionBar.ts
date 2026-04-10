/**
 * MessageActionBar - Populates the existing message-actions-external pill
 * Location: /src/ui/chat/components/MessageActionBar.ts
 *
 * Renders four action buttons into the caller-supplied container element
 * (the existing .message-actions-external pill that sits in the upper-right
 * corner of each message bubble). Buttons appear alongside any other pill
 * contents (e.g. branch navigator) and use the same message-action-btn
 * styling as the original copy button did.
 *
 * Only rendered for completed assistant messages with non-empty text content.
 * Called by MessageBubble.appendActionBar() after message state transitions
 * to complete.
 *
 * Selection-aware: if the user has text selected within the bubble's
 * .message-content element, all four buttons operate on that selection
 * instead of the full message text. Falls back to full content when nothing
 * is selected or the selection is outside this bubble.
 */

import { App, Component, MarkdownView, Notice, setIcon } from 'obsidian';
import { CreateFileModal } from './CreateFileModal';

export class MessageActionBar extends Component {
  private buttons: HTMLElement[] = [];
  private copyButton: HTMLElement | null = null;

  constructor(
    private readonly content: string,
    private readonly app: App,
    private readonly contentEl: HTMLElement | null = null
  ) {
    super();
  }

  /**
   * Create the four action buttons inside the provided container element.
   * The container is the existing .message-actions-external pill — no new
   * wrapper is created. Call removeFromContainer() before unload to clean up.
   */
  renderInto(container: HTMLElement): void {
    this.copyButton = this.addButton(container, 'copy', 'Copy message', () => this.handleCopy());
    this.registerDomEvent(this.copyButton, 'mousedown', (e: MouseEvent) => e.preventDefault());

    // mousedown:preventDefault on all buttons so clicking does not shift focus
    // away from either the active note (preserves cursor) or the bubble
    // (preserves the text selection we need to read in the click handler).
    const insertBtn = this.addButton(container, 'file-input', 'Insert at cursor', () => this.handleInsert());
    this.registerDomEvent(insertBtn, 'mousedown', (e: MouseEvent) => e.preventDefault());

    const appendBtn = this.addButton(container, 'file-plus-2', 'Append to active note', () => { void this.handleAppend(); });
    this.registerDomEvent(appendBtn, 'mousedown', (e: MouseEvent) => e.preventDefault());

    const createBtn = this.addButton(container, 'file-plus', 'Create new file', () => this.handleCreate());
    this.registerDomEvent(createBtn, 'mousedown', (e: MouseEvent) => e.preventDefault());
  }

  /**
   * Remove all buttons this component added from their parent container.
   * Call before unload() to keep the DOM clean.
   */
  removeFromContainer(): void {
    this.buttons.forEach(btn => btn.remove());
    this.buttons = [];
    this.copyButton = null;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private addButton(
    parent: HTMLElement,
    icon: string,
    title: string,
    handler: () => void
  ): HTMLElement {
    const btn = parent.createEl('button', {
      cls: 'message-action-btn clickable-icon',
      attr: { title, 'aria-label': title }
    });
    setIcon(btn, icon);
    this.registerDomEvent(btn, 'click', handler);
    this.buttons.push(btn);
    return btn;
  }

  /**
   * Returns the text to act on: the current bubble selection if one exists
   * entirely within this bubble's content element, otherwise the full message.
   *
   * Must be called as the first statement in every handler — focus changes and
   * awaits clear the selection before we can read it.
   */
  private getEffectiveContent(): string {
    if (this.contentEl) {
      const selection = window.getSelection();
      if (selection && selection.toString().trim()) {
        const inside =
          this.contentEl.contains(selection.anchorNode) &&
          this.contentEl.contains(selection.focusNode);
        if (inside) {
          return selection.toString();
        }
      }
    }
    return this.content;
  }

  private handleCopy(): void {
    const text = this.getEffectiveContent();
    navigator.clipboard.writeText(text).then(() => {
      if (this.copyButton) this.showCopyFeedback(this.copyButton);
    }).catch(err => {
      console.error('[MessageActionBar] Copy failed:', err);
      new Notice('Copy failed.');
    });
  }

  private showCopyFeedback(button: HTMLElement): void {
    setIcon(button, 'check');
    button.classList.add('copy-success');
    setTimeout(() => {
      setIcon(button, 'copy');
      button.classList.remove('copy-success');
    }, 1500);
  }

  /**
   * Returns the active MarkdownView, or falls back to the most recently
   * opened markdown leaf if the chat panel currently has workspace focus.
   */
  private getMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    // Chat panel has focus — find any open note tab
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (leaves.length === 0) return null;
    return leaves[leaves.length - 1].view as MarkdownView;
  }

  private handleInsert(): void {
    // Capture before editor.focus() — focus clears the bubble selection.
    const text = this.getEffectiveContent();
    const view = this.getMarkdownView();
    if (!view) {
      new Notice('No active note — open a note and place your cursor first.');
      return;
    }
    view.editor.focus();
    view.editor.replaceSelection(text);
  }

  private async handleAppend(): Promise<void> {
    // Capture before first await — selection is only readable synchronously.
    const text = this.getEffectiveContent();
    const view = this.getMarkdownView();
    if (!view?.file) {
      new Notice('No active note — open a note first.');
      return;
    }

    const timestamp = new Date().toLocaleString();
    const separator = `\n\n---\n*Appended from Nexus Chat — ${timestamp}*\n\n`;

    await this.app.vault.process(view.file, (fileContent) => {
      return fileContent + separator + text;
    });

    new Notice('Appended to note.');
  }

  private handleCreate(): void {
    const text = this.getEffectiveContent();
    new CreateFileModal(this.app, text).open();
  }
}
