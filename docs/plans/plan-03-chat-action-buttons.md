# Plan 03 — Chat Action Buttons & Clipboard
Last Updated: 2026-03-29
Status: ✅ COMPLETE (commit 21c260f3 + cleanup, local-fixes branch)

## Goal
Allow the user to act on individual chat messages without copy-pasting manually:
1. Standard text selection, cut, and copy within chat dialog bubbles
2. Action buttons on each AI message bubble to insert content into the active editor

---

## Feature Specification

### 3A — Text Selection in Chat
Chat messages currently render in `div` elements. Text selection should already work natively in most cases. If it does not, the likely cause is a `user-select: none` rule or a `pointer-events: none` on the message container.

**Fix**: Ensure `.nexus-message-content` and its children have `user-select: text` in CSS. No TypeScript changes needed.

### 3B — Action Buttons on AI Messages

Each AI message bubble gets a persistent action toolbar at the bottom of the bubble. Buttons are always visible but faded (low opacity), and solidify to full opacity on hover of the bubble or the bar itself:

```
┌──────────────────────────────────────────────────────┐
│ AI response text…                                    │
│                                                      │
│  [↓cursor]  [↓file]  [file+]  [🔗]  [copy]          │  ← always visible, faded
└──────────────────────────────────────────────────────┘
                        ↑ hover → full opacity
```

The bar sits at the bottom of the bubble (not the top-right), horizontally left-aligned, with small icon-only buttons. It is rendered at reduced opacity (`0.35`) at rest and transitions to full opacity (`1.0`) when the bubble is hovered. This makes the feature discoverable without cluttering the reading experience.

A row of icon buttons at the bottom of the bubble:

| Icon | Label | Action |
|------|-------|--------|
| `arrow-down-to-line` | Insert at cursor | Insert message text at active editor cursor position |
| `arrow-down` | Append to file | Append message text to end of active editor file |
| `file-plus` | Create new file | Open filename prompt → create file with message content |
| `link` | Create backlink | Create backlink in new/target file → active file, append link in active file |
| `copy` | Copy | Copy full message text to clipboard |

---

## Implementation Plan

### Phase 1 — CSS: user-select fix + action bar base styles

```css
.nexus-message-content,
.nexus-message-content * {
    user-select: text;
    -webkit-user-select: text;
}

/* Action bar — always visible but faded, solidifies on hover */
.nexus-message-action-bar {
    display: flex;
    flex-direction: row;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    opacity: 0.35;
    transition: opacity 0.15s ease;
}

.message-bubble:hover .nexus-message-action-bar,
.nexus-message-action-bar:hover {
    opacity: 1;
}

.nexus-message-action-bar .message-action-btn {
    padding: 2px 4px;
    color: var(--text-muted);
}

.nexus-message-action-bar .message-action-btn:hover {
    color: var(--text-normal);
}
```

### Phase 2 — Action Toolbar Component

New file: `src/ui/chat/components/MessageActionBar.ts`

```typescript
export interface MessageActionCallbacks {
  onInsertAtCursor: (text: string) => void;
  onAppendToFile: (text: string) => void;
  onCreateNewFile: (text: string) => void;
  onCreateBacklink: (text: string) => void;
  onCopy: (text: string) => void;
}

export class MessageActionBar {
  createElement(text: string, callbacks: MessageActionCallbacks): HTMLElement { ... }
}
```

The bar is a `div.nexus-message-action-bar` appended inside the message bubble as a bottom strip. It is **always rendered** but starts at reduced opacity (`0.35`). The containing bubble gets `.nexus-has-action-bar` so the CSS hover rule can target it:

```css
/* Always visible, faded */
.nexus-message-action-bar {
    opacity: 0.35;
    transition: opacity 0.15s ease;
}

/* Solidify on bubble hover OR direct bar hover */
.message-bubble:hover .nexus-message-action-bar,
.nexus-message-action-bar:hover {
    opacity: 1;
}
```

No JS hover listeners needed — pure CSS opacity transition. Use `setIcon(btn, 'icon-name')` for all icons (Obsidian API, no raw SVG). Each button gets an `aria-label` for accessibility.

