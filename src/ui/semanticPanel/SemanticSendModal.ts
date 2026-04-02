/**
 * Location: src/ui/semanticPanel/SemanticSendModal.ts
 * Purpose: Choice dialog for Send to Chat — add semantic context to the active
 * Nexus chat conversation or spawn a new one.
 */

import { App, Modal } from 'obsidian';
import type { SemanticContextPayload } from './SemanticPanelView';

export class SemanticSendModal extends Modal {
  constructor(
    app: App,
    private payload: SemanticContextPayload,
    private chatTitle: string,
    private onAddToCurrent: (payload: SemanticContextPayload) => void,
    private onNewChat: (payload: SemanticContextPayload) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('nexus-semantic-send-modal');

    contentEl.createEl('h2', { text: 'Send to chat' });
    contentEl.createEl('p', {
      text: `Add "${this.payload.title}" as context for an AI conversation.`,
      cls: 'nexus-semantic-send-desc'
    });

    const buttonContainer = contentEl.createDiv('modal-button-container');

    const currentBtn = buttonContainer.createEl('button', {
      text: `Add to "${this.chatTitle}"`,
      cls: 'mod-cta'
    });
    currentBtn.addEventListener('click', () => {
      this.close();
      this.onAddToCurrent(this.payload);
    });

    const newChatBtn = buttonContainer.createEl('button', {
      text: 'New chat'
    });
    newChatBtn.addEventListener('click', () => {
      this.close();
      this.onNewChat(this.payload);
    });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'mod-cancel'
    });
    cancelBtn.addEventListener('click', () => this.close());

    requestAnimationFrame(() => currentBtn.focus());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
