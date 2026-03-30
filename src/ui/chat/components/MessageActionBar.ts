/**
 * MessageActionBar - Action buttons for assistant message bubbles
 * Location: /src/ui/chat/components/MessageActionBar.ts
 *
 * Adds insert/append/create-file/copy buttons directly into the existing
 * message-actions-external pill container alongside the copy button.
 * Visibility is controlled by the existing CSS hover rules on that container.
 *
 * getText is called at click time so buttons always use the latest message
 * content even when the bar was created during streaming.
 */

import { App, Component, Notice, setIcon } from 'obsidian';
import { EditorInsertService } from '../services/EditorInsertService';
import { CreateFileModal } from '../modals/CreateFileModal';

export class MessageActionBar {
  /**
   * Append action buttons into an existing actions container (message-actions-external).
   * A thin separator is prepended to visually group them from the copy button.
   */
  static addToContainer(
    container: HTMLElement,
    getText: () => string,
    app: App,
    component: Component
  ): void {
    const editorService = new EditorInsertService(app);

    // Thin separator between existing copy button and new action buttons
    const sep = container.createDiv('nexus-action-separator');

    const buttons: Array<{ icon: string; label: string; onClick: () => void }> = [
      {
        icon: 'arrow-down-to-line',
        label: 'Insert at cursor',
        onClick: () => {
          const ok = editorService.insertAtCursor(getText());
          if (!ok) new Notice('No active editor — open a note first');
        }
      },
      {
        icon: 'arrow-down',
        label: 'Append to file',
        onClick: async () => {
          const ok = await editorService.appendToActiveFile(getText());
          if (!ok) new Notice('No active file — open a note first');
        }
      },
      {
        icon: 'file-plus',
        label: 'Create new file',
        onClick: () => {
          new CreateFileModal(app, getText(), editorService).open();
        }
      }
    ];

    for (const { icon, label, onClick } of buttons) {
      const btn = container.createEl('button', {
        cls: 'message-action-btn clickable-icon',
        attr: { 'aria-label': label, title: label }
      });
      setIcon(btn, icon);
      component.registerDomEvent(btn, 'click', onClick);
    }
  }
}
