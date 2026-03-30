/**
 * CreateFileModal - Prompt for creating a new vault file from a chat message
 * Location: /src/ui/chat/modals/CreateFileModal.ts
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { EditorInsertService } from '../services/EditorInsertService';
import { getNexusPlugin } from '../../../utils/pluginLocator';

export class CreateFileModal extends Modal {
  private filename = '';
  private folder = '';
  private createBacklink = true;

  constructor(
    app: App,
    private text: string,
    private editorService: EditorInsertService
  ) {
    super(app);
    // Pre-fill folder from settings, falling back to a sensible default
    const plugin = getNexusPlugin<any>(app);
    this.folder = plugin?.settings?.settings?.defaultNewFileLocation ?? '01-Inbox';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('nexus-create-file-modal');

    contentEl.createEl('h2', { text: 'Create new file' });

    new Setting(contentEl)
      .setName('Filename')
      .addText((text) => {
        text.setPlaceholder('e.g., Meeting notes');
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
        });
        text.onChange((value) => { this.filename = value; });
      });

    new Setting(contentEl)
      .setName('Location')
      .setDesc('Folder path within your vault')
      .addText((text) => {
        text.setValue(this.folder);
        text.setPlaceholder('e.g., 01-Inbox');
        text.onChange((value) => { this.folder = value; });
      });

    new Setting(contentEl)
      .setName('Create backlink')
      .setDesc('Add a link to this file in the active note, and a backlink in the new file')
      .addToggle((toggle) => {
        toggle.setValue(this.createBacklink);
        toggle.onChange((value) => { this.createBacklink = value; });
      });

    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('modal-button-container-flex');

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel', cls: 'mod-cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
    createBtn.addEventListener('click', () => this.submit());

    // Focus filename input
    requestAnimationFrame(() => {
      const input = contentEl.querySelector<HTMLInputElement>('input');
      if (input) input.focus();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const filename = this.filename.trim();
    if (!filename) {
      new Notice('Please enter a filename');
      return;
    }

    this.close();

    try {
      const file = await this.editorService.createNewFile(
        this.text,
        filename,
        this.folder || '01-Inbox',
        this.createBacklink
      );
      if (file) {
        new Notice(`Created: ${file.path}`);
        await this.app.workspace.openLinkText(file.path, '', false);
      }
    } catch (err) {
      new Notice(`Failed to create file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
