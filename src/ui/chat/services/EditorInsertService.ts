/**
 * EditorInsertService - Wraps editor and vault interactions for chat action buttons
 * Location: /src/ui/chat/services/EditorInsertService.ts
 */

import { App, MarkdownView, normalizePath, TFile } from 'obsidian';

export class EditorInsertService {
  constructor(private app: App) {}

  /**
   * Insert text at the current cursor position in the active markdown editor.
   * When the chat side panel is focused, activeEditor is the chat view (not a
   * markdown editor), so we fall back to the most recently active MarkdownView leaf.
   * Returns false if no markdown editor is open.
   */
  insertAtCursor(text: string): boolean {
    // Primary: works when a markdown note is directly focused
    let editor = this.app.workspace.activeEditor?.editor;

    if (!editor) {
      // Fallback: focus is on a side panel — find any open markdown note
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!editor && leaf.view instanceof MarkdownView) {
          editor = leaf.view.editor;
        }
      });
    }

    if (!editor) return false;
    const cursor = editor.getCursor();
    editor.replaceRange(text, cursor);
    return true;
  }

  /**
   * Append text to the end of the active file.
   * Returns false if no file is active.
   */
  async appendToActiveFile(text: string): Promise<boolean> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return false;
    await this.app.vault.process(file, (content) => {
      const sep = content.endsWith('\n') ? '' : '\n';
      return content + sep + text;
    });
    return true;
  }

  /**
   * Create a new markdown file with the given text as content.
   * If createBacklink is true, adds a backlink footer to the new file and
   * appends a wikilink to the new file in the active file.
   */
  async createNewFile(
    text: string,
    filename: string,
    folder: string,
    createBacklink: boolean
  ): Promise<TFile | null> {
    const normalizedFolder = normalizePath(folder);
    const fullPath = normalizePath(`${normalizedFolder}/${filename}.md`);

    if (!this.app.vault.getAbstractFileByPath(normalizedFolder)) {
      await this.app.vault.createFolder(normalizedFolder);
    }

    const activeFile = this.app.workspace.getActiveFile();
    let content = text;

    if (createBacklink && activeFile) {
      content += `\n\n---\nLinked from: [[${activeFile.basename}]]`;
    }

    const newFile = await this.app.vault.create(fullPath, content);

    if (createBacklink && activeFile) {
      await this.app.vault.process(activeFile, (c) => {
        const sep = c.endsWith('\n') ? '' : '\n';
        return c + sep + `\n[[${filename}]]`;
      });
    }

    return newFile;
  }
}