### Phase 3 — Editor Integration Service

New file: `src/ui/chat/services/EditorInsertService.ts`

Wraps all editor interactions:

```typescript
export class EditorInsertService {
  constructor(private app: App) {}

  // Insert at current cursor position in the active markdown editor
  insertAtCursor(text: string): boolean {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return false;
    const cursor = editor.getCursor();
    editor.replaceRange(text, cursor);
    return true;
  }

  // Append to end of active file (after last line)
  async appendToActiveFile(text: string): Promise<boolean> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return false;
    await this.app.vault.process(file, (content) => {
      const sep = content.endsWith('\n') ? '' : '\n';
      return content + sep + text;
    });
    return true;
  }

  // Create a new file with text as content
  async createNewFile(
    text: string,
    filename: string,
    folder: string,
    activeFilePath?: string
  ): Promise<TFile | null> {
    const normalizedFolder = normalizePath(folder);
    const fullPath = normalizePath(`${normalizedFolder}/${filename}.md`);

    // Ensure folder exists
    if (!this.app.vault.getAbstractFileByPath(normalizedFolder)) {
      await this.app.vault.createFolder(normalizedFolder);
    }

    // Build content — include backlink to active file if provided
    let content = text;
    if (activeFilePath) {
      const activeBasename = activeFilePath.replace(/\.md$/, '');
      const activeName = activeBasename.split('/').pop() ?? activeBasename;
      content += `\n\n---\nLinked from: [[${activeName}]]`;
    }

    const newFile = await this.app.vault.create(fullPath, content);

    // Append link to new file in active file
    if (activeFilePath) {
      const activeFile = this.app.vault.getFileByPath(activeFilePath);
      if (activeFile) {
        const newBasename = filename;
        await this.app.vault.process(activeFile, (c) => {
          return c + `\n\n[[${newBasename}]]`;
        });
      }
    }

    return newFile;
  }

  // Create backlink: add link in active file → targetFile, add backlink in targetFile → active file
  async createBacklink(targetFilePath: string, activeFilePath: string): Promise<void> { ... }
}
```

### Phase 4 — New File Prompt Modal

New file: `src/ui/chat/modals/CreateFileModal.ts`

Extends Obsidian `Modal`. Fields:
- **Filename** (text input, required)
- **Location** (text input, pre-filled with default from settings — see Phase 5)
- A "Browse" button to pick folder from vault tree
- Checkbox: "Create backlink to current file" (default: checked)

On confirm: calls `EditorInsertService.createNewFile(...)`.

### Phase 5 — Default Location Setting

Add to `PluginTypes.ts` / settings:
```typescript
defaultNewFileLocation: string; // default: "01-Inbox"
```

Add to `DefaultsTab` settings: a text field labeled "Default folder for new files from chat" with a folder picker. This setting is used by `CreateFileModal` as the pre-filled folder.

### Phase 6 — Wire into MessageBubble

In the message bubble render code (locate in `src/ui/chat/components/MessageBubble.ts` or `MessageRenderer`):
- After rendering AI message content, instantiate `MessageActionBar`
- Pass `EditorInsertService` callbacks
- Attach the bar element to the bubble

Only show action bar on **assistant** messages (not user messages).

---

## Files to Change

| File | Change |
|------|--------|
| `styles.css` | `user-select: text` for message content; action bar hover styles |
| `src/ui/chat/components/MessageActionBar.ts` | New — action button row component |
| `src/ui/chat/services/EditorInsertService.ts` | New — editor/vault interaction service |
| `src/ui/chat/modals/CreateFileModal.ts` | New — new file prompt modal |
| `src/ui/chat/components/MessageBubble.ts` | Wire in action bar |
| `src/types/plugin/PluginTypes.ts` | Add `defaultNewFileLocation` setting |
| `src/settings/tabs/DefaultsTab.ts` | Add default folder picker |

## Dependencies
- Plan 01 (layout fixes) should be complete first
- No dependency on Plans 02, 04, or 05

## Estimated Complexity
Medium. The editor API interactions are straightforward (`replaceRange`, `vault.process`). The `CreateFileModal` and settings wiring are the most work. Risk is low — all changes are additive.
